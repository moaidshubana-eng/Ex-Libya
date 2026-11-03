// بوابة العملاء: ما يراه العميل عن سياراته وحسابه، وصفحة التتبّع العامة بالكود.
// العميل يرى سياراته فقط (customer_id)، ولا يرى أبدًا: التكاليف، المورد، الملاحظات الداخلية، أسعار الشراء.
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { hashPassword, newToken, sha256, lookupHash, verifyPassword } from '../security/crypto.js';
import { customerAccount } from './accounts.js';
import { STATUS_LABEL } from '../domain/status.js';

export const PORTAL_SESSION_HOURS = 24 * 14;

// مراحل مبسطة يفهمها العميل (مثل بوابات الوسطاء): كل حالة داخلية تقع في مرحلة
export const PORTAL_STAGES = [
  { key: 'bought', label: 'تم الشراء', statuses: ['PURCHASED', 'AWAITING_PICKUP'] },
  { key: 'warehouse', label: 'في مستودع التصدير', statuses: ['US_INLAND_TRANSIT', 'AT_US_WAREHOUSE'] },
  { key: 'shipped', label: 'تم الشحن', statuses: ['LOADED', 'IN_TRANSIT_SEA'] },
  { key: 'libya', label: 'وصلت ليبيا', statuses: ['AT_PORT_LIBYA', 'IN_CUSTOMS', 'CUSTOMS_CLEARED', 'LY_INLAND_TRANSIT'] },
  { key: 'ready', label: 'جاهزة للاستلام', statuses: ['IN_STOCK', 'IN_AUCTION', 'SOLD', 'DELIVERED'] },
];
const stageOf = (status, holdReturn) => {
  const s = status === 'ON_HOLD' ? holdReturn : status;
  return PORTAL_STAGES.findIndex((g) => g.statuses.includes(s));
};

/** كلمة سر البوابة: 8 أحرف على الأقل (العميل يكتبها من الجوال) */
export function portalPasswordError(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'كلمة السر يجب ألا تقل عن 8 خانات';
  if (pw.length > 100) return 'كلمة السر طويلة جدًا';
  return null;
}
/** كلمة سر مؤقتة يسهل إملاؤها: 8 خانات بلا أحرف ملتبسة (0/O، 1/l) */
export function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(newToken().slice(0, 8), (ch) => abc[ch.charCodeAt(0) % abc.length]).join('');
}

// ------------------------------------------------------------------ الحساب والدخول
export async function setPortalAccount(customerId, actor) {
  const { rows: [c] } = await query('SELECT id, full_name, phone_hash FROM customers WHERE id = $1', [customerId]);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'العميل غير موجود');
  if (!c.phone_hash) throw new HttpError(422, 'NO_PHONE', 'سجّل رقم هاتف العميل أولًا؛ يدخل به البوابة');
  const password = tempPassword();
  return tx(async (cl) => {
    const { rows: [prev] } = await cl.query('SELECT customer_id FROM portal_accounts WHERE customer_id = $1', [customerId]);
    await cl.query(
      `INSERT INTO portal_accounts (customer_id, password_hash, must_change, is_active, created_by) VALUES ($1,$2,TRUE,TRUE,$3)
       ON CONFLICT (customer_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = TRUE, is_active = TRUE,
         failed_logins = 0, locked_until = NULL, updated_at = now()`, [customerId, await hashPassword(password), actor.id]);
    await cl.query('UPDATE portal_sessions SET revoked_at = now() WHERE customer_id = $1 AND revoked_at IS NULL', [customerId]);
    await audit(cl, { actorId: actor.id, action: prev ? 'PORTAL_PASSWORD_RESET' : 'PORTAL_ACCOUNT_CREATED', entity: 'customer', entityId: customerId, ip: actor.ip });
    return { password, created: !prev };
  });
}

export async function disablePortalAccount(customerId, actor) {
  return tx(async (cl) => {
    const { rowCount } = await cl.query('UPDATE portal_accounts SET is_active = FALSE, updated_at = now() WHERE customer_id = $1', [customerId]);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'لا يوجد حساب بوابة لهذا العميل');
    await cl.query('UPDATE portal_sessions SET revoked_at = now() WHERE customer_id = $1 AND revoked_at IS NULL', [customerId]);
    await audit(cl, { actorId: actor.id, action: 'PORTAL_ACCOUNT_DISABLED', entity: 'customer', entityId: customerId, ip: actor.ip });
    return { ok: true };
  });
}

export async function portalAccountInfo(customerId) {
  const { rows: [a] } = await query('SELECT is_active, must_change, last_login_at, locked_until, created_at FROM portal_accounts WHERE customer_id = $1', [customerId]);
  return a || null;
}

