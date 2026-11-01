import express from 'express';
import { query, tx, audit } from '../db.js';
import { config } from '../config.js';
import { asyncH, requireAuth, requireRole, rateLimit, HttpError, ROLES } from '../security/middleware.js';
import { verifyPassword, hashPassword, passwordPolicyError, newToken, sha256, encrypt, lookupHash, decrypt, mask } from '../security/crypto.js';
import { validate, t, isUuid } from '../validate.js';
import { STATUSES, STATUS_CODES } from '../domain/status.js';
const TITLES = ['CLEAN', 'SALVAGE', 'REBUILT', 'PARTS_ONLY', 'CERTIFICATE_OF_DESTRUCTION', 'OTHER'];
import { listVehicles, getVehicle, changeStatus, compareVehicles, getVehicleCosts, createVehicle, updateVehicle } from '../services/vehicles.js';
import { addCost, voidCost, addSharedCost, costReport } from '../services/costs.js';
import { placeBid, setProxy, listAuctions, getLot, createLot } from '../services/auctions.js';
import { subscribe } from '../services/realtime.js';
import { ops } from './ops.js';
import { costReportXlsx, costReportCsv } from '../services/export.js';
import { renderVehicleSvg } from '../services/media.js';
import { decodeVin } from '../services/vin-decode.js';
import { addVehicleImage, deleteVehicleImage, setPrimaryImage } from '../services/images.js';
import { customerAccount, vendorAccount, customerBalances, vendorBalances, addAccountPayment, voidAccountPayment, setVehicleDeal, vehicleDeal, paymentReceipt, accountsOverview } from '../services/accounts.js';
import { addExpense, voidExpense, listExpenses, profitReport, EXPENSE_CATEGORIES } from '../services/expenses.js';
import { syncPurchases, syncTracking, importCsv, retryDeadLetter, SyncBusy, CircuitOpen } from '../sync/engine.js';

export const api = express.Router();

const actorOf = (req) => ({ id: req.user.id, ip: req.ip, ipHash: sha256(`${req.ip}`).slice(0, 16) });
const isStaff = (u) => ROLES.STAFF.includes(u.role);
const uuidParam = (name) => (req, _res, next) => (isUuid(req.params[name]) ? next() : next(new HttpError(404, 'NOT_FOUND', 'غير موجود')));

// ---------------------------------------------------------------- المصادقة
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}`, code: 'TOO_MANY_LOGINS' });

api.post('/auth/login', loginLimiter, asyncH(async (req, res) => {
  const { email, password } = validate(req.body, { email: t.string({ required: true, max: 200 }), password: t.string({ required: true, max: 200 }) });
  const { rows: [u] } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const generic = new HttpError(401, 'BAD_CREDENTIALS', 'البريد أو كلمة المرور غير صحيحة');
  if (!u || !u.is_active) {
    await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86)).catch(() => {}); // توقيت ثابت لمنع تعداد الحسابات
    throw generic;
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(423, 'LOCKED', 'الحساب مقفل مؤقتًا بسبب محاولات فاشلة متكررة');
  if (!(await verifyPassword(password, u.password_hash))) {
    await query(`UPDATE users SET failed_logins = failed_logins + 1,
                   locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' END WHERE id = $1`, [u.id]);
    await audit(null, { actorId: u.id, action: 'LOGIN_FAILED', entity: 'user', entityId: u.id, ip: req.ip });
    throw generic;
  }
  const token = newToken();
  await query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
  await query(`INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2, now() + make_interval(hours => $3), $4, $5)`,
    [u.id, sha256(token), config.sessionTtlHours, req.ip, String(req.get('user-agent') || '').slice(0, 300)]);
  await audit(null, { actorId: u.id, action: 'LOGIN', entity: 'user', entityId: u.id, ip: req.ip });
  res.cookie('sid', token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: config.sessionTtlHours * 3600_000, path: '/' });
  res.json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
}));

api.post('/auth/logout', requireAuth, asyncH(async (req, res) => {
  await query('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [req.user.session_id]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

api.get('/auth/me', requireAuth, (req, res) => {
  const { session_id, ...u } = req.user;
  res.json({ user: u });
});

api.post('/auth/password', requireAuth, rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `pw|${req.user?.id}` }), asyncH(async (req, res) => {
  const b = validate(req.body, { current: t.string({ required: true, max: 200 }), next: t.string({ required: true, max: 200 }) });
  const { rows: [u] } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(b.current, u.password_hash))) throw new HttpError(403, 'BAD_PASSWORD', 'كلمة المرور الحالية غير صحيحة');
  const bad = passwordPolicyError(b.next);
  if (bad) throw new HttpError(422, 'WEAK_PASSWORD', bad);
  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, await hashPassword(b.next)]);
  // إبطال كل الجلسات الأخرى (الجلسة الحالية تبقى)
  await query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.user.id, req.user.session_id]);
  await audit(null, { actorId: req.user.id, action: 'PASSWORD_CHANGED', entity: 'user', entityId: req.user.id, ip: req.ip });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- المستخدمون (المدير)
const USER_ROLES = ['ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES', 'VIEWER', 'BIDDER'];

