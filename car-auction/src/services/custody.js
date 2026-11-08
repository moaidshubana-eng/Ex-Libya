// العُهد النقدية: يستلم الشخص مبلغًا من الخزينة ويصرف منه، وكشفه يبيّن كل حركة والرصيد بعدها.
//   استلام (RECEIPT)  : يزيد الرصيد
//   صرف (EXPENSE)     : ينقص الرصيد، ويُسجَّل مصروفًا عامًا في نفس المعاملة فيدخل في الربح الشهري
//   إرجاع (RETURN)    : ينقص الرصيد (رجّع الباقي للخزينة)، وليس مصروفًا
// المبالغ بالدينار. الكشف بترتيب التسجيل مثل دفتر العهدة الورقي.
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { insertExpense, cancelExpense, EXPENSE_CATEGORIES } from './expenses.js';

const mil = (v) => Math.round(Number(v) * 1000);
const f3 = (m) => (m / 1000).toFixed(3);
const sign = (kind) => (kind === 'RECEIPT' ? 1 : -1);

export async function listCustodies() {
  const { rows } = await query(
    `SELECT c.id, c.holder_name, c.note, c.is_active, c.created_at,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'RECEIPT'), 0)::numeric(14,3) AS received,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'EXPENSE'), 0)::numeric(14,3) AS spent,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'RETURN'), 0)::numeric(14,3) AS returned,
            max(e.entry_date)::text AS last_date, count(e.id)::int AS entries
       FROM custodies c LEFT JOIN custody_entries e ON e.custody_id = c.id AND e.voided_at IS NULL
      GROUP BY c.id ORDER BY c.is_active DESC, c.created_at DESC`);
  return rows.map((r) => ({ ...r, balance: f3(mil(r.received) - mil(r.spent) - mil(r.returned)) }));
}

export async function createCustody(b, actor) {
  return tx(async (c) => {
    const { rows: [k] } = await c.query('INSERT INTO custodies (holder_name, note, created_by) VALUES ($1,$2,$3) RETURNING *', [b.holderName.trim(), b.note || null, actor.id]);
    await audit(c, { actorId: actor.id, action: 'CUSTODY_CREATED', entity: 'custody', entityId: k.id, after: { holder: k.holder_name }, ip: actor.ip });
    return k;
  });
}

export async function custodyStatement(id) {
  const { rows: [k] } = await query('SELECT * FROM custodies WHERE id = $1', [id]);
  if (!k) throw new HttpError(404, 'NOT_FOUND', 'العهدة غير موجودة');
  const { rows } = await query(
    `SELECT e.*, e.entry_date::text AS entry_day, x.expense_no, x.category, u.full_name AS created_by_name
       FROM custody_entries e LEFT JOIN company_expenses x ON x.id = e.expense_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.custody_id = $1 ORDER BY e.seq`, [id]);
  let bal = 0, inn = 0, out = 0, n = 0;
  const entries = rows.map((e) => {
    const live = !e.voided_at;
    if (live) {
      bal += sign(e.kind) * mil(e.amount);
      if (e.kind === 'RECEIPT') inn += mil(e.amount); else out += mil(e.amount);
    }
    return {
      id: e.id, no: live ? ++n : null, kind: e.kind, date: e.entry_day, description: e.description, amount: e.amount,
      in: e.kind === 'RECEIPT' ? e.amount : null, out: e.kind === 'RECEIPT' ? null : e.amount, balance: live ? f3(bal) : null,
      expenseNo: e.expense_no, category: e.category, categoryLabel: EXPENSE_CATEGORIES[e.category] || null,
      voided: !live, voidReason: e.void_reason, createdBy: e.created_by_name, createdAt: e.created_at,
    };
  });
  const dates = rows.filter((e) => !e.voided_at).map((e) => e.entry_day).sort();
  return { custody: k, entries, totals: { in: f3(inn), out: f3(out), balance: f3(bal) }, period: { from: dates[0] || null, to: dates[dates.length - 1] || null } };
}

export async function addCustodyEntry(id, b, actor) {
  return tx(async (c) => {
    const { rows: [k] } = await c.query('SELECT * FROM custodies WHERE id = $1 FOR UPDATE', [id]);
    if (!k) throw new HttpError(404, 'NOT_FOUND', 'العهدة غير موجودة');
    if (!k.is_active) throw new HttpError(409, 'CUSTODY_CLOSED', 'العهدة مقفلة');
    let expenseId = null;
    if (b.kind === 'EXPENSE') {
      if (!b.category) throw new HttpError(422, 'VALIDATION', 'اختر بند المصروف');
      const e = await insertExpense(c, { category: b.category, description: b.description, amount: b.amount, currency: 'LYD', expenseDate: b.entryDate, method: 'CASH', reference: `عهدة ${k.holder_name}` }, actor);
      expenseId = e.id;
    }
    const { rows: [e] } = await c.query(
      `INSERT INTO custody_entries (custody_id, kind, entry_date, description, amount, expense_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, b.kind, b.entryDate, b.description, b.amount, expenseId, actor.id]);
    await audit(c, { actorId: actor.id, action: 'CUSTODY_ENTRY_ADDED', entity: 'custody', entityId: id, after: { entry: e.id, kind: e.kind, amount: e.amount, date: e.entry_date }, ip: actor.ip });
    return e;
  });
}

export async function voidCustodyEntry(entryId, reason, actor) {
  return tx(async (c) => {
    const { rows: [e] } = await c.query(
      'UPDATE custody_entries SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL RETURNING *', [entryId, actor.id, reason]);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'الحركة غير موجودة أو ملغاة مسبقًا');
    if (e.expense_id) await cancelExpense(c, e.expense_id, `إلغاء من العهدة: ${reason}`, actor);
    await audit(c, { actorId: actor.id, action: 'CUSTODY_ENTRY_VOIDED', entity: 'custody', entityId: e.custody_id, before: { entry: e.id, kind: e.kind, amount: e.amount }, after: { reason }, ip: actor.ip });
    return { ok: true };
  });
}
