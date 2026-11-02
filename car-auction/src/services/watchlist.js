// مزادات أمريكا: سيارات نتابعها في Copart/IAAI قبل شرائها.
// اللوت يبقى خارج دورة حياة السيارة والتكاليف؛ عند الشراء يُحوَّل إلى سيارة عادية (createVehicle)
// في نفس المعاملة، ويُعلَّم «اشتريناها» ويُربط بها.
import { createHash } from 'node:crypto';
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { createVehicle } from './vehicles.js';
import { decodeImage } from './images.js';

export const MAX_IMAGES_PER_LOT = 30;
// بيانات الصور (بلا المحتوى) مرتبة: الرئيسية أولًا
const IMAGES_JSON = `COALESCE((SELECT json_agg(json_build_object('id', i.id, 'is_primary', i.is_primary) ORDER BY i.is_primary DESC, i.sort_order)
                       FROM watch_lot_images i WHERE i.watch_lot_id = w.id), '[]') AS images`;

export const WATCH_STATUSES = ['WATCHING', 'WON', 'LOST', 'DROPPED', 'PURCHASED'];
// الانتقالات اليدوية المسموحة (PURCHASED لا تأتي إلا من التحويل لسيارة، وهي نهائية)
const NEXT = { WATCHING: ['WON', 'LOST', 'DROPPED'], WON: ['WATCHING', 'LOST'], LOST: ['WATCHING'], DROPPED: ['WATCHING'], PURCHASED: [] };

// اسم الحقل في الطلب → العمود
const COLS = {
  source: 'source', lotNumber: 'lot_number', lotUrl: 'lot_url', vin: 'vin', year: 'year', make: 'make', model: 'model', trim: 'trim',
  odometer: 'odometer', odometerUnit: 'odometer_unit', primaryDamage: 'primary_damage', titleDoc: 'title_doc', runStatus: 'run_status',
  hasKeys: 'has_keys', usState: 'us_state', city: 'city', branch: 'branch', auctionAt: 'auction_at', currentBidUsd: 'current_bid_usd',
  buyNowUsd: 'buy_now_usd', estValueUsd: 'est_value_usd', maxBidUsd: 'max_bid_usd', finalPriceUsd: 'final_price_usd', notes: 'notes',
};
const UPPER = ['vin', 'make', 'model', 'trim', 'usState', 'primaryDamage', 'titleDoc'];

function clean(b) {
  const out = {};
  for (const [k, v] of Object.entries(b)) out[k] = typeof v === 'string' && UPPER.includes(k) ? v.toUpperCase() : v;
  return out;
}

const dupLot = (e) => {
  if (e.code === '23505') throw new HttpError(409, 'DUPLICATE_LOT', 'هذا اللوت مضاف مسبقًا في مزادات أمريكا');
  throw e;
};

export async function listWatch({ status, q } = {}) {
  const where = [], params = [];
  if (status && status !== 'ALL') { params.push(status); where.push(`w.status = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(w.lot_number ILIKE $${params.length} OR w.vin ILIKE $${params.length} OR w.make ILIKE $${params.length} OR w.model ILIKE $${params.length} OR w.city ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `SELECT w.*, v.stock_no, u.full_name AS created_by_name, ${IMAGES_JSON}
       FROM watch_lots w LEFT JOIN vehicles v ON v.id = w.vehicle_id LEFT JOIN users u ON u.id = w.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (w.status = 'WATCHING') DESC, (w.auction_at < now() - interval '1 day') ASC, w.auction_at ASC NULLS LAST, w.created_at DESC
      LIMIT 500`, params);
  const { rows: counts } = await query('SELECT status, count(*)::int AS n FROM watch_lots GROUP BY status');
  return { items: rows, counts: Object.fromEntries(counts.map((r) => [r.status, r.n])) };
}

export async function getWatch(id) {
  const { rows: [w] } = await query(`SELECT w.*, v.stock_no, ${IMAGES_JSON} FROM watch_lots w LEFT JOIN vehicles v ON v.id = w.vehicle_id WHERE w.id = $1`, [id]);
  if (!w) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
  return w;
}

export async function addWatch(b, actor) {
  const d = clean(b);
  const keys = Object.keys(d).filter((k) => COLS[k]);
  const cols = keys.map((k) => COLS[k]);
  const { rows: [w] } = await query(
    `INSERT INTO watch_lots (${cols.join(', ')}, created_by, updated_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 1}) RETURNING *`,
    [...keys.map((k) => d[k]), actor.id]).catch(dupLot);
  await audit(null, { actorId: actor.id, action: 'WATCH_ADDED', entity: 'watch_lot', entityId: w.id, after: { source: w.source, lot: w.lot_number }, ip: actor.ip });
  return w;
}

export async function updateWatch(id, b, actor) {
  const d = clean(b);
  const keys = Object.keys(d).filter((k) => COLS[k]);
  if (!keys.length) return getWatch(id);
  return tx(async (c) => {
    const { rows: [before] } = await c.query('SELECT * FROM watch_lots WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
    if (before.status === 'PURCHASED') throw new HttpError(422, 'LOCKED', 'اللوت تحوّل إلى سيارة؛ عدّل بيانات السيارة نفسها');
    const { rows: [w] } = await c.query(
      `UPDATE watch_lots SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => d[k]), actor.id]).catch(dupLot);
    const changed = Object.fromEntries(keys.map((k) => [COLS[k], [before[COLS[k]], w[COLS[k]]]]).filter(([, [a, z]]) => String(a ?? '') !== String(z ?? '')));
    if (Object.keys(changed).length) await audit(c, { actorId: actor.id, action: 'WATCH_UPDATED', entity: 'watch_lot', entityId: id, after: changed, ip: actor.ip });
    return w;
  });
}