api.get('/users', requireRole('ADMIN'), asyncH(async (_req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.last_login_at, u.locked_until, u.created_at, c.code AS customer_code
       FROM users u LEFT JOIN customers c ON c.id = u.customer_id ORDER BY u.is_active DESC, u.role, u.full_name`);
  res.json({ items: rows });
}));

api.post('/users', requireRole('ADMIN'), asyncH(async (req, res) => {
  const b = validate(req.body, {
    email: t.string({ required: true, max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }), fullName: t.string({ required: true, min: 2, max: 120 }),
    role: t.enum(USER_ROLES, { required: true }), password: t.string({ required: true, max: 200 }), phone: t.string({ max: 30 }),
  });
  const bad = passwordPolicyError(b.password);
  if (bad) throw new HttpError(422, 'WEAK_PASSWORD', bad);
  const out = await tx(async (c) => {
    const email = b.email.toLowerCase();
    if ((await c.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount) throw new HttpError(409, 'EMAIL_TAKEN', 'هذا البريد مسجل لمستخدم آخر');
    let customerId = null;
    if (b.role === 'BIDDER') {
      const { rows: [cu] } = await c.query(
        `INSERT INTO customers (code, full_name, customer_type, phone_enc, phone_hash, kyc_status)
         VALUES ('C-' || lpad(nextval('customer_seq')::text, 5, '0'), $1, 'INDIVIDUAL', $2, $3, 'PENDING') RETURNING id`,
        [b.fullName, encrypt(b.phone), lookupHash(b.phone)]);
      customerId = cu.id;
    }
    const { rows: [u] } = await c.query(
      `INSERT INTO users (email, full_name, password_hash, role, customer_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role`,
      [email, b.fullName, await hashPassword(b.password), b.role, customerId]);
    await audit(c, { actorId: req.user.id, action: 'USER_CREATED', entity: 'user', entityId: u.id, after: { email, role: b.role }, ip: req.ip });
    return u;
  });
  res.status(201).json(out);
}));

api.patch('/users/:id', requireRole('ADMIN'), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { isActive: t.bool(), role: t.enum(USER_ROLES), password: t.string({ max: 200 }) });
  if (req.params.id === req.user.id && (b.isActive === false || (b.role && b.role !== 'ADMIN')))
    throw new HttpError(422, 'SELF_LOCKOUT', 'لا يمكنك تعطيل حسابك أو خفض صلاحيتك بنفسك');
  if (b.password) { const bad = passwordPolicyError(b.password); if (bad) throw new HttpError(422, 'WEAK_PASSWORD', bad); }
  const out = await tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'المستخدم غير موجود');
    if (b.role && (cur.role === 'BIDDER') !== (b.role === 'BIDDER')) throw new HttpError(422, 'ROLE_KIND', 'لا يُحوَّل المزايد إلى موظف أو العكس؛ أنشئ حسابًا جديدًا');
    const { rows: [u] } = await c.query(
      `UPDATE users SET is_active = COALESCE($2, is_active), role = COALESCE($3::user_role, role),
              password_hash = COALESCE($4, password_hash), failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING id, email, role, is_active`,
      [req.params.id, b.isActive ?? null, b.role ?? null, b.password ? await hashPassword(b.password) : null]);
    if (b.isActive === false || b.password) await c.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
    await audit(c, { actorId: req.user.id, action: 'USER_UPDATED', entity: 'user', entityId: u.id, before: { role: cur.role, is_active: cur.is_active }, after: { role: u.role, is_active: u.is_active, passwordReset: !!b.password }, ip: req.ip });
    return u;
  });
  res.json(out);
}));

// ---------------------------------------------------------------- أسعار الصرف
api.get('/exchange-rates', requireRole(ROLES.COST_READERS), asyncH(async (_req, res) => {
  const { rows } = await query('SELECT id, currency, rate_to_lyd, effective_date, source FROM exchange_rates ORDER BY effective_date DESC, currency LIMIT 60');
  res.json({ items: rows });
}));

api.post('/exchange-rates', requireRole(['ADMIN', 'ACCOUNTANT']), asyncH(async (req, res) => {
  const b = validate(req.body, { currency: t.enum(['USD', 'EUR'], { required: true }), rateToLyd: t.decimal({ required: true, positive: true }), effectiveDate: t.date({ required: true }) });
  if (Number(b.rateToLyd) < 0.5 || Number(b.rateToLyd) > 50) throw new HttpError(422, 'FX_RANGE', 'سعر غير معقول للدينار الليبي — راجع الرقم');
  const { rows: [r] } = await query(
    `INSERT INTO exchange_rates (currency, rate_to_lyd, effective_date, source) VALUES ($1,$2,$3,'MANUAL')
     ON CONFLICT (currency, effective_date) DO UPDATE SET rate_to_lyd = EXCLUDED.rate_to_lyd RETURNING *`, [b.currency, b.rateToLyd, b.effectiveDate]);
  await audit(null, { actorId: req.user.id, action: 'FX_RATE_SET', entity: 'exchange_rate', entityId: r.id, after: r, ip: req.ip });
  res.status(201).json(r);
}));

// ---------------------------------------------------------------- مرجعيات
api.get('/meta', requireAuth, asyncH(async (req, res) => {
  const [cats, ports, rates, makes, vendors] = await Promise.all([
    query('SELECT code, name_ar, stage FROM cost_categories WHERE is_active ORDER BY sort_order'),
    query('SELECT code, name_ar, country FROM ports ORDER BY is_origin DESC, code'),
    query(`SELECT DISTINCT ON (currency) currency, rate_to_lyd, effective_date FROM exchange_rates ORDER BY currency, effective_date DESC`),
    query('SELECT DISTINCT make FROM vehicles ORDER BY make'),
    isStaff(req.user) ? query('SELECT id, name, vendor_type FROM vendors WHERE is_active ORDER BY vendor_type, name') : { rows: [] },
  ]);
  res.json({ integrationsEnabled: config.integrationsEnabled, statuses: STATUSES, costCategories: cats.rows, ports: ports.rows, rates: rates.rows, makes: makes.rows.map((m) => m.make), vendors: vendors.rows });
}));

// ---------------------------------------------------------------- لوحة المؤشرات
// لوحة المؤشرات تجميعية على كل الأسطول: نخزنها 10 ثوانٍ في الذاكرة حتى لا يكرر 20 مستخدمًا
// نفس التجميع في اللحظة نفسها (تأخير 10 ثوانٍ مقبول لمؤشرات إدارية؛ المزايدة والحالات لا تُخزَّن)
let dashCache = { at: 0, data: null, pending: null };
api.get('/dashboard', requireRole(ROLES.STAFF), asyncH(async (_req, res) => {
  if (Date.now() - dashCache.at < 10_000 && dashCache.data) return res.json(dashCache.data);
  if (!dashCache.pending) dashCache.pending = buildDashboard().then((d) => { dashCache = { at: Date.now(), data: d, pending: null }; return d; }, (e) => { dashCache.pending = null; throw e; });
  res.json(await dashCache.pending);
}));

async function buildDashboard() {
  const [byStatus, money, shipments, sync, lots, aging] = await Promise.all([
    query('SELECT status, count(*)::int AS n FROM vehicles GROUP BY status'),
    // مسح واحد لجدول التكاليف مع FILTER بدل المرور عبر العرض المجمّع لكل سيارة
    query(`SELECT COALESCE(sum(c.amount_lyd) FILTER (WHERE v.status NOT IN ('SOLD','DELIVERED','CANCELLED')),0) AS inventory_cost_lyd,
                  COALESCE(sum(c.amount_lyd) FILTER (WHERE NOT c.is_paid),0) AS unpaid_lyd,
                  (SELECT COALESCE(sum(sale_price_lyd),0) FROM sales) - COALESCE(sum(c.amount_lyd) FILTER (WHERE s.vehicle_id IS NOT NULL),0) AS realized_margin_lyd,
                  (SELECT COALESCE(sum(sale_price_lyd),0) FROM sales) AS sales_lyd
             FROM vehicle_costs c JOIN vehicles v ON v.id = c.vehicle_id LEFT JOIN sales s ON s.vehicle_id = c.vehicle_id
            WHERE c.voided_at IS NULL`),
    query(`SELECT sh.id, sh.shipment_no, sh.container_no, sh.status, sh.eta, sh.vessel_name, pod.name_ar AS pod,
                  (SELECT count(*)::int FROM shipment_vehicles sv WHERE sv.shipment_id = sh.id) AS cars
             FROM shipments sh JOIN ports pod ON pod.id = sh.pod_port_id
            WHERE sh.status NOT IN ('CLOSED','CANCELLED') ORDER BY sh.eta NULLS LAST LIMIT 6`),
    query(`SELECT s.code, s.name, s.last_success_at, s.consecutive_failures, s.circuit_open_until,
                  (SELECT count(*)::int FROM sync_dead_letters d WHERE d.source_id = s.id AND d.resolved_at IS NULL) AS open_errors
             FROM external_sources s WHERE s.code IN ('COPART','IAAI','TRACKING') ORDER BY s.id`),
    query(`SELECT count(*) FILTER (WHERE status = 'OPEN')::int AS open_lots, COALESCE(sum(bid_count) FILTER (WHERE status = 'OPEN'),0)::int AS open_bids FROM auction_lots`),
    query(`SELECT status, round(avg(extract(epoch FROM now() - status_changed_at) / 86400)::numeric, 1) AS avg_days
             FROM vehicles WHERE status IN ('AT_PORT_LIBYA','IN_CUSTOMS','IN_STOCK','AWAITING_PICKUP') GROUP BY status`),
  ]);
  return { byStatus: byStatus.rows, money: money.rows[0], shipments: shipments.rows, sync: sync.rows, auctions: lots.rows[0], aging: aging.rows, generatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- السيارات
api.get('/vehicles', requireAuth, asyncH(async (req, res) => {
  const forBidder = req.user.role === 'BIDDER';
  const r = await listVehicles({ ...req.query, forBidder }, { includeCosts: ROLES.COST_READERS.includes(req.user.role) });
  res.json(r);
}));

api.get('/vehicles/compare', requireAuth, asyncH(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(isUuid).slice(0, 4);
  if (ids.length < 2) throw new HttpError(422, 'VALIDATION', 'اختر سيارتين على الأقل للمقارنة');
  const staff = isStaff(req.user);
  res.json({ items: await compareVehicles(ids, { includeCosts: staff && ROLES.COST_READERS.includes(req.user.role), includeInternal: staff }) });
}));

api.get('/vehicles/:id', requireAuth, uuidParam('id'), asyncH(async (req, res) => {
  const staff = isStaff(req.user);
  const v = await getVehicle(req.params.id, { includeCosts: ROLES.COST_READERS.includes(req.user.role), includeInternal: staff });
  if (!staff && !['IN_AUCTION', 'IN_STOCK', 'SOLD'].includes(v.status)) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير متاحة');
  res.json(v);
}));

const vehicleFields = {
  year: t.int({ min: 1950, max: new Date().getFullYear() + 1 }), make: t.string({ max: 60 }), model: t.string({ max: 80 }), trim: t.string({ max: 80 }),
  bodyStyle: t.string({ max: 40 }), exteriorColor: t.string({ max: 40 }), odometer: t.int({ min: 0, max: 2_000_000 }), odometerUnit: t.enum(['mi', 'km']),
  titleType: t.enum(TITLES), primaryDamage: t.string({ max: 80 }), hasKeys: t.bool(), runAndDrive: t.bool(), notes: t.string({ max: 1000 }),
};

const vinLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (req) => req.user.id, code: 'TOO_MANY_LOOKUPS' });
api.get('/vin/:vin/decode', requireRole(ROLES.LOGISTICS_WRITERS), vinLimiter, asyncH(async (req, res) => res.json(await decodeVin(req.params.vin))));

api.post('/vehicles', requireRole(ROLES.LOGISTICS_WRITERS), asyncH(async (req, res) => {
  const b = validate(req.body, {
    ...vehicleFields, vin: t.string({ required: true, min: 17, max: 17 }),
    year: { ...vehicleFields.year, required: true }, make: { ...vehicleFields.make, required: true }, model: { ...vehicleFields.model, required: true },
    source: t.enum(['COPART', 'IAAI', 'OTHER']), lotNumber: t.string({ max: 20, pattern: /^\d{4,12}$/ }), purchaseDate: t.date(),
    purchasePriceUsd: t.decimal({ positive: true }), buyerFeeUsd: t.decimal(), otherFeesUsd: t.decimal(), destinationPort: t.string({ max: 10 }),
    customerId: t.uuid(), customerPrice: t.decimal({ positive: true }), customerCurrency: t.enum(['USD', 'LYD', 'EUR']), vendorId: t.uuid(),
  });
  if (b.customerPrice && !b.customerId) throw new HttpError(422, 'PRICE_WITHOUT_CUSTOMER', 'اختر العميل قبل إدخال السعر المتفق عليه');
  res.status(201).json(await createVehicle(b, actorOf(req)));
}));

api.patch('/vehicles/:id', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, {
    ...vehicleFields, interiorColor: t.string({ max: 40 }), engine: t.string({ max: 60 }), transmission: t.string({ max: 40 }), driveType: t.string({ max: 20 }),
    fuelType: t.string({ max: 30 }), titleState: t.string({ max: 2 }), secondaryDamage: t.string({ max: 80 }), conditionGrade: t.decimal(), listPriceLyd: t.decimal(), version: t.int({ min: 1 }),
  });
  res.json(await updateVehicle(req.params.id, b, actorOf(req)));
}));

api.post('/vehicles/:id/status', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { to: t.enum(STATUS_CODES, { required: true }), reason: t.string({ max: 500 }), version: t.int({ min: 1 }) });
  if (b.to === 'IN_AUCTION') throw new HttpError(422, 'SYSTEM_ONLY', 'هذه الحالة تُضبط تلقائيًا عبر المزاد');
  if (b.to === 'SOLD') {
    // سيارة مشتراة لعميل (طلب مسبق) تُعلَّم مباعة يدويًا عند تسليمها؛ غيرها تُباع عبر المزاد أو البيع المباشر فقط
    const { rows: [r] } = await query('SELECT customer_id FROM vehicles WHERE id = $1', [req.params.id]);
    if (!r?.customer_id) throw new HttpError(422, 'SYSTEM_ONLY', 'هذه الحالة تُضبط تلقائيًا عبر المزاد أو البيع');
  }
  const r = await tx((c) => changeStatus(c, req.params.id, b.to, { actorId: req.user.id, reason: b.reason, expectedVersion: b.version, ip: req.ip }));
  res.json(r);
}));

// الصورة: المرفوعة يدويًا تُعرض من القاعدة، وإلا رسم توضيحي (بيانات العرض التجريبية).
// المسار القديم بامتداد .svg يبقى يعمل للروابط المحفوظة
const serveVehicleImage = asyncH(async (req, res) => {
  const { rows: [r] } = await query(
    `SELECT v.stock_no, v.year, v.make, v.model, v.exterior_color, v.body_style, v.primary_damage, v.engine, v.title_state, i.sort_order, i.content, i.mime, i.sha256
       FROM vehicle_images i JOIN vehicles v ON v.id = i.vehicle_id WHERE i.id = $1 AND v.id = $2`, [req.params.imageId, req.params.id]);
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  res.set('Cache-Control', 'private, max-age=86400, immutable');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  if (r.content && ['image/jpeg', 'image/png', 'image/webp'].includes(r.mime)) {
    res.set('Content-Type', r.mime);
    res.set('ETag', `"${r.sha256}"`);
    return res.send(r.content);
  }
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(renderVehicleSvg(r, r.sort_order));
});
api.get('/media/vehicles/:id/:imageId.svg', requireAuth, uuidParam('id'), uuidParam('imageId'), serveVehicleImage);
api.get('/media/vehicles/:id/:imageId', requireAuth, uuidParam('id'), uuidParam('imageId'), serveVehicleImage);

const imageLimiter = rateLimit({ windowMs: 60_000, max: 60, key: (req) => req.user.id, code: 'TOO_MANY_UPLOADS' });
api.post('/vehicles/:id/images', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), imageLimiter, asyncH(async (req, res) => {
  const b = validate(req.body, {
    data: t.string({ required: true, max: 7_200_000 }),
    kind: t.enum(['EXTERIOR', 'INTERIOR', 'DAMAGE', 'ENGINE', 'UNDERCARRIAGE', 'DOCUMENT', 'OTHER']),
    caption: t.string({ max: 200 }), width: t.int({ min: 1, max: 20000 }), height: t.int({ min: 1, max: 20000 }),
  });
  res.status(201).json(await addVehicleImage(req.params.id, b, actorOf(req)));
}));
api.delete('/vehicles/:id/images/:imageId', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), uuidParam('imageId'), asyncH(async (req, res) => {
  res.json(await deleteVehicleImage(req.params.id, req.params.imageId, actorOf(req)));
}));
api.post('/vehicles/:id/images/:imageId/primary', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), uuidParam('imageId'), asyncH(async (req, res) => {
  res.json(await setPrimaryImage(req.params.id, req.params.imageId, actorOf(req)));
}));

// ---------------------------------------------------------------- التكاليف
const costSchema = {
  categoryCode: t.string({ required: true, max: 40 }),
  vendorId: t.uuid(),
  description: t.string({ max: 300 }),
  amount: t.decimal({ required: true, positive: true }),
  currency: t.enum(['USD', 'LYD', 'EUR'], { required: true }),
  fxRateToLyd: t.decimal({ positive: true }),
  status: t.enum(['ESTIMATED', 'ACTUAL']),
  invoiceRef: t.string({ max: 80 }),
  incurredAt: t.date({ required: true }),
  isPaid: t.bool(),
};

api.get('/vehicles/:id/costs', requireRole(ROLES.COST_READERS), uuidParam('id'), asyncH(async (req, res) => {
  res.json(await getVehicleCosts(req.params.id));
}));

api.post('/vehicles/:id/costs', requireRole(ROLES.COST_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, costSchema);
  res.status(201).json(await addCost(req.params.id, b, actorOf(req)));
}));

api.post('/costs/:id/void', requireRole(['ADMIN', 'ACCOUNTANT']), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { reason: t.string({ required: true, min: 3, max: 300 }) });
  res.json(await voidCost(req.params.id, b.reason, actorOf(req)));
}));

api.get('/reports/costs', requireRole(ROLES.COST_READERS), asyncH(async (req, res) => {
  res.json(await costReport(pickReportFilters(req.query)));
}));

api.get('/reports/costs.xlsx', requireRole(ROLES.COST_READERS), asyncH(async (req, res) => {
  const buf = await costReportXlsx(pickReportFilters(req.query), req.user);
  await audit(null, { actorId: req.user.id, action: 'REPORT_EXPORTED', entity: 'report', entityId: 'costs.xlsx', after: req.query, ip: req.ip });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="vehicle-costs-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(Buffer.from(buf));
}));

api.get('/reports/costs.csv', requireRole(ROLES.COST_READERS), asyncH(async (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="vehicle-costs-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(await costReportCsv(pickReportFilters(req.query)));
}));

function pickReportFilters(q) {
  const f = {};
  if (q.status) f.status = String(q.status).split(',').filter((s) => STATUS_CODES.includes(s)).join(',') || undefined;
  if (q.make) f.make = String(q.make).slice(0, 40);
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) f.from = q.from;
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) f.to = q.to;
  if (q.shipment) f.shipment = String(q.shipment).slice(0, 30);
  return f;
}

// ---------------------------------------------------------------- الشحن والجمارك
api.get('/shipments', requireRole(ROLES.STAFF), asyncH(async (_req, res) => {
  const { rows } = await query(
    `SELECT sh.id, sh.shipment_no, sh.booking_no, sh.bill_of_lading, sh.container_no, sh.container_type, sh.capacity, sh.vessel_name, sh.voyage_no,
            sh.etd, sh.atd, sh.eta, sh.ata, sh.status, sh.last_tracking_at, pol.name_ar AS pol, pod.name_ar AS pod, c.name AS carrier,
            COALESCE(json_agg(json_build_object('id', v.id, 'stock_no', v.stock_no, 'title', v.year || ' ' || v.make || ' ' || v.model, 'status', v.status)
                     ORDER BY sv.position) FILTER (WHERE v.id IS NOT NULL), '[]') AS vehicles,
            (SELECT json_build_object('code', e.event_code, 'description', e.description, 'location', e.location, 'at', e.occurred_at)
               FROM shipment_events e WHERE e.shipment_id = sh.id ORDER BY e.occurred_at DESC LIMIT 1) AS last_event
       FROM shipments sh JOIN ports pol ON pol.id = sh.pol_port_id JOIN ports pod ON pod.id = sh.pod_port_id
       LEFT JOIN vendors c ON c.id = sh.carrier_id
       LEFT JOIN shipment_vehicles sv ON sv.shipment_id = sh.id LEFT JOIN vehicles v ON v.id = sv.vehicle_id
      GROUP BY sh.id, pol.name_ar, pod.name_ar, c.name ORDER BY sh.etd DESC NULLS LAST`);
  res.json({ items: rows });
}));

api.post('/shipments/:id/shared-costs', requireRole(ROLES.COST_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, {
    categoryCode: t.string({ required: true, max: 40 }), vendorId: t.uuid(), description: t.string({ max: 300 }),
    totalAmount: t.decimal({ required: true, positive: true }), currency: t.enum(['USD', 'LYD', 'EUR'], { required: true }),
    fxRateToLyd: t.decimal({ positive: true }), method: t.enum(['EQUAL', 'BY_PURCHASE_VALUE'], { required: true }), incurredAt: t.date({ required: true }),
  });
  res.status(201).json(await addSharedCost(req.params.id, b, actorOf(req)));
}));

api.get('/customs', requireRole(ROLES.STAFF), asyncH(async (_req, res) => {
  const { rows } = await query(
    `SELECT cd.id, cd.vehicle_id, cd.declaration_no, cd.status, cd.submitted_at, cd.assessed_value_lyd, cd.duty_amount_lyd, cd.released_at, cd.rejection_reason,
            p.name_ar AS port, b.name AS broker, v.stock_no, v.vin, v.year || ' ' || v.make || ' ' || v.model AS title, v.status AS vehicle_status,
            round(extract(epoch FROM now() - COALESCE(cd.submitted_at, cd.updated_at)) / 86400) AS days_open
       FROM customs_declarations cd JOIN vehicles v ON v.id = cd.vehicle_id JOIN ports p ON p.id = cd.port_id
       LEFT JOIN vendors b ON b.id = cd.broker_id ORDER BY cd.updated_at DESC`);
  res.json({ items: rows });
}));

api.patch('/customs/:id', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, {
    status: t.enum(['DOCS_PENDING', 'SUBMITTED', 'INSPECTION', 'ASSESSED', 'DUTY_PAID', 'RELEASED', 'REJECTED'], { required: true }),
    declarationNo: t.string({ max: 60 }), assessedValueLyd: t.decimal(), dutyAmountLyd: t.decimal(), rejectionReason: t.string({ max: 300 }),
  });
  const out = await tx(async (c) => {
    const { rows: [cd] } = await c.query('SELECT * FROM customs_declarations WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!cd) throw new HttpError(404, 'NOT_FOUND', 'البيان غير موجود');
    if (b.status === 'REJECTED' && !b.rejectionReason) throw new HttpError(422, 'VALIDATION', 'سبب الرفض مطلوب');
    const { rows: [upd] } = await c.query(
      `UPDATE customs_declarations SET status = $2::customs_status, declaration_no = COALESCE($3, declaration_no), assessed_value_lyd = COALESCE($4, assessed_value_lyd),
              duty_amount_lyd = COALESCE($5, duty_amount_lyd), rejection_reason = $6,
              submitted_at = CASE WHEN $2::customs_status = 'SUBMITTED' AND submitted_at IS NULL THEN now() ELSE submitted_at END,
              released_at = CASE WHEN $2::customs_status = 'RELEASED' THEN now() ELSE released_at END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [cd.id, b.status, b.declarationNo, b.assessedValueLyd, b.dutyAmountLyd, b.rejectionReason || null]);
    // الرسم الجمركي يُسجَّل تلقائيًا كتكلفة على السيارة عند السداد (مرة واحدة)
    if (b.status === 'DUTY_PAID' && upd.duty_amount_lyd) {
      const { rows: ex } = await c.query(`SELECT 1 FROM vehicle_costs WHERE vehicle_id = $1 AND category_code = 'CUSTOMS_DUTY' AND voided_at IS NULL`, [cd.vehicle_id]);
      if (!ex.length) await c.query(
        `INSERT INTO vehicle_costs (vehicle_id, category_code, description, amount, currency, fx_rate_to_lyd, incurred_at, invoice_ref, is_paid, created_by)
         VALUES ($1,'CUSTOMS_DUTY','رسم جمركي — بيان ' || COALESCE($3,'-'), $2, 'LYD', 1, current_date, $3, true, $4)`,
        [cd.vehicle_id, upd.duty_amount_lyd, upd.declaration_no, req.user.id]);
    }
    // أي تقدم في البيان بعد المستندات يدخل السيارة "في الجمارك" إن كانت في الميناء، والإفراج يخرجها منها (حتى لو قفز المستخدم مباشرة للإفراج)
    let { rows: [v] } = await c.query('SELECT status FROM vehicles WHERE id = $1', [cd.vehicle_id]);
    if (!['DOCS_PENDING', 'REJECTED'].includes(b.status) && v.status === 'AT_PORT_LIBYA') {
      await changeStatus(c, cd.vehicle_id, 'IN_CUSTOMS', { actorId: req.user.id, reason: 'تقديم البيان الجمركي', ip: req.ip });
      v = { status: 'IN_CUSTOMS' };
    }
    if (b.status === 'RELEASED' && v.status === 'IN_CUSTOMS')
      await changeStatus(c, cd.vehicle_id, 'CUSTOMS_CLEARED', { actorId: req.user.id, reason: `إفراج جمركي — بيان ${upd.declaration_no || ''}`, ip: req.ip });
    await audit(c, { actorId: req.user.id, action: 'CUSTOMS_UPDATED', entity: 'customs_declaration', entityId: cd.id, before: { status: cd.status }, after: { status: b.status }, ip: req.ip });
    return upd;
  });
  res.json(out);
}));

