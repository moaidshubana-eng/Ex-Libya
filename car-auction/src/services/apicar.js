// جلب بيانات سيارة من مزادات Copart/IAAI بالـVIN عبر مزوّد خارجي (apicar.store).
// المفتاح من متغير البيئة APICAR_KEY فقط — لا يُكتب في الكود ولا يُرسل للمتصفح.
// تُستعمل في بوابة العملاء: لو الـVIN مش مسجّل عندنا، نجيب بياناته من المزاد للعرض فقط.
import { config } from '../config.js';
import { HttpError } from '../security/middleware.js';

const TTL_MS = 6 * 3600_000;           // ساعات: بيانات اللوت لا تتغير كثيرًا، فنخفّف الطلبات (والتكلفة)
const NEG_TTL_MS = 30 * 60_000;        // «غير موجود» يُخزَّن أقصر، فلو أُضيف لاحقًا يظهر
const cache = new Map();               // vin -> { at, data }
const img = new Map();                 // `${vin}|${i}` -> { at, buf, mime }

export const apicarEnabled = () => !!config.apicar.key;

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && !/^(null|n\/a|none|-)$/i.test(s) ? s : null;
};

/** رد apicar الخام → شكل موحّد للعرض (بلا حقول داخلية) */
export function mapApicar(raw) {
  if (!raw) return null;
  const images = (Array.isArray(raw.images) ? raw.images : Array.isArray(raw.link_img_hd) ? raw.link_img_hd : []).filter(Boolean).slice(0, 40);
  const damage = [clean(raw.damage_first), clean(raw.damage_second)].filter(Boolean).join(' / ') || null;
  return {
    source: 'auction', vin: clean(raw.vin), auction: /iaa/i.test(raw.auction || '') ? 'IAAI' : /copart/i.test(raw.auction || '') ? 'COPART' : clean(raw.auction),
    lotId: clean(raw.lot_id), auctionDate: clean(raw.auction_date),
    year: raw.year ? Number(raw.year) : null, make: clean(raw.make), model: clean(raw.model), series: clean(raw.series),
    engine: clean(raw.engine), cylinders: clean(raw.cylinders), fuel: clean(raw.fuel), drive: clean(raw.drive), transmission: clean(raw.transmission), color: clean(raw.color),
    odometer: Number.isFinite(Number(raw.odometer)) ? Number(raw.odometer) : null, odometerBrand: clean(raw.odobrand),
    loss: clean(raw.loss), damage, titleDoc: clean(raw.document) || clean(raw.title_type), keys: clean(raw.keys),
    state: clean(raw.state), location: clean(raw.location), seller: clean(raw.seller), status: clean(raw.status),
    priceBuyNow: Number(raw.price_buynow) > 0 ? Number(raw.price_buynow) : null,
    estRetail: Number(raw.cost_priced) > 0 ? Number(raw.cost_priced) : null,
    estRepair: Number(raw.cost_repair) > 0 ? Number(raw.cost_repair) : null,
    imageCount: images.length, _images: images,
  };
}

async function callApi(path, params = {}) {
  const u = new URL(config.apicar.base + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(u, { headers: { 'api-key': config.apicar.key, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  } catch {
    throw new HttpError(502, 'AUCTION_UNAVAILABLE', 'تعذّر الاتصال بخدمة بيانات المزادات الآن، حاول بعد قليل');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'AUCTION_UNAVAILABLE', 'مفتاح خدمة بيانات المزادات غير صالح أو منتهي');
  if (res.status === 429) throw new HttpError(429, 'AUCTION_RATE', 'ضغط كبير على خدمة المزادات، حاول بعد قليل');
  if (!res.ok) throw new HttpError(502, 'AUCTION_UNAVAILABLE', 'خدمة بيانات المزادات لم تردّ، حاول بعد قليل');
  try { return await res.json(); } catch { throw new HttpError(502, 'AUCTION_UNAVAILABLE', 'ردّ غير مفهوم من خدمة المزادات'); }
}

/** يأخذ أول كائن سيارة من أي شكل ردّ محتمل */
function pickCar(body) {
  if (!body) return null;
  if (Array.isArray(body)) return body[0] || null;
  if (body.data) return Array.isArray(body.data) ? body.data[0] || null : body.data;
  if (body.vin || body.lot_id) return body;
  return null;
}

/** بحث بالـVIN عبر apicar (أحدث سجل). يعيد null إن لم يوجد. */
export async function lookupVin(rawVin) {
  if (!apicarEnabled()) return null;
  const vin = String(rawVin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new HttpError(422, 'BAD_VIN', 'اكتب رقم الهيكل كاملًا (17 خانة)');
  const hit = cache.get(vin);
  if (hit && Date.now() - hit.at < (hit.data ? TTL_MS : NEG_TTL_MS)) return hit.data;
  const body = await callApi('/cars-histories', { vin });
  const data = mapApicar(pickCar(body));
  cache.set(vin, { at: Date.now(), data });
  return data;
}

/** صورة من المزاد بالفهرس، عبر الخادم (الـCSP يمنع المتصفح من جلبها مباشرة). مع ذاكرة مؤقتة. */
export async function auctionImage(vin, index) {
  const v = String(vin || '').trim().toUpperCase();
  const i = Number(index);
  const car = await lookupVin(v);
  const url = car && car._images && car._images[i];
  if (!url) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  const key = `${v}|${i}`;
  const c = img.get(key);
  if (c && Date.now() - c.at < TTL_MS) return c;
  let res;
  try {
    const needKey = /(^|\.)apicar\.store$/i.test(new URL(url).host);
    res = await fetch(url, { headers: needKey ? { 'api-key': config.apicar.key } : {}, signal: AbortSignal.timeout(12000) });
  } catch { throw new HttpError(502, 'AUCTION_UNAVAILABLE', 'تعذّر جلب الصورة'); }
  if (!res.ok) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\//.test(mime)) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  const buf = Buffer.from(await res.arrayBuffer());
  const out = { at: Date.now(), buf, mime };
  if (img.size > 500) img.clear(); // سقف بسيط لذاكرة الصور
  img.set(key, out);
  return out;
}

/** نسخة للعرض بلا الروابط الداخلية */
export const publicCar = (car) => (car ? (({ _images, ...rest }) => rest)(car) : null);