const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86);
export async function portalLogin(phone, password, meta) {
  const generic = new HttpError(401, 'BAD_CREDENTIALS', 'رقم الهاتف أو كلمة السر غير صحيحة');
  // قد يتشارك أكثر من عميل نفس الهاتف نظريًا: نجرّب الحسابات المفعّلة بنفس البصمة
  const { rows } = await query(
    `SELECT a.*, c.full_name FROM portal_accounts a JOIN customers c ON c.id = a.customer_id
      WHERE c.phone_hash = $1 AND a.is_active ORDER BY a.last_login_at DESC NULLS LAST LIMIT 3`, [lookupHash(phone)]);
  if (!rows.length) { await verifyPassword(password, DUMMY_HASH).catch(() => {}); throw generic; } // توقيت ثابت
  for (const a of rows) {
    if (a.locked_until && new Date(a.locked_until) > new Date()) throw new HttpError(423, 'LOCKED', 'الحساب مقفل مؤقتًا بسبب محاولات فاشلة متكررة، حاول بعد 15 دقيقة');
    if (await verifyPassword(password, a.password_hash)) {
      const token = newToken();
      await query('UPDATE portal_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE customer_id = $1', [a.customer_id]);
      await query(`INSERT INTO portal_sessions (customer_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2, now() + make_interval(hours => $3), $4, $5)`,
        [a.customer_id, sha256(token), PORTAL_SESSION_HOURS, meta.ip, String(meta.userAgent || '').slice(0, 300)]);
      await audit(null, { actorId: null, action: 'PORTAL_LOGIN', entity: 'customer', entityId: a.customer_id, ip: meta.ip });
      return { token, customer: { name: a.full_name, mustChange: a.must_change } };
    }
  }
  for (const a of rows) {
    await query(`UPDATE portal_accounts SET failed_logins = failed_logins + 1,
                   locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' END WHERE customer_id = $1`, [a.customer_id]);
  }
  throw generic;
}

export async function portalSession(token) {
  if (!token) return null;
  const { rows: [s] } = await query(
    `SELECT s.id AS session_id, c.id AS customer_id, c.code, c.full_name, a.must_change
       FROM portal_sessions s JOIN portal_accounts a ON a.customer_id = s.customer_id JOIN customers c ON c.id = s.customer_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.is_active`, [sha256(token)]);
  return s || null;
}