// ---------------------------------------------------------------- المزادات
const bidLimiter = rateLimit({ windowMs: 10_000, max: 15, key: (req) => `bid|${req.user?.id}`, code: 'BID_RATE_LIMITED' });

function bidderCustomer(req, bodyCustomerId) {
  if (req.user.role === 'BIDDER') return req.user.customer_id;
  if (!bodyCustomerId) throw new HttpError(422, 'VALIDATION', 'حدد العميل الذي تزايد نيابة عنه');
  return bodyCustomerId;
}

api.get('/auctions', requireAuth, asyncH(async (req, res) => {
  res.json({ events: await listAuctions({ forBidder: req.user.role === 'BIDDER', customerId: req.user.customer_id }) });
}));

api.get('/lots/:id', requireAuth, uuidParam('id'), asyncH(async (req, res) => {
  res.json(await getLot(req.params.id, { forBidder: req.user.role === 'BIDDER', customerId: req.user.customer_id }));
}));

api.get('/lots/:id/stream', requireAuth, uuidParam('id'), (req, res) => subscribe(req, res, req.params.id));
api.get('/auctions/stream', requireAuth, (req, res) => subscribe(req, res, '*'));

api.post('/lots/:id/bids', requireRole(ROLES.BIDDERS), uuidParam('id'), bidLimiter, asyncH(async (req, res) => {
  const b = validate(req.body, { amount: t.decimal({ required: true, positive: true }), idempotencyKey: t.string({ max: 64, pattern: /^[\w-]+$/ }), customerId: t.uuid() });
  res.status(201).json(await placeBid(req.params.id, { ...b, customerId: bidderCustomer(req, b.customerId) }, actorOf(req)));
}));

