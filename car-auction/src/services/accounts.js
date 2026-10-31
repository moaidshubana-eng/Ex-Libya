// حسابات العملاء والموردين وكشوفها.
//
// العميل: عليه سعر كل سيارة اشتُريت له (بعملتها المتفق عليها) + فواتير البيع المباشر/المزاد (بالدينار).
//         وله الدفعات على الحساب + دفعات فواتير البيع.
// المورد: له كل تكلفة فعلية (غير ملغاة) مسجلة باسمه على أي سيارة (سعر الشراء والرسوم، الشحن…).
//         وعليه (أي مدفوع له) دفعاتنا على الحساب.
//
// الأرصدة تُحسب لكل عملة على حدة (دولار ودينار ويورو) — لا تحويل ضمني بين العملات. الدفعة بعملة غير عملة
// الرصيد تُحوَّل عند تسجيلها بسعر صرف يُحفظ معها (سعر اليوم افتراضيًا، أو السعر المتفق عليه).
//
// المتبقي على كل سيارة: الدفعات المربوطة بالسيارة تُخصم منها أولًا، ثم الدفعات غير المربوطة تُوزَّع
// على أقدم المستحقات أولًا (FIFO) في نفس العملة.
//
// الحساب بالأعداد الصحيحة (أجزاء الألف) لتفادي أخطاء الكسور العشرية.
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { rateToLyd } from './costs.js';

const toMil = (v) => Math.round(Number(v) * 1000);
const fromMil = (m) => (m / 1000).toFixed(3);
const CURRENCIES = ['USD', 'LYD', 'EUR'];

// ------------------------------------------------------------------ جمع القيود
async function customerEntries(id) {
  const [veh, sales, accPays, salePays] = await Promise.all([
    query(`SELECT v.id AS vehicle_id, v.stock_no, v.year, v.make, v.model, v.status, v.customer_price AS amount, v.customer_currency AS currency,
                  COALESCE(v.customer_assigned_at, v.created_at) AS at
             FROM vehicles v WHERE v.customer_id = $1 AND v.customer_price IS NOT NULL`, [id]),
    query(`SELECT s.id AS sale_id, s.invoice_no, s.vehicle_id, v.stock_no, v.year, v.make, v.model, v.status,
                  (s.sale_price_lyd + s.buyer_fee_lyd) AS amount, s.sold_at AS at, s.sale_type
             FROM sales s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.customer_id = $1`, [id]),
    query(`SELECT p.*, v.stock_no FROM account_payments p LEFT JOIN vehicles v ON v.id = p.vehicle_id
            WHERE p.customer_id = $1 ORDER BY p.paid_at, p.created_at`, [id]),
    query(`SELECT p.id, p.amount, p.currency, p.fx_rate_to_lyd, p.method, p.reference, p.received_at, s.vehicle_id, s.invoice_no, v.stock_no
             FROM payments p JOIN sales s ON s.id = p.sale_id JOIN vehicles v ON v.id = s.vehicle_id
            WHERE s.customer_id = $1 ORDER BY p.received_at`, [id]),
  ]);
  const charges = [
    ...veh.rows.map((r) => ({ key: `V:${r.vehicle_id}`, kind: 'ORDER', date: r.at, vehicleId: r.vehicle_id, stockNo: r.stock_no,
      title: `${r.year} ${r.make} ${r.model}`, status: r.status, currency: r.currency, amount: r.amount, label: `سيارة ${r.stock_no} — ${r.year} ${r.make} ${r.model}` })),
    ...sales.rows.map((r) => ({ key: `S:${r.sale_id}`, kind: 'SALE', date: r.at, vehicleId: r.vehicle_id, stockNo: r.stock_no,
      title: `${r.year} ${r.make} ${r.model}`, status: r.status, currency: 'LYD', amount: r.amount, label: `فاتورة ${r.invoice_no} — ${r.stock_no} ${r.year} ${r.make} ${r.model}` })),
  ];
  const payments = [
    ...accPays.rows.map(accountPaymentRow),
    // دفعات فواتير البيع القديمة تُحتسب بالدينار بسعر صرفها المحفوظ
    ...salePays.rows.map((r) => ({ id: r.id, source: 'SALE_PAYMENT', date: r.received_at, vehicleId: r.vehicle_id, stockNo: r.stock_no,
      amount: r.amount, currency: r.currency, settleCurrency: 'LYD', settleAmount: (Math.round(Number(r.amount) * Number(r.fx_rate_to_lyd) * 1000) / 1000).toFixed(3),
      fxRate: r.currency === 'LYD' ? null : r.fx_rate_to_lyd, method: r.method, reference: r.reference, note: `دفعة على الفاتورة ${r.invoice_no}`, voided: false })),
  ];
  return { charges, payments };
}

