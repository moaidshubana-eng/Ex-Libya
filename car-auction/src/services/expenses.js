// مصاريف الشركة العامة (غير المرتبطة بسيارة) وتقرير الربح الشهري.
//
// الربح الشهري:
//   إيراد السيارات المباعة في الشهر — فواتير البيع (مزاد/مباشر) بتاريخ البيع، والسيارات المشتراة لعميل
//   بتاريخ تعليمها «مباعة» (السعر المتفق عليه محوّلًا للدينار بسعر صرف ذلك اليوم)
//   − تكلفتها الواصلة (كل بنود تكاليفها غير الملغاة بالدينار)
//   = الربح الإجمالي
//   − مصاريف الشركة العامة في الشهر
//   = صافي الربح
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { rateToLyd } from './costs.js';
import { sniffImageType } from './images.js';
import { today } from '../domain/dates.js';

export const EXPENSE_CATEGORIES = {
  RENT: 'إيجار', SALARIES: 'رواتب', UTILITIES: 'كهرباء ومياه واتصالات', FUEL_TRANSPORT: 'وقود ومواصلات', MARKETING: 'دعاية وتسويق',
  GOVERNMENT_FEES: 'رسوم حكومية وتراخيص', OFFICE: 'مستلزمات مكتب', MAINTENANCE: 'صيانة', BANK_FEES: 'عمولات مصرفية', OTHER: 'أخرى',
};

/** حدود الشهر 'YYYY-MM' → [أول يوم، أول يوم من الشهر التالي) */
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  const now = today(); // الشهر الحالي بتوقيت الشركة
  const y = m ? Number(m[1]) : Number(now.slice(0, 4)), mo = m ? Number(m[2]) : Number(now.slice(5, 7));
  if (mo < 1 || mo > 12) throw new HttpError(422, 'BAD_MONTH', 'الشهر غير صالح');
  const pad = (n) => String(n).padStart(2, '0');
  const next = mo === 12 ? [y + 1, 1] : [y, mo + 1];
  return { month: `${y}-${pad(mo)}`, from: `${y}-${pad(mo)}-01`, to: `${next[0]}-${pad(next[1])}-01` };
}

