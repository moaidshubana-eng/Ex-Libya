// فك رقم الهيكل (VIN) عبر قاعدة بيانات NHTSA vPIC المجانية والعامة (حكومة الولايات المتحدة).
// تُستدعى من الخادم لا من المتصفح (سياسة CSP تمنع المتصفح من الاتصال بغير موقعنا).
// ملاحظة: vPIC دقيقة للسيارات المباعة في السوق الأمريكي (وهي حالة مشتريات Copart/IAAI)، وقد تعيد بيانات
// ناقصة لسيارات أخرى. لذلك تُعامل النتيجة اقتراحًا يراجعه المستخدم، لا حقيقة نهائية.
import { vinError } from '../domain/vin.js';
import { HttpError } from '../security/middleware.js';

const BASE = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues';
const TTL_MS = 24 * 3600_000;
const cache = new Map(); // vin -> { at, data }

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s && !/^(not applicable|null|n\/a)$/i.test(s) ? s : null;
};
const title = (s) => (s && s === s.toUpperCase() && /[A-Z]{4,}/.test(s) ? s.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase()) : s);

/** يحوّل رد vPIC الخام إلى حقول المنظومة. دالة نقية قابلة للاختبار. */
export function mapVpic(row) {
  const year = Number(row.ModelYear);
  const disp = clean(row.DisplacementL);
  const cyl = clean(row.EngineCylinders);
  const engine = [disp && `${Number(disp).toFixed(1)}L`, cyl && `${cyl} cyl`, clean(row.EngineModel)].filter(Boolean).join(' ') || null;
  const body = clean(row.BodyClass);
  return {
    year: Number.isInteger(year) && year > 1950 && year < 2100 ? year : null,
    make: title(clean(row.Make)),
    model: clean(row.Model),
    trim: clean(row.Trim) || clean(row.Series),
    // vPIC يعيد وصفًا طويلًا مثل «Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)»
    bodyStyle: body ? (/pickup/i.test(body) ? 'PICKUP' : /sport utility|suv/i.test(body) ? 'SUV' : /sedan|saloon/i.test(body) ? 'SEDAN'
      : /coupe/i.test(body) ? 'COUPE' : /hatchback/i.test(body) ? 'HATCHBACK' : /van/i.test(body) ? 'VAN' : /convertible|cabriolet/i.test(body) ? 'CONVERTIBLE'
      : /wagon/i.test(body) ? 'WAGON' : body.toUpperCase().slice(0, 40)) : null,
    engine, cylinders: cyl ? Number(cyl) : null,
    fuelType: clean(row.FuelTypePrimary), transmission: clean(row.TransmissionStyle), driveType: clean(row.DriveType),
    plantCountry: clean(row.PlantCountry),
  };
}

export async function decodeVin(rawVin) {
  const vin = String(rawVin || '').trim().toUpperCase();
  const bad = vinError(vin);
  if (bad) throw new HttpError(422, 'BAD_VIN', bad);
  const hit = cache.get(vin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  let res;
  try {
    res = await fetch(`${BASE}/${vin}?format=json`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  } catch {
    throw new HttpError(502, 'VIN_LOOKUP_UNAVAILABLE', 'تعذر الاتصال بقاعدة بيانات الـVIN الآن. اكتب المواصفات يدويًا أو أعد المحاولة');
  }
  if (!res.ok) throw new HttpError(502, 'VIN_LOOKUP_UNAVAILABLE', 'قاعدة بيانات الـVIN لم ترد (خطأ مؤقت). اكتب المواصفات يدويًا أو أعد المحاولة');
  let body;
  try { body = await res.json(); } catch { throw new HttpError(502, 'VIN_LOOKUP_UNAVAILABLE', 'رد غير مفهوم من قاعدة بيانات الـVIN'); }
  const row = body?.Results?.[0];
  if (!row) throw new HttpError(502, 'VIN_LOOKUP_UNAVAILABLE', 'رد غير مفهوم من قاعدة بيانات الـVIN');

  const data = { vin, ...mapVpic(row), source: 'NHTSA', found: !!(row.Make && row.Model) };
  // لا نخزّن في الذاكرة المؤقتة ما لم نجد ماركة وطرازًا (قد يكون عطلًا مؤقتًا عندهم)
  if (data.found) cache.set(vin, { at: Date.now(), data });
  return data;
}
