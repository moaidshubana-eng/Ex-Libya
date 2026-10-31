// العملاء، المزادات (إنشاء/تسجيل المزايدين/التأمين)، البيع المباشر والدفعات
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { encrypt, lookupHash } from '../security/crypto.js';
import { changeStatus } from './vehicles.js';
import { publish } from './realtime.js';

// ------------------------------------------------------------------ العملاء
export async function createCustomer(b, actor) {
  if (b.phone && (await query('SELECT 1 FROM customers WHERE phone_hash = $1', [lookupHash(b.phone)])).rowCount)
    throw new HttpError(409, 'DUPLICATE_PHONE', 'يوجد عميل مسجل بنفس رقم الهاتف');
  if (b.nationalId && (await query('SELECT 1 FROM customers WHERE national_id_hash = $1', [lookupHash(b.nationalId)])).rowCount)
    throw new HttpError(409, 'DUPLICATE_ID', 'يوجد عميل مسجل بنفس رقم الهوية');
  const { rows: [c] } = await query(
    `INSERT INTO customers (code, full_name, customer_type, phone_enc, phone_hash, national_id_enc, national_id_hash, email, city, notes)
     VALUES ('C-' || lpad(nextval('customer_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, code, full_name`,
    [b.fullName, b.customerType || 'INDIVIDUAL', encrypt(b.phone), lookupHash(b.phone), encrypt(b.nationalId), lookupHash(b.nationalId), b.email || null, b.city || null, b.notes || null]);
  await audit(null, { actorId: actor.id, action: 'CUSTOMER_CREATED', entity: 'customer', entityId: c.id, after: { code: c.code }, ip: actor.ip });
  return c;
}

// ------------------------------------------------------------------ المزادات
export async function createAuctionEvent(b, actor) {
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw new HttpError(422, 'BAD_TIMES', 'وقت النهاية يجب أن يكون بعد وقت البداية');
  if (new Date(b.endsAt) <= new Date()) throw new HttpError(422, 'PAST', 'وقت النهاية في الماضي');
  const { rows: [e] } = await query(
    `INSERT INTO auction_events (title, starts_at, ends_at, status, deposit_required_lyd, anti_snipe_window_sec, extension_sec, terms, created_by)
     VALUES ($1,$2,$3,'SCHEDULED',$4,$5,$6,$7,$8) RETURNING *`,
    [b.title, b.startsAt, b.endsAt, b.depositRequiredLyd || '0', b.antiSnipeWindowSec ?? 120, b.extensionSec ?? 120, b.terms || null, actor.id]);
  await audit(null, { actorId: actor.id, action: 'AUCTION_CREATED', entity: 'auction_event', entityId: e.id, after: e, ip: actor.ip });
  return e;
}