export async function setWatchStatus(id, to, actor, finalPriceUsd = null) {
  return tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT status FROM watch_lots WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
    if (!NEXT[w.status].includes(to)) throw new HttpError(422, 'BAD_TRANSITION', 'لا يمكن تغيير الحالة بهذا الشكل');
    const { rows: [out] } = await c.query(
      `UPDATE watch_lots SET status = $2, final_price_usd = COALESCE($3, final_price_usd), updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, to, finalPriceUsd, actor.id]);
    await audit(c, { actorId: actor.id, action: 'WATCH_STATUS', entity: 'watch_lot', entityId: id, before: { status: w.status }, after: { status: to, finalPriceUsd }, ip: actor.ip });
    return out;
  });
}

const RUN_TO_BOOL = { RUN_DRIVE: true, STARTS: false, STATIONARY: false };
function titleType(doc) {
  const s = String(doc || '').toUpperCase();
  if (/SALVAGE|\bSV\b|\bST\b|\bSC\b/.test(s)) return 'SALVAGE';
  if (/REBUILT|\bRB\b/.test(s)) return 'REBUILT';
  if (/PARTS/.test(s)) return 'PARTS_ONLY';
  if (/DESTRUCT|JUNK/.test(s)) return 'CERTIFICATE_OF_DESTRUCTION';
  if (/CLEAN|CLEAR|ORIGINAL/.test(s)) return 'CLEAN';
  return 'OTHER';
}

/** اشتريناها: تُنشأ سيارة من بيانات اللوت + بيانات الشراء، ويُعلَّم اللوت «اشتريناها» ويُربط بها */
export async function convertWatch(id, b, actor) {
  const w = await getWatch(id);
  if (!['WATCHING', 'WON'].includes(w.status)) throw new HttpError(422, 'BAD_TRANSITION', 'لا يُحوَّل إلا لوت قيد المتابعة أو فزنا به');
  const vin = String(b.vin || w.vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new HttpError(422, 'BAD_VIN', 'اكتب رقم الهيكل كاملًا (17 خانة) قبل التحويل لسيارة');
  if (!w.year || !w.make || !w.model) throw new HttpError(422, 'MISSING_SPECS', 'أكمل سنة الصنع والماركة والطراز في اللوت أولًا');
  const auctionInfo = [w.branch, w.city, w.us_state].filter(Boolean).join('، ');
  const vehicle = {
    vin, year: w.year, make: w.make, model: w.model, trim: w.trim || undefined, odometer: w.odometer ?? undefined, odometerUnit: w.odometer_unit,
    titleType: titleType(w.title_doc), primaryDamage: w.primary_damage || undefined, hasKeys: w.has_keys ?? undefined,
    runAndDrive: RUN_TO_BOOL[w.run_status], source: w.source, lotNumber: /^\d{4,12}$/.test(w.lot_number) ? w.lot_number : undefined,
    purchaseDate: b.purchaseDate, purchasePriceUsd: b.purchasePriceUsd, buyerFeeUsd: b.buyerFeeUsd, otherFeesUsd: b.otherFeesUsd,
    customerId: b.customerId, customerPrice: b.customerPrice, customerCurrency: b.customerCurrency, vendorId: b.vendorId, destinationPort: b.destinationPort,
    notes: [w.notes, auctionInfo && `موقع المزاد: ${auctionInfo}`].filter(Boolean).join(' — ').slice(0, 1000) || undefined,
  };
  return createVehicle(vehicle, actor, async (c, v) => {
    const { rowCount } = await c.query(
      `UPDATE watch_lots SET status = 'PURCHASED', vehicle_id = $2, vin = $3, final_price_usd = COALESCE($4, final_price_usd), updated_by = $5, updated_at = now()
        WHERE id = $1 AND status IN ('WATCHING','WON')`, [id, v.id, vin, b.purchasePriceUsd || null, actor.id]);
    if (!rowCount) throw new HttpError(409, 'STALE', 'تغيّرت حالة اللوت أثناء التحويل — أعد تحميل الصفحة');
    // الصور تنتقل للسيارة (نقل لا نسخ، فلا تتضاعف مساحة القاعدة)
    const { rowCount: moved } = await c.query(
      `INSERT INTO vehicle_images (vehicle_id, kind, storage_key, content, mime, bytes, sha256, width, height, sort_order, is_primary, captured_at)
       SELECT $2, 'EXTERIOR', 'db:' || sha256, content, mime, bytes, sha256, width, height, sort_order, is_primary, created_at
         FROM watch_lot_images WHERE watch_lot_id = $1`, [id, v.id]);
    await c.query('DELETE FROM watch_lot_images WHERE watch_lot_id = $1', [id]);
    await audit(c, { actorId: actor.id, action: 'WATCH_CONVERTED', entity: 'watch_lot', entityId: id, after: { vehicleId: v.id, stockNo: v.stock_no, imagesMoved: moved }, ip: actor.ip });
  });
}

// ---------------------------------------------------------------- الصور
export async function addWatchImage(id, { data, width, height }, actor) {
  const { buf, mime } = decodeImage(data);
  const sha = createHash('sha256').update(buf).digest('hex');
  return tx(async (c) => {
    const { rows: [w] } = await c.query('SELECT status FROM watch_lots WHERE id = $1 FOR UPDATE', [id]);
    if (!w) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
    if (w.status === 'PURCHASED') throw new HttpError(422, 'LOCKED', 'اللوت تحوّل إلى سيارة؛ أضف الصور من صفحة السيارة');
    const { rows: [st] } = await c.query(
      'SELECT count(*)::int AS n, COALESCE(max(sort_order), -1) AS last, bool_or(is_primary) AS has_primary FROM watch_lot_images WHERE watch_lot_id = $1', [id]);
    if (st.n >= MAX_IMAGES_PER_LOT) throw new HttpError(422, 'TOO_MANY_IMAGES', `الحد الأقصى ${MAX_IMAGES_PER_LOT} صورة للوت`);
    const { rows: [im] } = await c.query(
      `INSERT INTO watch_lot_images (watch_lot_id, content, mime, bytes, sha256, width, height, sort_order, is_primary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (watch_lot_id, sha256) DO NOTHING RETURNING id, is_primary, sort_order`,
      [id, buf, mime, buf.length, sha, width || null, height || null, st.last + 1, !st.has_primary, actor.id]);
    if (!im) throw new HttpError(409, 'DUPLICATE_IMAGE', 'هذه الصورة مرفوعة مسبقًا لهذا اللوت');
    await audit(c, { actorId: actor.id, action: 'WATCH_IMAGE_ADDED', entity: 'watch_lot', entityId: id, after: { imageId: im.id, bytes: buf.length, mime }, ip: actor.ip });
    return im;
  });
}

export async function deleteWatchImage(id, imageId, actor) {
  return tx(async (c) => {
    const { rows: [im] } = await c.query('DELETE FROM watch_lot_images WHERE id = $1 AND watch_lot_id = $2 RETURNING is_primary, bytes', [imageId, id]);
    if (!im) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
    if (im.is_primary) {
      await c.query(`UPDATE watch_lot_images SET is_primary = TRUE WHERE id = (SELECT id FROM watch_lot_images WHERE watch_lot_id = $1 ORDER BY sort_order LIMIT 1)`, [id]);
    }
    await audit(c, { actorId: actor.id, action: 'WATCH_IMAGE_DELETED', entity: 'watch_lot', entityId: id, before: { imageId, bytes: im.bytes }, ip: actor.ip });
    return { ok: true };
  });
}

export async function setWatchPrimaryImage(id, imageId, actor) {
  return tx(async (c) => {
    const { rows: [im] } = await c.query('SELECT id FROM watch_lot_images WHERE id = $1 AND watch_lot_id = $2 FOR UPDATE', [imageId, id]);
    if (!im) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
    await c.query('UPDATE watch_lot_images SET is_primary = FALSE WHERE watch_lot_id = $1 AND is_primary', [id]);
    await c.query('UPDATE watch_lot_images SET is_primary = TRUE WHERE id = $1', [imageId]);
    await audit(c, { actorId: actor.id, action: 'WATCH_IMAGE_PRIMARY', entity: 'watch_lot', entityId: id, after: { imageId }, ip: actor.ip });
    return { ok: true };
  });
}

export async function getWatchImage(id, imageId) {
  const { rows: [r] } = await query('SELECT content, mime, sha256 FROM watch_lot_images WHERE id = $1 AND watch_lot_id = $2', [imageId, id]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  return r;
}