export async function portalLogout(sessionId) {
  await query('UPDATE portal_sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
}

export async function portalChangePassword(customerId, sessionId, current, next) {
  const bad = portalPasswordError(next);
  if (bad) throw new HttpError(422, 'WEAK_PASSWORD', bad);
  const { rows: [a] } = await query('SELECT password_hash FROM portal_accounts WHERE customer_id = $1', [customerId]);
  if (!a || !(await verifyPassword(current, a.password_hash))) throw new HttpError(403, 'BAD_PASSWORD', 'كلمة السر الحالية غير صحيحة');
  await query('UPDATE portal_accounts SET password_hash = $2, must_change = FALSE, updated_at = now() WHERE customer_id = $1', [customerId, await hashPassword(next)]);
  await query('UPDATE portal_sessions SET revoked_at = now() WHERE customer_id = $1 AND id <> $2 AND revoked_at IS NULL', [customerId, sessionId]);
  await audit(null, { actorId: null, action: 'PORTAL_PASSWORD_CHANGED', entity: 'customer', entityId: customerId });
  return { ok: true };
}

// ------------------------------------------------------------------ السيارات
const CAR_SQL = `
  SELECT v.id, v.stock_no, v.track_code, v.vin, v.year, v.make, v.model, v.trim, v.exterior_color, v.odometer, v.odometer_unit,
         v.title_type, v.primary_damage, v.has_keys, v.status, v.hold_return_status, v.status_changed_at, v.created_at,
         v.customer_id, v.customer_price, v.customer_currency,
         es.code AS source, sl.lot_number, sl.sale_date AS purchase_date,
         sh.container_no, sh.vessel_name, sh.voyage_no, sh.status AS shipment_status, sh.etd, sh.atd, sh.eta, sh.ata,
         pol.name_ar AS pol_name, pol.name AS pol_name_en, pod.name_ar AS pod_name, carrier.name AS carrier,
         cd.status AS customs_status,
         COALESCE((SELECT json_agg(i.id ORDER BY i.is_primary DESC, i.sort_order) FROM vehicle_images i WHERE i.vehicle_id = v.id AND i.content IS NOT NULL), '[]') AS image_ids
    FROM vehicles v
    LEFT JOIN LATERAL (SELECT * FROM source_listings s WHERE s.vehicle_id = v.id ORDER BY first_seen_at DESC LIMIT 1) sl ON TRUE
    LEFT JOIN external_sources es ON es.id = sl.source_id
    LEFT JOIN shipment_vehicles sv ON sv.vehicle_id = v.id
    LEFT JOIN shipments sh ON sh.id = sv.shipment_id
    LEFT JOIN ports pol ON pol.id = sh.pol_port_id
    LEFT JOIN ports pod ON pod.id = sh.pod_port_id
    LEFT JOIN vendors carrier ON carrier.id = sh.carrier_id
    LEFT JOIN customs_declarations cd ON cd.vehicle_id = v.id`;

/** صف السيارة كما يراه العميل؛ withMoney=false لصفحة التتبّع العامة */
function carView(r, { withMoney = true, history = [] } = {}) {
  const stage = stageOf(r.status, r.hold_return_status);
  return {
    id: r.id, stockNo: r.stock_no, trackCode: r.track_code, vin: r.vin, year: r.year, make: r.make, model: r.model, trim: r.trim,
    color: r.exterior_color, odometer: r.odometer, odometerUnit: r.odometer_unit, titleType: r.title_type, damage: r.primary_damage, hasKeys: r.has_keys,
    status: r.status, statusLabel: STATUS_LABEL[r.status], statusAt: r.status_changed_at, stage, onHold: r.status === 'ON_HOLD', cancelled: r.status === 'CANCELLED',
    source: r.source, lotNumber: r.lot_number, purchaseDate: r.purchase_date,
    shipment: r.container_no || r.vessel_name || r.eta ? {
      container: r.container_no, vessel: r.vessel_name, voyage: r.voyage_no, carrier: r.carrier, status: r.shipment_status,
      etd: r.etd, atd: r.atd, eta: r.eta, ata: r.ata, from: r.pol_name || r.pol_name_en, to: r.pod_name } : null,
    customsStatus: r.customs_status,
    images: r.image_ids,
    ...(withMoney ? { price: r.customer_price, currency: r.customer_currency } : {}),
    history: history.map((h) => ({ status: h.to_status, label: STATUS_LABEL[h.to_status], at: h.occurred_at })),
  };
}

async function histories(ids) {
  if (!ids.length) return new Map();
  const { rows } = await query('SELECT vehicle_id, to_status, occurred_at FROM vehicle_status_history WHERE vehicle_id = ANY($1) ORDER BY occurred_at', [ids]);
  const m = new Map();
  for (const r of rows) (m.get(r.vehicle_id) || m.set(r.vehicle_id, []).get(r.vehicle_id)).push(r);
  return m;
}

export async function myCars(customerId) {
  const { rows } = await query(`${CAR_SQL} WHERE v.customer_id = $1 ORDER BY v.created_at DESC`, [customerId]);
  const h = await histories(rows.map((r) => r.id));
  const acc = await customerAccount(customerId);
  const remaining = new Map(acc.vehicles.map((v) => [`${v.vehicleId}|${v.currency}`, v]));
  return rows.map((r) => {
    const car = carView(r, { history: h.get(r.id) || [] });
    const a = remaining.get(`${r.id}|${r.customer_currency}`);
    return { ...car, paid: a?.paid ?? null, remaining: a?.remaining ?? null };
  });
}

export async function myCar(customerId, vehicleId) {
  const cars = await myCars(customerId);
  const car = cars.find((c) => c.id === vehicleId);
  if (!car) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
  return car;
}

/** كشف الحساب كما يراه العميل (بلا أسعار صرف داخلية أو بيانات موظفين) */
export async function myStatement(customerId) {
  const a = await customerAccount(customerId);
  return {
    name: a.party.name, code: a.party.code, summary: a.summary, vehicles: a.vehicles, unallocated: a.unallocated,
    lines: a.lines.map((l) => ({ date: l.date, type: l.type, label: l.label, stockNo: l.stockNo, currency: l.currency, debit: l.debit, credit: l.credit, balance: l.balance, receiptNo: l.receiptNo })),
  };
}

/** التتبّع العام بالكود: بلا مبالغ ولا بيانات العميل */
export async function trackByCode(code) {
  if (!/^[0-9a-f]{12}$/i.test(String(code || ''))) throw new HttpError(404, 'NOT_FOUND', 'كود التتبّع غير صحيح');
  const { rows: [r] } = await query(`${CAR_SQL} WHERE v.track_code = $1`, [String(code).toLowerCase()]);
  if (!r || r.status === 'CANCELLED') throw new HttpError(404, 'NOT_FOUND', 'كود التتبّع غير صحيح');
  const h = await histories([r.id]);
  return carView(r, { withMoney: false, history: h.get(r.id) || [] });
}

/** صورة لسيارة يملكها العميل، أو لسيارة كود تتبّعها معروف */
export async function portalImage({ customerId = null, trackCode = null, vehicleId, imageId }) {
  const { rows: [r] } = await query(
    `SELECT i.content, i.mime, i.sha256 FROM vehicle_images i JOIN vehicles v ON v.id = i.vehicle_id
      WHERE i.id = $1 AND v.id = $2 AND ($3::uuid IS NULL OR v.customer_id = $3) AND ($4::text IS NULL OR v.track_code = $4)
        AND ($3::uuid IS NOT NULL OR $4::text IS NOT NULL)`, [imageId, vehicleId, customerId, trackCode]);
  if (!r || !r.content) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  return r;
}