async function vendorEntries(id) {
  const [costs, accPays] = await Promise.all([
    query(`SELECT c.id, c.vehicle_id, v.stock_no, v.year, v.make, v.model, v.status, c.amount, c.currency, c.incurred_at AS at, c.description,
                  cc.name_ar AS category, c.invoice_ref, c.created_at, c.is_paid
             FROM vehicle_costs c JOIN vehicles v ON v.id = c.vehicle_id JOIN cost_categories cc ON cc.code = c.category_code
            WHERE c.vendor_id = $1 AND c.voided_at IS NULL AND c.status = 'ACTUAL'
            ORDER BY c.incurred_at, c.created_at`, [id]),
    query(`SELECT p.*, v.stock_no FROM account_payments p LEFT JOIN vehicles v ON v.id = p.vehicle_id
            WHERE p.vendor_id = $1 ORDER BY p.paid_at, p.created_at`, [id]),
  ]);
  return {
    charges: costs.rows.map((r) => ({ key: `C:${r.id}`, kind: 'COST', date: r.at, vehicleId: r.vehicle_id, stockNo: r.stock_no,
      title: `${r.year} ${r.make} ${r.model}`, status: r.status, currency: r.currency, amount: r.amount,
      label: `${r.category}${r.description ? ` — ${r.description}` : ''} · ${r.stock_no}${r.invoice_ref ? ` · ${r.invoice_ref}` : ''}` })),
    payments: [
      ...accPays.rows.map(accountPaymentRow),
      // بند تكلفة مُعلَّم «مسدد» عند تسجيله يُحتسب مدفوعًا للمورد بنفس مبلغه وعملته
      ...costs.rows.filter((r) => r.is_paid).map((r) => ({ id: r.id, source: 'COST_PAID', date: r.at, createdAt: r.created_at, vehicleId: r.vehicle_id, stockNo: r.stock_no,
        amount: r.amount, currency: r.currency, settleCurrency: r.currency, settleAmount: r.amount, fxRate: null, method: null, reference: r.invoice_ref,
        note: `${r.category} — مُعلَّم مسددًا في التكاليف`, voided: false })),
    ],
  };
}

function accountPaymentRow(r) {
  return { id: r.id, source: 'ACCOUNT', date: r.paid_at, createdAt: r.created_at, vehicleId: r.vehicle_id, stockNo: r.stock_no,
    amount: r.amount, currency: r.currency, settleCurrency: r.settle_currency, settleAmount: r.settle_amount, fxRate: r.fx_rate,
    method: r.method, reference: r.reference, note: r.note, voided: !!r.voided_at, voidReason: r.void_reason, receiptNo: r.receipt_no };
}