/** إلغاء مزاد: يُسمح فقط إن لم تُسجَّل أي مزايدة؛ تعود سياراته للمعرض ويُفرج عن التأمينات */
export async function cancelAuctionEvent(id, actor) {
  return tx(async (c) => {
    const { rows: [e] } = await c.query('SELECT * FROM auction_events WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'المزاد غير موجود');
    if (['CLOSED', 'CANCELLED'].includes(e.status)) throw new HttpError(422, 'FINISHED', 'المزاد منتهٍ أو ملغى مسبقًا');
    const { rows: lots } = await c.query(`SELECT id, vehicle_id, bid_count FROM auction_lots WHERE auction_event_id = $1 AND status IN ('PENDING','OPEN') FOR UPDATE`, [id]);
    if (lots.some((l) => l.bid_count > 0)) throw new HttpError(422, 'HAS_BIDS', 'لا يُلغى مزاد عليه مزايدات');
    for (const l of lots) {
      await c.query(`UPDATE auction_lots SET status = 'CANCELLED', closed_at = now() WHERE id = $1`, [l.id]);
      await changeStatus(c, l.vehicle_id, 'IN_STOCK', { actorId: actor.id, source: 'SYSTEM', reason: `إلغاء المزاد: ${e.title}` });
    }
    await c.query(`UPDATE bidder_registrations SET deposit_status = 'RELEASED' WHERE auction_event_id = $1 AND deposit_status IN ('PENDING','HELD')`, [id]);
    await c.query(`UPDATE auction_events SET status = 'CANCELLED' WHERE id = $1`, [id]);
    await audit(c, { actorId: actor.id, action: 'AUCTION_CANCELLED', entity: 'auction_event', entityId: id, ip: actor.ip });
    return { id, cancelledLots: lots.length };
  });
}

export async function cancelLot(lotId, actor) {
  return tx(async (c) => {
    const { rows: [l] } = await c.query(`SELECT * FROM auction_lots WHERE id = $1 FOR UPDATE`, [lotId]);
    if (!l) throw new HttpError(404, 'NOT_FOUND', 'اللوت غير موجود');
    if (!['PENDING', 'OPEN'].includes(l.status)) throw new HttpError(422, 'FINISHED', 'اللوت منتهٍ');
    if (l.bid_count > 0) throw new HttpError(422, 'HAS_BIDS', 'لا يُسحب لوت عليه مزايدات');
    await c.query(`UPDATE auction_lots SET status = 'CANCELLED', closed_at = now() WHERE id = $1`, [lotId]);
    await changeStatus(c, l.vehicle_id, 'IN_STOCK', { actorId: actor.id, source: 'SYSTEM', reason: 'سحب من المزاد' });
    await audit(c, { actorId: actor.id, action: 'LOT_CANCELLED', entity: 'auction_lot', entityId: lotId, ip: actor.ip });
    await publish(c, { type: 'closed', lotId, sold: false, reason: 'CANCELLED', currentPrice: null });
    return { id: lotId };
  });
}

export async function listRegistrations(eventId) {
  const { rows } = await query(
    `SELECT r.id, r.paddle_no, r.deposit_amount_lyd, r.deposit_status, r.approved_at, c.id AS customer_id, c.code, c.full_name, u.full_name AS approved_by
       FROM bidder_registrations r JOIN customers c ON c.id = r.customer_id LEFT JOIN users u ON u.id = r.approved_by
      WHERE r.auction_event_id = $1 ORDER BY r.paddle_no`, [eventId]);
  return rows;
}

export async function registerBidder(eventId, customerId, actor) {
  return tx(async (c) => {
    const { rows: [e] } = await c.query('SELECT id, status, deposit_required_lyd FROM auction_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'المزاد غير موجود');
    if (['CLOSED', 'CANCELLED'].includes(e.status)) throw new HttpError(422, 'FINISHED', 'المزاد منتهٍ');
    const { rows: [cu] } = await c.query('SELECT id, kyc_status FROM customers WHERE id = $1', [customerId]);
    if (!cu) throw new HttpError(404, 'NO_CUSTOMER', 'العميل غير موجود');
    if (['REJECTED', 'SUSPENDED'].includes(cu.kyc_status)) throw new HttpError(422, 'KYC', 'العميل موقوف أو مرفوض');
    if ((await c.query('SELECT 1 FROM bidder_registrations WHERE auction_event_id = $1 AND customer_id = $2', [eventId, customerId])).rowCount)
      throw new HttpError(409, 'ALREADY', 'العميل مسجل في هذا المزاد');
    const { rows: [r] } = await c.query(
      `INSERT INTO bidder_registrations (auction_event_id, customer_id, paddle_no, deposit_amount_lyd, deposit_status)
       VALUES ($1,$2,(SELECT COALESCE(max(paddle_no), 100) + 1 FROM bidder_registrations WHERE auction_event_id = $1),$3,'PENDING') RETURNING *`,
      [eventId, customerId, e.deposit_required_lyd]);
    await audit(c, { actorId: actor.id, action: 'BIDDER_REGISTERED', entity: 'auction_event', entityId: eventId, after: { customerId, paddle: r.paddle_no }, ip: actor.ip });
    return r;
  });
}

const DEPOSIT_FLOW = { PENDING: ['HELD', 'RELEASED'], HELD: ['RELEASED', 'FORFEITED'] };
export async function setDeposit(regId, status, amount, actor) {
  return tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT * FROM bidder_registrations WHERE id = $1 FOR UPDATE', [regId]);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'التسجيل غير موجود');
    if (!(DEPOSIT_FLOW[r.deposit_status] || []).includes(status)) throw new HttpError(422, 'BAD_FLOW', 'هذا التغيير غير مسموح لحالة التأمين الحالية');
    if (status === 'RELEASED') {
      const { rows: lead } = await c.query(
        `SELECT 1 FROM auction_lots WHERE auction_event_id = $1 AND leading_customer_id = $2 AND status IN ('OPEN','PENDING')`, [r.auction_event_id, r.customer_id]);
      if (lead.length) throw new HttpError(422, 'LEADING', 'العميل صاحب أعلى مزايدة على لوت مفتوح؛ لا يُفرج عن تأمينه الآن');
    }
    const { rows: [u] } = await c.query(
      `UPDATE bidder_registrations SET deposit_status = $2::deposit_status, deposit_amount_lyd = COALESCE($3, deposit_amount_lyd),
              approved_by = CASE WHEN $2::deposit_status = 'HELD' THEN $4::uuid ELSE approved_by END, approved_at = CASE WHEN $2::deposit_status = 'HELD' THEN now() ELSE approved_at END
        WHERE id = $1 RETURNING *`, [regId, status, amount || null, actor.id]);
    await audit(c, { actorId: actor.id, action: 'DEPOSIT_' + status, entity: 'bidder_registration', entityId: regId, before: { status: r.deposit_status }, after: { status, amount: u.deposit_amount_lyd }, ip: actor.ip });
    return u;
  });
}

