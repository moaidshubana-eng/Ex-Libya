// الحسابات المصرفية للشركة (بالدينار)، بكشف بترتيب التسجيل ورصيد بعد كل حركة:
//   إيداع (DEPOSIT)  : يزيد الرصيد، وليس إيرادًا
//   صرف (EXPENSE)    : ينقص الرصيد، ويُسجَّل مصروفًا عامًا في نفس المعاملة
//   سداد (SETTLE)    : ينقص الرصيد بقيمة مصروف مسجل من قبل دون تكراره؛ وإن كان شخص دفعه من ماله تُسجَّل ردّته
//   سحب (WITHDRAW)   : ينقص الرصيد (نقد خرج من المصرف)، وليس مصروفًا
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { insertExpense, cancelExpense, EXPENSE_CATEGORIES, ATTACHMENTS_SQL } from './expenses.js';

const mil = (v) => Math.round(Number(v) * 1000);
const f3 = (m) => (m / 1000).toFixed(3);
const BAL = `COALESCE(sum(CASE WHEN kind = 'DEPOSIT' THEN amount ELSE -amount END), 0)::numeric(14,3)`;

export async function listBankAccounts() {
  const { rows } = await query(
    `SELECT a.id, a.name, a.bank_name, a.account_no, a.note, a.is_active,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'DEPOSIT'), 0)::numeric(14,3) AS deposited,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind IN ('EXPENSE','SETTLE')), 0)::numeric(14,3) AS spent,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'WITHDRAW'), 0)::numeric(14,3) AS withdrawn,
            max(e.entry_date)::text AS last_date, count(e.id)::int AS entries
       FROM bank_accounts a LEFT JOIN bank_entries e ON e.account_id = a.id AND e.voided_at IS NULL
      GROUP BY a.id ORDER BY a.is_active DESC, a.created_at`);
  return rows.map((r) => ({ ...r, balance: f3(mil(r.deposited) - mil(r.spent) - mil(r.withdrawn)) }));
}