// ------------------------------------------------------------------ الحساب
/** يبني الملخص لكل عملة، والمتبقي لكل سيارة، والكشف بالرصيد المتراكم */
export function buildAccount({ charges, payments }) {
  const live = payments.filter((p) => !p.voided);
  const byCur = {};
  const cur = (c) => (byCur[c] ??= { currency: c, charged: 0, paid: 0 });
  for (const ch of charges) cur(ch.currency).charged += toMil(ch.amount);
  for (const p of live) cur(p.settleCurrency).paid += toMil(p.settleAmount);

  // المتبقي على كل سيارة (لكل عملة): المربوط أولًا ثم FIFO
  const vehicles = new Map();
  const vrow = (ch) => {
    const k = `${ch.vehicleId}|${ch.currency}`;
    if (!vehicles.has(k)) vehicles.set(k, { vehicleId: ch.vehicleId, stockNo: ch.stockNo, title: ch.title, status: ch.status, currency: ch.currency, charged: 0, paid: 0, firstDate: ch.date });
    return vehicles.get(k);
  };
  for (const ch of charges) vrow(ch).charged += toMil(ch.amount);
  const pool = {}; // الدفعات غير المخصصة لكل عملة
  for (const p of live) {
    const v = p.vehicleId && vehicles.get(`${p.vehicleId}|${p.settleCurrency}`);
    let left = toMil(p.settleAmount);
    if (v) { const take = Math.min(left, v.charged - v.paid); v.paid += take; left -= take; }
    pool[p.settleCurrency] = (pool[p.settleCurrency] || 0) + left;
  }
  for (const v of [...vehicles.values()].sort((a, b) => new Date(a.firstDate) - new Date(b.firstDate))) {
    const take = Math.min(pool[v.currency] || 0, v.charged - v.paid);
    v.paid += take; pool[v.currency] = (pool[v.currency] || 0) - take;
  }

  // الكشف: كل القيود مرتبة زمنيًا مع رصيد متراكم لكل عملة
  const lines = [
    ...charges.map((ch) => ({ date: ch.date, at: ch.date, type: 'CHARGE', label: ch.label, vehicleId: ch.vehicleId, stockNo: ch.stockNo, currency: ch.currency, debit: toMil(ch.amount), credit: 0 })),
    ...payments.map((p) => ({ date: p.date, at: p.createdAt || p.date, type: p.voided ? 'VOID' : 'PAYMENT', paymentId: p.source === 'ACCOUNT' ? p.id : null, label: paymentLabel(p),
      vehicleId: p.vehicleId, stockNo: p.stockNo, currency: p.settleCurrency, debit: 0, credit: p.voided ? 0 : toMil(p.settleAmount),
      method: p.method, reference: p.reference, voidReason: p.voidReason, receiptNo: p.receiptNo || null })),
  ].sort((a, b) => dayKey(a.date).localeCompare(dayKey(b.date)) || (a.type === 'CHARGE' ? 0 : 1) - (b.type === 'CHARGE' ? 0 : 1) || new Date(a.at) - new Date(b.at));
  const run = {};
  for (const l of lines) { run[l.currency] = (run[l.currency] || 0) + l.debit - l.credit; l.balance = run[l.currency]; }

  return {
    summary: CURRENCIES.filter((c) => byCur[c]).map((c) => ({ currency: c, charged: fromMil(byCur[c].charged), paid: fromMil(byCur[c].paid), balance: fromMil(byCur[c].charged - byCur[c].paid) })),
    vehicles: [...vehicles.values()].map((v) => ({ ...v, charged: fromMil(v.charged), paid: fromMil(v.paid), remaining: fromMil(v.charged - v.paid) })),
    unallocated: Object.entries(pool).filter(([, m]) => m > 0).map(([currency, m]) => ({ currency, amount: fromMil(m) })),
    lines: lines.map((l) => ({ ...l, debit: fromMil(l.debit), credit: fromMil(l.credit), balance: fromMil(l.balance) })),
  };
}

// اليوم بالتوقيت المحلي للخادم: تواريخ الدفعات (DATE) وأوقات المستحقات (TIMESTAMPTZ) تُقارن باليوم،
// وفي اليوم نفسه تأتي المستحقات قبل الدفعات فلا يظهر رصيد سالب وهمي
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

function paymentLabel(p) {
  const conv = p.currency !== p.settleCurrency ? ` (${Number(p.amount).toLocaleString('en-US')} ${p.currency} بسعر ${Number(p.fxRate)})` : '';
  if (p.source === 'COST_PAID') return `مسدد: ${p.note} · ${p.stockNo}`;
  const base = p.source === 'SALE_PAYMENT' ? p.note : `${p.receiptNo ? `${p.receiptNo} · ` : ''}دفعة${p.vehicleId ? ` على ${p.stockNo}` : ' على الحساب'}`;
  return `${base}${conv}${p.reference ? ` · مرجع ${p.reference}` : ''}${p.note && p.source === 'ACCOUNT' ? ` · ${p.note}` : ''}${p.voided ? ` · ملغاة: ${p.voidReason}` : ''}`;
}

export async function customerAccount(id) {
  const { rows: [c] } = await query('SELECT id, code, full_name, customer_type, city, kyc_status FROM customers WHERE id = $1', [id]);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'العميل غير موجود');
  return { party: { type: 'CUSTOMER', ...c, name: c.full_name }, ...buildAccount(await customerEntries(id)) };
}