// ------------------------------------------------------------------ البيع المباشر والدفعات
const PRESALE = ['IN_TRANSIT_SEA', 'AT_PORT_LIBYA', 'IN_CUSTOMS', 'CUSTOMS_CLEARED', 'IN_STOCK'];
export async function directSale(vehicleId, { customerId, priceLyd, dueDays }, actor) {
  return tx(async (c) => {
    const { rows: [v] } = await c.query('SELECT id, status FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
    if (!PRESALE.includes(v.status)) throw new HttpError(422, 'NOT_SELLABLE', 'لا تُباع السيارة في حالتها الحالية');
    const { rows: [cu] } = await c.query('SELECT id, kyc_status FROM customers WHERE id = $1', [customerId]);
    if (!cu) throw new HttpError(404, 'NO_CUSTOMER', 'العميل غير موجود');
    if (['REJECTED', 'SUSPENDED'].includes(cu.kyc_status)) throw new HttpError(422, 'KYC', 'العميل موقوف أو مرفوض');
    const { rows: [sale] } = await c.query(
      `INSERT INTO sales (invoice_no, vehicle_id, customer_id, sale_type, sale_price_lyd, payment_due_at, created_by)
       VALUES ('INV-' || to_char(now(),'YYYY') || '-' || lpad(nextval('invoice_seq')::text, 5, '0'), $1,$2,'DIRECT',$3, now() + make_interval(days => $4), $5)
       RETURNING id, invoice_no`, [vehicleId, customerId, priceLyd, dueDays ?? 3, actor.id]);
    await changeStatus(c, vehicleId, 'SOLD', { actorId: actor.id, source: 'SYSTEM', reason: `بيع مباشر — فاتورة ${sale.invoice_no}`, ip: actor.ip });
    await audit(c, { actorId: actor.id, action: 'DIRECT_SALE', entity: 'sale', entityId: sale.id, after: { invoice: sale.invoice_no, priceLyd, customerId }, ip: actor.ip });
    return sale;
  });
}

export async function addPayment(saleId, b, actor) {
  const { rateToLyd } = await import('./costs.js');
  return tx(async (c) => {
    const { rows: [s] } = await c.query('SELECT id, sale_price_lyd, buyer_fee_lyd FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'البيع غير موجود');
    const date = new Date().toISOString().slice(0, 10);
    const fx = b.currency === 'LYD' ? '1' : await rateToLyd(c, b.currency, date);
    const { rows: [p] } = await c.query(
      `INSERT INTO payments (sale_id, amount, currency, fx_rate_to_lyd, method, reference, received_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [saleId, b.amount, b.currency, fx, b.method, b.reference || null, actor.id]);
    const { rows: [t] } = await c.query('SELECT COALESCE(sum(amount * fx_rate_to_lyd), 0)::numeric(14,3) AS paid FROM payments WHERE sale_id = $1', [saleId]);
    const due = Number(s.sale_price_lyd) + Number(s.buyer_fee_lyd);
    if (Number(t.paid) > due * 1.001) throw new HttpError(422, 'OVERPAID', `إجمالي الدفعات (${t.paid}) يتجاوز المستحق (${due.toFixed(3)})`);
    await audit(c, { actorId: actor.id, action: 'PAYMENT_ADDED', entity: 'sale', entityId: saleId, after: { amount: b.amount, currency: b.currency, paid: t.paid }, ip: actor.ip });
    return { payment: p, paidLyd: t.paid, dueLyd: due.toFixed(3), remainingLyd: Math.max(0, due - Number(t.paid)).toFixed(3) };
  });
}