export async function createBankAccount(b, actor) {
  return tx(async (c) => {
    const { rows: [a] } = await c.query('INSERT INTO bank_accounts (name, bank_name, account_no, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [b.name.trim(), b.bankName || null, b.accountNo || null, b.note || null, actor.id]);
    await audit(c, { actorId: actor.id, action: 'BANK_ACCOUNT_CREATED', entity: 'bank_account', entityId: a.id, after: { name: a.name, bank: a.bank_name }, ip: actor.ip });
    return a;
  });
}

export async function updateBankAccount(id, b, actor) {
  return tx(async (c) => {
    const { rows: [old] } = await c.query('SELECT * FROM bank_accounts WHERE id = $1 FOR UPDATE', [id]);
    if (!old) throw new HttpError(404, 'NOT_FOUND', 'الحساب غير موجود');
    const { rows: [a] } = await c.query('UPDATE bank_accounts SET name = $2, bank_name = $3, account_no = $4, note = $5 WHERE id = $1 RETURNING *',
      [id, b.name.trim(), b.bankName || null, b.accountNo || null, b.note || null]);
    await audit(c, { actorId: actor.id, action: 'BANK_ACCOUNT_UPDATED', entity: 'bank_account', entityId: id, before: { name: old.name, bank: old.bank_name }, after: { name: a.name, bank: a.bank_name }, ip: actor.ip });
    return a;
  });
}

export async function bankStatement(id) {
  const { rows: [a] } = await query('SELECT * FROM bank_accounts WHERE id = $1', [id]);
  if (!a) throw new HttpError(404, 'NOT_FOUND', 'الحساب غير موجود');
  const { rows } = await query(
    `SELECT e.*, e.entry_date::text AS entry_day, x.expense_no, x.category, x.paid_by, u.full_name AS created_by_name,
            CASE WHEN x.id IS NULL THEN '[]'::json ELSE ${ATTACHMENTS_SQL('x')} END AS attachments
       FROM bank_entries e LEFT JOIN company_expenses x ON x.id = e.expense_id LEFT JOIN users u ON u.id = e.created_by
      WHERE e.account_id = $1 ORDER BY e.seq`, [id]);
  let bal = 0, inn = 0, out = 0, n = 0;
  const entries = rows.map((e) => {
    const live = !e.voided_at, isIn = e.kind === 'DEPOSIT';
    if (live) {
      bal += (isIn ? 1 : -1) * mil(e.amount);
      if (isIn) inn += mil(e.amount); else out += mil(e.amount);
    }
    return {
      id: e.id, no: live ? ++n : null, kind: e.kind, date: e.entry_day, description: e.description, amount: e.amount,
      in: isIn ? e.amount : null, out: isIn ? null : e.amount, balance: live ? f3(bal) : null,
      expenseId: e.expense_id, expenseNo: e.expense_no, categoryLabel: EXPENSE_CATEGORIES[e.category] || null, paidBy: e.paid_by, attachments: e.attachments,
      voided: !live, voidReason: e.void_reason, createdBy: e.created_by_name, createdAt: e.created_at,
    };
  });
  const dates = rows.filter((e) => !e.voided_at).map((e) => e.entry_day).sort();
  return { account: a, entries, totals: { in: f3(inn), out: f3(out), balance: f3(bal) }, period: { from: dates[0] || null, to: dates[dates.length - 1] || null } };
}

/** المصاريف المسجلة التي يمكن سدادها من الحساب: غير ملغاة، ليست من عهدة، ولم تُدفع من حساب مصرفي */
export async function payableExpenses() {
  const { rows } = await query(
    `SELECT x.id, x.expense_no, x.expense_date::text AS expense_date, x.description, x.amount_lyd, x.paid_by, x.reimbursed_at
       FROM company_expenses x
      WHERE x.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM custody_entries k WHERE k.expense_id = x.id AND k.voided_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM bank_entries b WHERE b.expense_id = x.id AND b.voided_at IS NULL)
      ORDER BY x.expense_date DESC, x.created_at DESC LIMIT 300`);
  return rows;
}

export async function addBankEntry(id, b, actor) {
  return tx(async (c) => {
    const { rows: [a] } = await c.query('SELECT * FROM bank_accounts WHERE id = $1 FOR UPDATE', [id]);
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'الحساب غير موجود');
    if (!a.is_active) throw new HttpError(409, 'BANK_CLOSED', 'الحساب مقفل');
    let { amount, description } = b, expenseId = null, reimbursed = false, x = null;
    if (b.kind === 'SETTLE') {
      if (!b.expenseId) throw new HttpError(422, 'VALIDATION', 'اختر المصروف الذي تسدده');
      ({ rows: [x] } = await c.query('SELECT * FROM company_expenses WHERE id = $1 FOR UPDATE', [b.expenseId]));
      if (!x || x.voided_at) throw new HttpError(404, 'NOT_FOUND', 'المصروف غير موجود أو ملغى');
      const { rows: [used] } = await c.query(
        `SELECT (SELECT 1 FROM custody_entries WHERE expense_id = $1 AND voided_at IS NULL) AS custody, (SELECT 1 FROM bank_entries WHERE expense_id = $1 AND voided_at IS NULL) AS bank`, [x.id]);
      if (used.custody) throw new HttpError(409, 'CUSTODY_EXPENSE', 'هذا المصروف مدفوع من عهدة');
      if (used.bank) throw new HttpError(409, 'BANK_EXPENSE', 'هذا المصروف مدفوع من حساب مصرفي من قبل');
      amount = x.amount_lyd; expenseId = x.id;
      description = description || x.description;
    }
    if (!amount) throw new HttpError(422, 'VALIDATION', 'اكتب المبلغ');
    if (!description) throw new HttpError(422, 'VALIDATION', 'اكتب البيان');
    if (b.kind === 'EXPENSE' && !b.category) throw new HttpError(422, 'VALIDATION', 'اختر بند المصروف');
    // المصرف لا يصرف ما ليس فيه: الخارج فوق الرصيد مرفوض (الحساب مقفول بـFOR UPDATE فالرصيد ثابت هنا)
    if (b.kind !== 'DEPOSIT') {
      const { rows: [s] } = await c.query(`SELECT ${BAL} AS bal FROM bank_entries WHERE account_id = $1 AND voided_at IS NULL`, [id]);
      if (mil(amount) > mil(s.bal)) throw new HttpError(409, 'BANK_OVERDRAW', `المبلغ أكبر من رصيد الحساب (${Number(s.bal).toLocaleString('en-US')} د.ل) — سجّل الإيداع أولًا`);
    }
    if (b.kind === 'EXPENSE') {
      const e = await insertExpense(c, { category: b.category, description, amount, currency: 'LYD', expenseDate: b.entryDate, method: 'BANK_TRANSFER', reference: b.reference || null }, actor);
      expenseId = e.id;
    }
    if (x?.paid_by && !x.reimbursed_at) {
      await c.query('UPDATE company_expenses SET reimbursed_at = now(), reimbursed_by = $2, reimburse_note = $3 WHERE id = $1', [x.id, actor.id, `من الحساب المصرفي ${a.name}`]);
      await audit(c, { actorId: actor.id, action: 'EXPENSE_REIMBURSED', entity: 'company_expense', entityId: x.id, after: { no: x.expense_no, to: x.paid_by, lyd: x.amount_lyd, note: a.name }, ip: actor.ip });
      reimbursed = true;
    }
    const { rows: [e] } = await c.query(
      `INSERT INTO bank_entries (account_id, kind, entry_date, description, amount, expense_id, reimbursed, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, b.kind, b.entryDate, description, amount, expenseId, reimbursed, actor.id]);
    await audit(c, { actorId: actor.id, action: 'BANK_ENTRY_ADDED', entity: 'bank_account', entityId: id, after: { entry: e.id, kind: e.kind, amount: e.amount, date: e.entry_date }, ip: actor.ip });
    return e;
  });
}

export async function voidBankEntry(entryId, reason, actor) {
  return tx(async (c) => {
    const { rows: [e] } = await c.query(
      'UPDATE bank_entries SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 AND voided_at IS NULL RETURNING *', [entryId, actor.id, reason]);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'الحركة غير موجودة أو ملغاة مسبقًا');
    if (e.kind === 'EXPENSE') await cancelExpense(c, e.expense_id, `إلغاء من الحساب المصرفي: ${reason}`, actor);
    if (e.reimbursed) await c.query('UPDATE company_expenses SET reimbursed_at = NULL, reimbursed_by = NULL, reimburse_note = NULL WHERE id = $1', [e.expense_id]);
    await audit(c, { actorId: actor.id, action: 'BANK_ENTRY_VOIDED', entity: 'bank_account', entityId: e.account_id, before: { entry: e.id, kind: e.kind, amount: e.amount }, after: { reason }, ip: actor.ip });
    return { ok: true };
  });
}