/** يسجّل المصروف داخل معاملة قائمة (تستعمله العهدة أيضًا ليُسجَّل المصروف وقيد العهدة معًا) */
export async function insertExpense(c, b, actor) {
  const date = b.expenseDate || today();
  const fx = b.currency === 'LYD' ? '1' : (b.fxRateToLyd || await rateToLyd(c, b.currency, date));
  const { rows: [e] } = await c.query(
    `INSERT INTO company_expenses (expense_no, category, description, amount, currency, fx_rate_to_lyd, expense_date, method, reference, paid_by, created_by)
     VALUES ('EX-' || to_char($6::date, 'YYYY') || '-' || lpad(nextval('expense_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [b.category, b.description, b.amount, b.currency, fx, date, b.method || 'CASH', b.reference || null, b.paidBy?.trim() || null, actor.id]);
  await audit(c, { actorId: actor.id, action: 'EXPENSE_ADDED', entity: 'company_expense', entityId: e.id, after: { no: e.expense_no, category: e.category, amount: e.amount, currency: e.currency, lyd: e.amount_lyd, paidBy: e.paid_by }, ip: actor.ip });
  return e;
}

export async function addExpense(b, actor) {
  return tx((c) => insertExpense(c, b, actor));
}

/** يلغي المصروف داخل معاملة قائمة؛ يعيد null إن لم يوجد أو أُلغي مسبقًا */
export async function cancelExpense(c, id, reason, actor) {
  const { rows: [e] } = await c.query(
    'UPDATE company_expenses SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL RETURNING *', [id, actor.id, reason]);
  if (e) await audit(c, { actorId: actor.id, action: 'EXPENSE_VOIDED', entity: 'company_expense', entityId: id, before: { no: e.expense_no, lyd: e.amount_lyd }, after: { reason }, ip: actor.ip });
  return e || null;
}

export async function voidExpense(id, reason, actor) {
  return tx(async (c) => {
    await c.query('SELECT 1 FROM company_expenses WHERE id = $1 FOR UPDATE', [id]);
    const { rows: [bank] } = await c.query('SELECT 1 FROM bank_entries WHERE expense_id = $1 AND voided_at IS NULL', [id]);
    if (bank) throw new HttpError(409, 'BANK_EXPENSE', 'هذا المصروف مدفوع من حساب مصرفي؛ ألغِ حركته من كشف الحساب أولًا حتى يرجع المبلغ لرصيده');
    const { rows: [link] } = await c.query('SELECT 1 FROM custody_entries WHERE expense_id = $1 AND voided_at IS NULL', [id]);
    if (link) throw new HttpError(409, 'CUSTODY_EXPENSE', 'هذا المصروف مصروف من عهدة؛ ألغِه من كشف العهدة حتى يرجع المبلغ لرصيدها');
    if (!(await cancelExpense(c, id, reason, actor))) throw new HttpError(404, 'NOT_FOUND', 'المصروف غير موجود أو ملغى مسبقًا');
    return { ok: true };
  });
}

/** قائمة مختصرة بفواتير المصروف (بلا المحتوى) — تُضمَّن في استعلامات المصاريف والعهد */
export const ATTACHMENTS_SQL = (alias) => `(SELECT COALESCE(json_agg(json_build_object('id', a.id, 'filename', a.filename, 'mime', a.mime) ORDER BY a.created_at), '[]')
  FROM expense_attachments a WHERE a.expense_id = ${alias}.id)`;

/**
 * فترة التقرير: شهر 'YYYY-MM'، أو من–إلى (تاريخان شاملان). يعيد { from, to (اليوم التالي للنهاية، غير شامل), month?, until }.
 * إن أُعطي أحد طرفي الفترة فقط: «إلى» = اليوم، و«من» = أول سنة «إلى».
 */
export function resolvePeriod(p = {}) {
  if (typeof p === 'string' || p === null || (!p.from && !p.to)) {
    const r = monthRange(typeof p === 'object' && p ? p.month : p);
    const last = new Date(`${r.to}T00:00:00Z`); last.setUTCDate(last.getUTCDate() - 1);
    return { ...r, until: last.toISOString().slice(0, 10) };
  }
  const iso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d)) ? d : null);
  const until = p.to ? iso(p.to) : today();
  const from = p.from ? iso(p.from) : until && `${until.slice(0, 4)}-01-01`;
  if (!from || !until) throw new HttpError(422, 'BAD_PERIOD', 'تاريخ الفترة غير صالح');
  if (from > until) throw new HttpError(422, 'BAD_PERIOD', 'بداية الفترة بعد نهايتها');
  const next = new Date(`${until}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { month: null, from, until, to: next.toISOString().slice(0, 10) };
}

export async function listExpenses(period) {
  const r = resolvePeriod(period);
  const { rows } = await query(
    `SELECT e.*, u.full_name AS created_by_name, ${ATTACHMENTS_SQL('e')} AS attachments,
            EXISTS (SELECT 1 FROM custody_entries k WHERE k.expense_id = e.id) AS from_custody,
            (SELECT a.name FROM bank_entries b JOIN bank_accounts a ON a.id = b.account_id WHERE b.expense_id = e.id AND b.voided_at IS NULL) AS bank_account
       FROM company_expenses e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.expense_date >= $1 AND e.expense_date < $2 ORDER BY e.expense_date DESC, e.created_at DESC`, [r.from, r.to]);
  return { ...r, items: rows };
}

/** أرشيف الفواتير: كل المصاريف غير الملغاة في كل الشهور مع فواتيرها، ومن أين دُفعت */
export async function listInvoices({ q, from, to, missing } = {}) {
  const where = ['e.voided_at IS NULL'];
  const args = [];
  if (q) { args.push(`%${q}%`); where.push(`(e.description ILIKE $${args.length} OR e.expense_no ILIKE $${args.length} OR e.reference ILIKE $${args.length} OR e.paid_by ILIKE $${args.length} OR k.holder_name ILIKE $${args.length})`); }
  if (from) { args.push(from); where.push(`e.expense_date >= $${args.length}`); }
  if (to) { args.push(to); where.push(`e.expense_date <= $${args.length}`); }
  if (missing) where.push('NOT EXISTS (SELECT 1 FROM expense_attachments a WHERE a.expense_id = e.id)');
  const { rows } = await query(
    `SELECT e.id, e.expense_no, e.expense_date::text AS expense_date, e.category, e.description, e.amount, e.currency, e.amount_lyd, e.reference,
            e.paid_by, e.reimbursed_at, k.holder_name AS custody_holder,
            (SELECT a.name FROM bank_entries b JOIN bank_accounts a ON a.id = b.account_id WHERE b.expense_id = e.id AND b.voided_at IS NULL) AS bank_account, ${ATTACHMENTS_SQL('e')} AS attachments
       FROM company_expenses e
       LEFT JOIN custody_entries ce ON ce.expense_id = e.id AND ce.voided_at IS NULL
       LEFT JOIN custodies k ON k.id = ce.custody_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 500`, args);
  const { rows: [t] } = await query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM expense_attachments a WHERE a.expense_id = e.id))::int AS with_invoice
       FROM company_expenses e WHERE e.voided_at IS NULL`);
  return { items: rows, totals: { expenses: t.total, withInvoice: t.with_invoice, missing: t.total - t.with_invoice } };
}

// ---------------------------------------------------------------- فواتير المصاريف
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_EXPENSE = 10;

/** يفك base64 ويحدد النوع من البايتات نفسها: صورة JPEG/PNG/WebP أو PDF فقط */
export function decodeAttachment(data) {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(data);
  const b64 = (m ? m[1] : data).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new HttpError(422, 'BAD_FILE', 'بيانات الملف غير صالحة');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(422, 'BAD_FILE', 'الملف فارغ');
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'FILE_TOO_LARGE', 'الملف أكبر من 5 ميغابايت');
  const mime = sniffImageType(buf) || (buf.toString('ascii', 0, 5) === '%PDF-' ? 'application/pdf' : null);
  if (!mime) throw new HttpError(415, 'UNSUPPORTED_FILE', 'الفاتورة صورة (JPEG أو PNG أو WebP) أو ملف PDF فقط');
  return { buf, mime };
}

export async function addExpenseAttachment(expenseId, { data, filename }, actor) {
  const { buf, mime } = decodeAttachment(data);
  return tx(async (c) => {
    const { rows: [e] } = await c.query('SELECT id, expense_no, voided_at FROM company_expenses WHERE id = $1 FOR UPDATE', [expenseId]);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'المصروف غير موجود');
    if (e.voided_at) throw new HttpError(409, 'EXPENSE_VOIDED', 'المصروف ملغى');
    const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM expense_attachments WHERE expense_id = $1', [expenseId]);
    if (n.n >= MAX_ATTACHMENTS_PER_EXPENSE) throw new HttpError(422, 'TOO_MANY_FILES', `الحد الأقصى ${MAX_ATTACHMENTS_PER_EXPENSE} فواتير للمصروف`);
    const name = String(filename || '').replace(/[\\/\r\n"]/g, '').trim().slice(0, 120) || (mime === 'application/pdf' ? 'فاتورة.pdf' : 'فاتورة.jpg');
    const { rows: [a] } = await c.query(
      `INSERT INTO expense_attachments (expense_id, filename, mime, bytes, content, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, mime, bytes`,
      [expenseId, name, mime, buf.length, buf, actor.id]);
    await audit(c, { actorId: actor.id, action: 'EXPENSE_ATTACHMENT_ADDED', entity: 'company_expense', entityId: expenseId, after: { attachment: a.id, no: e.expense_no, mime, bytes: buf.length }, ip: actor.ip });
    return a;
  });
}

export async function getExpenseAttachment(id) {
  const { rows: [a] } = await query('SELECT filename, mime, content FROM expense_attachments WHERE id = $1', [id]);
  if (!a) throw new HttpError(404, 'NOT_FOUND', 'الفاتورة غير موجودة');
  return a;
}

export async function removeExpenseAttachment(id, actor) {
  return tx(async (c) => {
    const { rows: [a] } = await c.query('DELETE FROM expense_attachments WHERE id = $1 RETURNING expense_id, filename', [id]);
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'الفاتورة غير موجودة');
    await audit(c, { actorId: actor.id, action: 'EXPENSE_ATTACHMENT_REMOVED', entity: 'company_expense', entityId: a.expense_id, before: { attachment: id, filename: a.filename }, ip: actor.ip });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- مصاريف دفعها شخص من ماله
/** المبالغ التي على الشركة لأشخاص دفعوا مصاريفها من مالهم ولم تُردّ لهم بعد */
export async function owedToPeople() {
  const { rows } = await query(
    `SELECT e.id, e.expense_no, e.expense_date::text AS expense_date, e.category, e.description, e.amount, e.currency, e.amount_lyd, e.paid_by,
            ${ATTACHMENTS_SQL('e')} AS attachments
       FROM company_expenses e WHERE e.paid_by IS NOT NULL AND e.reimbursed_at IS NULL AND e.voided_at IS NULL
      ORDER BY e.paid_by, e.expense_date, e.created_at`);
  const people = new Map();
  for (const e of rows) {
    const p = people.get(e.paid_by) || { name: e.paid_by, totalLyd: 0, items: [] };
    p.totalLyd += Math.round(Number(e.amount_lyd) * 1000);
    p.items.push(e);
    people.set(e.paid_by, p);
  }
  return [...people.values()].map((p) => ({ ...p, totalLyd: (p.totalLyd / 1000).toFixed(3) }));
}

export async function markReimbursed(id, note, actor) {
  return tx(async (c) => {
    const { rows: [e] } = await c.query(
      `UPDATE company_expenses SET reimbursed_at = now(), reimbursed_by = $2, reimburse_note = $3
        WHERE id = $1 AND paid_by IS NOT NULL AND reimbursed_at IS NULL AND voided_at IS NULL RETURNING expense_no, paid_by, amount_lyd`, [id, actor.id, note || null]);
    if (!e) throw new HttpError(409, 'NOT_OWED', 'هذا المصروف ليس مستحقًا لأحد أو رُدّ مسبقًا');
    await audit(c, { actorId: actor.id, action: 'EXPENSE_REIMBURSED', entity: 'company_expense', entityId: id, after: { no: e.expense_no, to: e.paid_by, lyd: e.amount_lyd, note }, ip: actor.ip });
    return { ok: true };
  });
}

export async function profitReport(period) {
  const r = resolvePeriod(period);
  const [sales, reserved, expenses] = await Promise.all([
    query(`SELECT s.vehicle_id, v.stock_no, v.year, v.make, v.model, s.sold_at, s.invoice_no, s.sale_type,
                  (s.sale_price_lyd + s.buyer_fee_lyd) AS revenue_lyd, lc.total_cost_lyd, c.full_name AS customer
             FROM sales s JOIN vehicles v ON v.id = s.vehicle_id JOIN v_vehicle_landed_cost lc ON lc.vehicle_id = v.id
             JOIN customers c ON c.id = s.customer_id
            WHERE s.sold_at >= $1 AND s.sold_at < $2`, [r.from, r.to]),
    // السيارات المشتراة لعميل (بلا فاتورة بيع): تاريخ البيع = آخر انتقال إلى «مباعة»
    query(`SELECT v.id AS vehicle_id, v.stock_no, v.year, v.make, v.model, h.changed_at AS sold_at, v.customer_price, v.customer_currency,
                  lc.total_cost_lyd, c.full_name AS customer
             FROM vehicles v
             JOIN LATERAL (SELECT occurred_at AS changed_at FROM vehicle_status_history WHERE vehicle_id = v.id AND to_status = 'SOLD' ORDER BY occurred_at DESC LIMIT 1) h ON true
             JOIN v_vehicle_landed_cost lc ON lc.vehicle_id = v.id JOIN customers c ON c.id = v.customer_id
            WHERE v.customer_id IS NOT NULL AND v.customer_price IS NOT NULL AND v.status IN ('SOLD','DELIVERED')
              AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.vehicle_id = v.id)
              AND h.changed_at >= $1 AND h.changed_at < $2`, [r.from, r.to]),
    query(`SELECT category, sum(amount_lyd)::numeric(14,3) AS total_lyd, count(*)::int AS n FROM company_expenses
            WHERE voided_at IS NULL AND expense_date >= $1 AND expense_date < $2 GROUP BY category ORDER BY 2 DESC`, [r.from, r.to]),
  ]);
  const warnings = [];
  const cars = sales.rows.map((s) => ({ vehicleId: s.vehicle_id, stockNo: s.stock_no, title: `${s.year} ${s.make} ${s.model}`, soldAt: s.sold_at,
    kind: s.sale_type === 'AUCTION' ? 'مزاد' : 'بيع مباشر', ref: s.invoice_no, customer: s.customer, revenueLyd: Number(s.revenue_lyd), costLyd: Number(s.total_cost_lyd) }));
  for (const v of reserved.rows) {
    let revenue = null, fx = '1';
    try {
      fx = v.customer_currency === 'LYD' ? '1' : await rateToLyd(null, v.customer_currency, today(new Date(v.sold_at)));
      revenue = Math.round(Number(v.customer_price) * Number(fx) * 1000) / 1000;
    } catch { warnings.push(`لا يوجد سعر صرف ${v.customer_currency} يوم بيع ${v.stock_no}، فلم يُحتسب إيرادها`); }
    cars.push({ vehicleId: v.vehicle_id, stockNo: v.stock_no, title: `${v.year} ${v.make} ${v.model}`, soldAt: v.sold_at, kind: 'طلب عميل',
      ref: `${Number(v.customer_price).toLocaleString('en-US')} ${v.customer_currency}${v.customer_currency !== 'LYD' ? ` × ${Number(fx)}` : ''}`,
      customer: v.customer, revenueLyd: revenue, costLyd: Number(v.total_cost_lyd) });
  }
  cars.sort((a, b) => new Date(a.soldAt) - new Date(b.soldAt));
  const mil = (n) => Math.round((n || 0) * 1000);
  const revenue = cars.reduce((a, c) => a + mil(c.revenueLyd), 0);
  const cost = cars.filter((c) => c.revenueLyd != null).reduce((a, c) => a + mil(c.costLyd), 0);
  const exp = expenses.rows.reduce((a, e) => a + mil(Number(e.total_lyd)), 0);
  const f = (m) => (m / 1000).toFixed(3);
  return {
    ...r,
    cars: cars.map((c) => ({ ...c, profitLyd: c.revenueLyd == null ? null : f(mil(c.revenueLyd) - mil(c.costLyd)), revenueLyd: c.revenueLyd == null ? null : f(mil(c.revenueLyd)), costLyd: f(mil(c.costLyd)) })),
    expenses: expenses.rows.map((e) => ({ ...e, label: EXPENSE_CATEGORIES[e.category] || e.category })),
    totals: { revenueLyd: f(revenue), costLyd: f(cost), grossProfitLyd: f(revenue - cost), expensesLyd: f(exp), netProfitLyd: f(revenue - cost - exp) },
    warnings,
  };
}