export async function vendorAccount(id) {
  const { rows: [v] } = await query('SELECT id, name, vendor_type, country FROM vendors WHERE id = $1', [id]);
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'المورد غير موجود');
  return { party: { type: 'VENDOR', ...v }, ...buildAccount(await vendorEntries(id)) };
}

/** أرصدة كل الأطراف (لقائمة الحسابات) — تجميع في SQL لكل عملة */
export async function customerBalances(q, limit = 300) {
  const { rows } = await query(
    `WITH ch AS (
       SELECT customer_id AS pid, customer_currency AS cur, customer_price AS amt FROM vehicles WHERE customer_id IS NOT NULL AND customer_price IS NOT NULL
       UNION ALL SELECT customer_id, 'LYD', sale_price_lyd + buyer_fee_lyd FROM sales),
     pd AS (
       SELECT customer_id AS pid, settle_currency AS cur, settle_amount AS amt FROM account_payments WHERE customer_id IS NOT NULL AND voided_at IS NULL
       UNION ALL SELECT s.customer_id, 'LYD', round(p.amount * p.fx_rate_to_lyd, 3) FROM payments p JOIN sales s ON s.id = p.sale_id),
     t AS (SELECT pid, cur, sum(amt) AS charged, 0::numeric AS paid FROM ch GROUP BY 1,2
           UNION ALL SELECT pid, cur, 0, sum(amt) FROM pd GROUP BY 1,2)
     SELECT c.id, c.code, c.full_name AS name, c.city,
            (SELECT count(*)::int FROM vehicles v WHERE v.customer_id = c.id) + (SELECT count(*)::int FROM sales s WHERE s.customer_id = c.id) AS vehicles,
            COALESCE(json_agg(json_build_object('currency', t.cur, 'charged', t.charged, 'paid', t.paid, 'balance', t.charged - t.paid) ORDER BY t.cur)
                     FILTER (WHERE t.cur IS NOT NULL), '[]') AS balances
       FROM customers c
       LEFT JOIN (SELECT pid, cur, sum(charged)::numeric(14,3) AS charged, sum(paid)::numeric(14,3) AS paid FROM t GROUP BY 1,2) t ON t.pid = c.id
      WHERE ($1::text IS NULL OR c.full_name ILIKE '%' || $1 || '%' OR c.code ILIKE '%' || $1 || '%')
      GROUP BY c.id ORDER BY c.code LIMIT $2`, [q || null, limit]);
  return rows;
}

export async function vendorBalances(q, limit = 300) {
  const { rows } = await query(
    `WITH t AS (
       SELECT vendor_id AS pid, currency AS cur, sum(amount) AS charged, COALESCE(sum(amount) FILTER (WHERE is_paid), 0) AS paid FROM vehicle_costs
        WHERE vendor_id IS NOT NULL AND voided_at IS NULL AND status = 'ACTUAL' GROUP BY 1,2
       UNION ALL SELECT vendor_id, settle_currency, 0, sum(settle_amount) FROM account_payments
        WHERE vendor_id IS NOT NULL AND voided_at IS NULL GROUP BY 1,2)
     SELECT d.id, d.name, d.vendor_type, d.country,
            (SELECT count(DISTINCT vehicle_id)::int FROM vehicle_costs c WHERE c.vendor_id = d.id AND c.voided_at IS NULL) AS vehicles,
            COALESCE(json_agg(json_build_object('currency', t.cur, 'charged', t.charged, 'paid', t.paid, 'balance', t.charged - t.paid) ORDER BY t.cur)
                     FILTER (WHERE t.cur IS NOT NULL), '[]') AS balances
       FROM vendors d
       LEFT JOIN (SELECT pid, cur, sum(charged)::numeric(14,3) AS charged, sum(paid)::numeric(14,3) AS paid FROM t GROUP BY 1,2) t ON t.pid = d.id
      WHERE d.is_active AND ($1::text IS NULL OR d.name ILIKE '%' || $1 || '%')
      GROUP BY d.id ORDER BY d.name LIMIT $2`, [q || null, limit]);
  return rows;
}

// ------------------------------------------------------------------ الدفعات
/**
 * تسجيل دفعة: amount بعملة currency، تُخصم من رصيد settleCurrency.
 * إن اختلفت العملتان فلا بد أن تكون إحداهما الدينار، وسعر الصرف = دينار لكل وحدة أجنبية
 * (يُؤخذ من أسعار الصرف المسجلة ليوم الدفع إن لم يُرسل).
 */
