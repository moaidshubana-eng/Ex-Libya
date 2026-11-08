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

export const EXPENSE_CATEGORIES = {
  RENT: 'إيجار', SALARIES: 'رواتب', UTILITIES: 'كهرباء ومياه واتصالات', FUEL_TRANSPORT: 'وقود ومواصلات', MARKETING: 'دعاية وتسويق',
  GOVERNMENT_FEES: 'رسوم حكومية وتراخيص', OFFICE: 'مستلزمات مكتب', MAINTENANCE: 'صيانة', BANK_FEES: 'عمولات مصرفية', OTHER: 'أخرى',
};

/** حدود الشهر 'YYYY-MM' → [أول يوم، أول يوم من الشهر التالي) */
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  const now = new Date();
  const y = m ? Number(m[1]) : now.getFullYear(), mo = m ? Number(m[2]) : now.getMonth() + 1;
  if (mo < 1 || mo > 12) throw new HttpError(422, 'BAD_MONTH', 'الشهر غير صالح');
  const pad = (n) => String(n).padStart(2, '0');
  const next = mo === 12 ? [y + 1, 1] : [y, mo + 1];
  return { month: `${y}-${pad(mo)}`, from: `${y}-${pad(mo)}-01`, to: `${next[0]}-${pad(next[1])}-01` };
}

/** يسجّل المصروف داخل معاملة قائمة (تستعمله العهدة أيضًا ليُسجَّل المصروف وقيد العهدة معًا) */
export async function insertExpense(c, b, actor) {
  const date = b.expenseDate || new Date().toISOString().slice(0, 10);
  const fx = b.currency === 'LYD' ? '1' : (b.fxRateToLyd || await rateToLyd(c, b.currency, date));
  const { rows: [e] } = await c.query(
    `INSERT INTO company_expenses (expense_no, category, description, amount, currency, fx_rate_to_lyd, expense_date, method, reference, created_by)
     VALUES ('EX-' || to_char($6::date, 'YYYY') || '-' || lpad(nextval('expense_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.category, b.description, b.amount, b.currency, fx, date, b.method || 'CASH', b.reference || null, actor.id]);
  await audit(c, { actorId: actor.id, action: 'EXPENSE_ADDED', entity: 'company_expense', entityId: e.id, after: { no: e.expense_no, category: e.category, amount: e.amount, currency: e.currency, lyd: e.amount_lyd }, ip: actor.ip });
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
    const { rows: [link] } = await c.query('SELECT 1 FROM custody_entries WHERE expense_id = $1 AND voided_at IS NULL', [id]);
    if (link) throw new HttpError(409, 'CUSTODY_EXPENSE', 'هذا المصروف مصروف من عهدة؛ ألغِه من كشف العهدة حتى يرجع المبلغ لرصيدها');
    if (!(await cancelExpense(c, id, reason, actor))) throw new HttpError(404, 'NOT_FOUND', 'المصروف غير موجود أو ملغى مسبقًا');
    return { ok: true };
  });
}

export async function listExpenses(month) {
  const r = monthRange(month);
  const { rows } = await query(
    `SELECT e.*, u.full_name AS created_by_name FROM company_expenses e LEFT JOIN users u ON u.id = e.created_by
      WHERE e.expense_date >= $1 AND e.expense_date < $2 ORDER BY e.expense_date DESC, e.created_at DESC`, [r.from, r.to]);
  return { ...r, items: rows };
}

export async function profitReport(month) {
  const r = monthRange(month);
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
      fx = v.customer_currency === 'LYD' ? '1' : await rateToLyd(null, v.customer_currency, new Date(v.sold_at).toISOString().slice(0, 10));
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