api.put('/lots/:id/proxy', requireRole(ROLES.BIDDERS), uuidParam('id'), bidLimiter, asyncH(async (req, res) => {
  const b = validate(req.body, { maxAmount: t.decimal({ required: true, positive: true }), customerId: t.uuid() });
  res.json(await setProxy(req.params.id, { ...b, customerId: bidderCustomer(req, b.customerId) }, actorOf(req)));
}));

api.post('/auctions/:id/lots', requireRole(ROLES.AUCTION_MANAGERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { vehicleId: t.uuid({ required: true }), startingPrice: t.decimal({ required: true, positive: true }), reservePrice: t.decimal({ positive: true }) });
  res.status(201).json(await createLot(req.params.id, b, actorOf(req)));
}));

// ---------------------------------------------------------------- العملاء (بيانات حساسة مقنّعة)
api.get('/customers', requireRole(['ADMIN', 'SALES', 'ACCOUNTANT', 'OPERATIONS']), asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.code, c.full_name, c.customer_type, c.city, c.kyc_status, c.phone_enc,
            (SELECT count(*)::int FROM sales s WHERE s.customer_id = c.id) AS purchases
       FROM customers c
      WHERE ($1::text IS NULL OR c.full_name ILIKE '%' || $1 || '%' OR c.code ILIKE '%' || $1 || '%')
      ORDER BY c.code LIMIT 200`, [req.query.q ? String(req.query.q).slice(0, 60) : null]);
  res.json({ items: rows.map(({ phone_enc, ...c }) => ({ ...c, phone: mask(decrypt(phone_enc)) })) });
}));

// ---------------------------------------------------------------- حسابات العملاء والموردين
const DEAL_WRITERS = ['ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES'];
const CUSTOMER_ACC_READERS = ['ADMIN', 'ACCOUNTANT', 'SALES', 'VIEWER'];
const VENDOR_ACC_READERS = ['ADMIN', 'ACCOUNTANT', 'OPERATIONS', 'VIEWER'];
const ACC_WRITERS = ['ADMIN', 'ACCOUNTANT'];
const paymentSchema = {
  amount: t.decimal({ required: true, positive: true }), currency: t.enum(['USD', 'LYD', 'EUR'], { required: true }),
  settleCurrency: t.enum(['USD', 'LYD', 'EUR']), fxRate: t.decimal({ positive: true }), vehicleId: t.uuid(),
  method: t.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER'], { required: true }), reference: t.string({ max: 80 }),
  note: t.string({ max: 300 }), paidAt: t.date(),
};
api.put('/vehicles/:id/deal', requireRole(DEAL_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { customerId: t.uuid({ nullable: true }), customerPrice: t.decimal({ positive: true, nullable: true }), customerCurrency: t.enum(['USD', 'LYD', 'EUR']), vendorId: t.uuid({ nullable: true }) });
  if (b.customerPrice && b.customerId === null) throw new HttpError(422, 'PRICE_WITHOUT_CUSTOMER', 'اختر العميل قبل إدخال السعر المتفق عليه');
  res.json(await setVehicleDeal(req.params.id, b, actorOf(req)));
}));
api.get('/vehicles/:id/deal', requireRole(ROLES.STAFF), uuidParam('id'), asyncH(async (req, res) => {
  const d = await vehicleDeal(req.params.id);
  if (!d) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
  // كل دور يرى الجانب الذي يخصه فقط
  if (!CUSTOMER_ACC_READERS.includes(req.user.role) && d.customer) d.customer = { id: d.customer.id, code: d.customer.code, name: d.customer.name };
  if (!VENDOR_ACC_READERS.includes(req.user.role) && d.vendor) d.vendor = { id: d.vendor.id, name: d.vendor.name };
  res.json(d);
}));
api.get('/accounts/customers', requireRole(CUSTOMER_ACC_READERS), asyncH(async (req, res) => res.json({ items: await customerBalances(req.query.q ? String(req.query.q).slice(0, 60) : null) })));
api.get('/accounts/vendors', requireRole(VENDOR_ACC_READERS), asyncH(async (req, res) => res.json({ items: await vendorBalances(req.query.q ? String(req.query.q).slice(0, 60) : null) })));
api.get('/accounts/customers/:id', requireRole(CUSTOMER_ACC_READERS), uuidParam('id'), asyncH(async (req, res) => res.json(await customerAccount(req.params.id))));
api.get('/accounts/vendors/:id', requireRole(VENDOR_ACC_READERS), uuidParam('id'), asyncH(async (req, res) => res.json(await vendorAccount(req.params.id))));
api.post('/accounts/customers/:id/payments', requireRole([...ACC_WRITERS, 'SALES']), uuidParam('id'), asyncH(async (req, res) => {
  res.status(201).json(await addAccountPayment('CUSTOMER', req.params.id, validate(req.body, paymentSchema), actorOf(req)));
}));
api.post('/accounts/vendors/:id/payments', requireRole(ACC_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  res.status(201).json(await addAccountPayment('VENDOR', req.params.id, validate(req.body, paymentSchema), actorOf(req)));
}));
api.get('/account-payments/:id/receipt', requireRole(ROLES.STAFF), uuidParam('id'), asyncH(async (req, res) => {
  const r = await paymentReceipt(req.params.id);
  // الإيصال يتبع صلاحية قراءة حساب طرفه
  const readers = r.payment.partyType === 'CUSTOMER' ? CUSTOMER_ACC_READERS : VENDOR_ACC_READERS;
  if (!readers.includes(req.user.role)) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية هذا الإجراء');
  res.json(r);
}));
api.get('/accounts/overview', requireRole([...new Set([...CUSTOMER_ACC_READERS, ...VENDOR_ACC_READERS])]), asyncH(async (req, res) => {
  res.json(await accountsOverview({ customers: CUSTOMER_ACC_READERS.includes(req.user.role), vendors: VENDOR_ACC_READERS.includes(req.user.role) }));
}));

// ---------------------------------------------------------------- مصاريف الشركة والربح الشهري
const FIN_READERS = ['ADMIN', 'ACCOUNTANT', 'VIEWER'];
const monthQ = (req) => (req.query.month ? String(req.query.month).slice(0, 7) : null);
api.get('/expenses', requireRole(FIN_READERS), asyncH(async (req, res) => res.json(await listExpenses(monthQ(req)))));
api.post('/expenses', requireRole(ACC_WRITERS), asyncH(async (req, res) => {
  const b = validate(req.body, {
    category: t.enum(Object.keys(EXPENSE_CATEGORIES), { required: true }), description: t.string({ required: true, min: 2, max: 300 }),
    amount: t.decimal({ required: true, positive: true }), currency: t.enum(['USD', 'LYD', 'EUR'], { required: true }), fxRateToLyd: t.decimal({ positive: true }),
    expenseDate: t.date(), method: t.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER']), reference: t.string({ max: 80 }),
  });
  res.status(201).json(await addExpense(b, actorOf(req)));
}));
api.post('/expenses/:id/void', requireRole(ACC_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { reason: t.string({ required: true, min: 3, max: 300 }) });
  res.json(await voidExpense(req.params.id, b.reason, actorOf(req)));
}));
api.get('/reports/profit', requireRole(FIN_READERS), asyncH(async (req, res) => res.json(await profitReport(monthQ(req)))));

api.post('/account-payments/:id/void', requireRole(ACC_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { reason: t.string({ required: true, min: 3, max: 300 }) });
  res.json(await voidAccountPayment(req.params.id, b.reason, actorOf(req)));
}));

// ---------------------------------------------------------------- التكامل والمزامنة
api.get('/integrations', requireRole(ROLES.STAFF), asyncH(async (_req, res) => {
  const [sources, jobs, dead] = await Promise.all([
    query(`SELECT id, code, name, adapter, is_active, sync_interval_sec, last_success_at, last_cursor, consecutive_failures, circuit_open_until FROM external_sources ORDER BY id`),
    query(`SELECT j.id, s.code AS source, j.job_type, j.status, j.triggered_by, j.items_seen, j.items_created, j.items_updated, j.items_unchanged,
                  j.items_failed, j.error, j.started_at, j.finished_at, extract(epoch FROM j.finished_at - j.started_at)::numeric(10,2) AS seconds
             FROM sync_jobs j JOIN external_sources s ON s.id = j.source_id ORDER BY j.id DESC LIMIT 30`),
    query(`SELECT d.id, s.code AS source, d.external_ref, d.error, d.attempts, d.created_at FROM sync_dead_letters d
             JOIN external_sources s ON s.id = d.source_id WHERE d.resolved_at IS NULL ORDER BY d.id DESC LIMIT 50`),
  ]);
  res.json({ sources: sources.rows, jobs: jobs.rows, deadLetters: dead.rows });
}));

const needIntegrations = (_req, _res, next) => (config.integrationsEnabled ? next() : next(new HttpError(404, 'INTEGRATIONS_OFF', 'الربط الآلي غير مفعّل')));

api.post('/integrations/:code/sync', requireRole(['ADMIN', 'OPERATIONS']), needIntegrations, asyncH(async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!['COPART', 'IAAI', 'TRACKING'].includes(code)) throw new HttpError(404, 'NOT_FOUND', 'مصدر غير معروف');
  try {
    const r = code === 'TRACKING' ? await syncTracking({ triggeredBy: `USER:${req.user.id}` }) : await syncPurchases(code, { triggeredBy: `USER:${req.user.id}` });
    await audit(null, { actorId: req.user.id, action: 'SYNC_TRIGGERED', entity: 'external_source', entityId: code, after: r, ip: req.ip });
    res.json(r);
  } catch (e) {
    if (e instanceof SyncBusy || e instanceof CircuitOpen) throw new HttpError(409, 'SYNC_BUSY', e.message);
    throw e;
  }
}));

api.post('/integrations/csv', requireRole(['ADMIN', 'OPERATIONS']), express.text({ type: 'text/csv', limit: '5mb' }), asyncH(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) throw new HttpError(422, 'VALIDATION', 'الملف فارغ');
  try {
    res.json(await importCsv(req.body, actorOf(req)));
  } catch (e) {
    if (e instanceof SyncBusy) throw new HttpError(409, 'SYNC_BUSY', e.message);
    throw e;
  }
}));

api.post('/integrations/dead-letters/:id/retry', requireRole(['ADMIN', 'OPERATIONS']), asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
  res.json(await retryDeadLetter(id, actorOf(req)));
}));

// ---------------------------------------------------------------- التدقيق
api.get('/audit', requireRole(['ADMIN']), asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.after_data, a.ip, a.at, u.full_name AS actor
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 100`);
  res.json({ items: rows });
}));

api.use(ops);