export async function addAccountPayment(partyType, partyId, b, actor) {
  const settleCurrency = b.settleCurrency || b.currency;
  if (b.currency !== settleCurrency && !['USD', 'EUR'].some((f) => [b.currency, settleCurrency].includes(f) && [b.currency, settleCurrency].includes('LYD'))) {
    throw new HttpError(422, 'BAD_CONVERSION', 'التحويل يكون بين الدينار وعملة أجنبية فقط');
  }
  const date = b.paidAt || new Date().toISOString().slice(0, 10);
  return tx(async (c) => {
    const table = partyType === 'CUSTOMER' ? 'customers' : 'vendors';
    const { rows: [party] } = await c.query(`SELECT id FROM ${table} WHERE id = $1`, [partyId]);
    if (!party) throw new HttpError(404, 'NOT_FOUND', partyType === 'CUSTOMER' ? 'العميل غير موجود' : 'المورد غير موجود');
    if (b.vehicleId) {
      const belongs = partyType === 'CUSTOMER'
        ? await c.query('SELECT 1 FROM vehicles WHERE id = $1 AND customer_id = $2 UNION SELECT 1 FROM sales WHERE vehicle_id = $1 AND customer_id = $2', [b.vehicleId, partyId])
        : await c.query('SELECT 1 FROM vehicle_costs WHERE vehicle_id = $1 AND vendor_id = $2 AND voided_at IS NULL UNION SELECT 1 FROM vehicles WHERE id = $1 AND vendor_id = $2', [b.vehicleId, partyId]);
      if (!belongs.rows.length) throw new HttpError(422, 'VEHICLE_NOT_IN_ACCOUNT', 'السيارة المختارة ليست ضمن حساب هذا الطرف');
    }
    let fx = null, settleAmount = b.amount;
    if (b.currency !== settleCurrency) {
      const foreign = b.currency === 'LYD' ? settleCurrency : b.currency;
      fx = b.fxRate || (await rateToLyd(c, foreign, date));
      const mil = b.currency === 'LYD' ? Math.round((toMil(b.amount) / Number(fx))) : Math.round(toMil(b.amount) * Number(fx));
      if (mil <= 0) throw new HttpError(422, 'BAD_AMOUNT', 'المبلغ بعد التحويل صفر');
      settleAmount = fromMil(mil);
    }
    const { rows: [p] } = await c.query(
      `INSERT INTO account_payments (receipt_no, party_type, customer_id, vendor_id, vehicle_id, amount, currency, settle_currency, fx_rate, settle_amount,
                                     method, reference, note, paid_at, created_by)
       VALUES (CASE WHEN $1 = 'CUSTOMER' THEN 'RC-' || to_char($13::date, 'YYYY') || '-' || lpad(nextval('receipt_seq')::text, 5, '0')
                    ELSE 'PV-' || to_char($13::date, 'YYYY') || '-' || lpad(nextval('voucher_seq')::text, 5, '0') END,
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [partyType, partyType === 'CUSTOMER' ? partyId : null, partyType === 'VENDOR' ? partyId : null, b.vehicleId || null,
        b.amount, b.currency, settleCurrency, fx, settleAmount, b.method, b.reference || null, b.note || null, date, actor.id]);
    await audit(c, { actorId: actor.id, action: partyType === 'CUSTOMER' ? 'CUSTOMER_PAYMENT' : 'VENDOR_PAYMENT', entity: partyType.toLowerCase(), entityId: partyId,
      after: { paymentId: p.id, amount: p.amount, currency: p.currency, settle: `${p.settle_amount} ${p.settle_currency}`, fx: p.fx_rate, vehicleId: p.vehicle_id }, ip: actor.ip });
    return p;
  });
}

export async function voidAccountPayment(id, reason, actor) {
  return tx(async (c) => {
    const { rows: [p] } = await c.query(
      `UPDATE account_payments SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL RETURNING *`, [id, actor.id, reason]);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'الدفعة غير موجودة أو ملغاة مسبقًا');
    await audit(c, { actorId: actor.id, action: 'ACCOUNT_PAYMENT_VOIDED', entity: p.party_type.toLowerCase(), entityId: p.customer_id || p.vendor_id,
      before: { paymentId: p.id, amount: p.amount, currency: p.currency }, after: { reason }, ip: actor.ip });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ ربط السيارة بالعميل والمورد
const PURCHASE_CODES = ['HAMMER_PRICE', 'AUCTION_BUYER_FEE', 'AUCTION_OTHER_FEES'];

/** يُستدعى داخل معاملة (عند إنشاء السيارة أو تعديل صفقتها) */
export async function applyDeal(c, vehicleId, b, actor) {
  const { rows: [v] } = await c.query('SELECT id, customer_id, customer_price, customer_currency, vendor_id FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
  const customerId = b.customerId === undefined ? v.customer_id : b.customerId;
  const price = customerId ? (b.customerPrice === undefined ? v.customer_price : b.customerPrice) : null;
  const currency = price ? (b.customerCurrency || v.customer_currency || 'USD') : null;
  const vendorId = b.vendorId === undefined ? v.vendor_id : b.vendorId;
  if (customerId && customerId !== v.customer_id) {
    const { rows: [cu] } = await c.query('SELECT kyc_status FROM customers WHERE id = $1', [customerId]);
    if (!cu) throw new HttpError(404, 'NO_CUSTOMER', 'العميل غير موجود');
    if (['REJECTED', 'SUSPENDED'].includes(cu.kyc_status)) throw new HttpError(422, 'KYC', 'العميل موقوف أو مرفوض');
    const { rows: sold } = await c.query('SELECT customer_id FROM sales WHERE vehicle_id = $1', [vehicleId]);
    if (sold[0] && sold[0].customer_id !== customerId) throw new HttpError(422, 'ALREADY_SOLD', 'السيارة مباعة لعميل آخر بفاتورة');
  }
  if (vendorId && vendorId !== v.vendor_id) {
    const { rows: [vd] } = await c.query('SELECT 1 FROM vendors WHERE id = $1', [vendorId]);
    if (!vd) throw new HttpError(404, 'NO_VENDOR', 'المورد غير موجود');
  }
  await c.query(
    `UPDATE vehicles SET customer_id = $2, customer_price = $3, customer_currency = $4, vendor_id = $5,
            customer_assigned_at = CASE WHEN $2::uuid IS DISTINCT FROM customer_id THEN (CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END) ELSE customer_assigned_at END,
            updated_at = now(), version = version + 1
      WHERE id = $1`, [vehicleId, customerId || null, price || null, currency, vendorId || null]);
  // تكاليف الشراء (سعر الشراء ورسوم المزاد) تُنسب للمورد فتظهر في حسابه
  if (vendorId !== v.vendor_id) {
    await c.query(
      `UPDATE vehicle_costs SET vendor_id = $2 WHERE vehicle_id = $1 AND category_code = ANY($3) AND voided_at IS NULL
          AND (vendor_id IS NULL OR vendor_id IS NOT DISTINCT FROM $4)`, [vehicleId, vendorId || null, PURCHASE_CODES, v.vendor_id]);
  }
  await audit(c, { actorId: actor.id, action: 'VEHICLE_DEAL_SET', entity: 'vehicle', entityId: vehicleId,
    before: { customer: v.customer_id, price: v.customer_price, currency: v.customer_currency, vendor: v.vendor_id },
    after: { customer: customerId || null, price: price || null, currency, vendor: vendorId || null }, ip: actor.ip });
}

export async function setVehicleDeal(vehicleId, b, actor) {
  return tx(async (c) => { await applyDeal(c, vehicleId, b, actor); return { ok: true }; });
}

/** ملخص الصفقة لسيارة واحدة (يظهر في ملف السيارة) */
export async function vehicleDeal(vehicleId) {
  const { rows: [v] } = await query(
    `SELECT v.customer_id, v.customer_price, v.customer_currency, v.vendor_id, c.code AS customer_code, c.full_name AS customer_name, d.name AS vendor_name,
            (SELECT customer_id FROM sales s WHERE s.vehicle_id = v.id) AS sale_customer_id
       FROM vehicles v LEFT JOIN customers c ON c.id = v.customer_id LEFT JOIN vendors d ON d.id = v.vendor_id WHERE v.id = $1`, [vehicleId]);
  if (!v) return null;
  const custId = v.customer_id || v.sale_customer_id;
  const [ca, va] = await Promise.all([custId ? customerAccount(custId) : null, v.vendor_id ? vendorAccount(v.vendor_id) : null]);
  const pick = (acc) => (acc ? acc.vehicles.filter((x) => x.vehicleId === vehicleId) : []);
  return {
    customer: custId ? { id: custId, code: ca.party.code, name: ca.party.name, price: v.customer_price, currency: v.customer_currency, lines: pick(ca) } : null,
    vendor: v.vendor_id ? { id: v.vendor_id, name: v.vendor_name, lines: pick(va) } : null,
  };
}

// ------------------------------------------------------------------ الإيصال
/** إيصال قبض (عميل) أو سند صرف (مورد)، مع الرصيد بعد الدفعة لكل عملة */
export async function paymentReceipt(id) {
  const { rows: [p] } = await query(
    `SELECT p.*, v.stock_no, v.year, v.make, v.model, v.vin, u.full_name AS created_by_name
       FROM account_payments p LEFT JOIN vehicles v ON v.id = p.vehicle_id LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [id]);
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'الدفعة غير موجودة');
  const acc = p.party_type === 'CUSTOMER' ? await customerAccount(p.customer_id) : await vendorAccount(p.vendor_id);
  const idx = acc.lines.findIndex((l) => l.paymentId === p.id);
  const after = {};
  for (const l of acc.lines.slice(0, idx + 1)) after[l.currency] = l.balance;
  return {
    payment: { id: p.id, receiptNo: p.receipt_no, partyType: p.party_type, amount: p.amount, currency: p.currency, settleCurrency: p.settle_currency,
      settleAmount: p.settle_amount, fxRate: p.fx_rate, method: p.method, reference: p.reference, note: p.note, paidAt: p.paid_at,
      createdAt: p.created_at, createdBy: p.created_by_name, voided: !!p.voided_at, voidReason: p.void_reason },
    party: acc.party,
    vehicle: p.vehicle_id ? { id: p.vehicle_id, stockNo: p.stock_no, title: `${p.year} ${p.make} ${p.model}`, vin: p.vin } : null,
    vehicleRemaining: p.vehicle_id ? acc.vehicles.filter((v) => v.vehicleId === p.vehicle_id).map((v) => ({ currency: v.currency, remaining: v.remaining })) : [],
    balancesAfter: Object.entries(after).map(([currency, balance]) => ({ currency, balance })),
    balancesNow: acc.summary.map((s) => ({ currency: s.currency, balance: s.balance })),
  };
}

// ------------------------------------------------------------------ لنا وعلينا
/** مجموع ما لنا عند العملاء وما علينا للموردين لكل عملة، وأكبر الأرصدة */
export async function accountsOverview({ customers = true, vendors = true } = {}) {
  const fold = (rows) => {
    const pos = {}, neg = {};
    for (const r of rows) for (const b of r.balances) {
      const m = toMil(b.balance);
      if (m > 0) pos[b.currency] = (pos[b.currency] || 0) + m; else if (m < 0) neg[b.currency] = (neg[b.currency] || 0) - m;
    }
    const out = (o) => CURRENCIES.filter((c) => o[c]).map((c) => ({ currency: c, amount: fromMil(o[c]) }));
    return { owed: out(pos), credit: out(neg), parties: rows.filter((r) => r.balances.some((b) => Number(b.balance) > 0.0005)).length };
  };
  // ترتيب «الأكبر» بالدينار تقريبيًا (آخر سعر صرف) فقط لاختيار القائمة؛ المبالغ تُعرض بعملاتها
  const { rows: rates } = await query(`SELECT DISTINCT ON (currency) currency, rate_to_lyd FROM exchange_rates ORDER BY currency, effective_date DESC`);
  const rate = Object.fromEntries([['LYD', 1], ...rates.map((r) => [r.currency, Number(r.rate_to_lyd)])]);
  const top = (rows) => rows
    .map((r) => ({ id: r.id, name: r.name, code: r.code, balances: r.balances.filter((b) => Number(b.balance) > 0.0005), weight: r.balances.reduce((a, b) => a + Math.max(0, Number(b.balance)) * (rate[b.currency] || 1), 0) }))
    .filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 5).map(({ weight, ...r }) => r);
  const out = {};
  if (customers) { const rows = await customerBalances(null, 100000); out.customers = { ...fold(rows), top: top(rows) }; }
  if (vendors) { const rows = await vendorBalances(null, 100000); out.vendors = { ...fold(rows), top: top(rows) }; }
  return out;
}
