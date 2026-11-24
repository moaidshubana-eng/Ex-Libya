import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { server, base } = await startApp();
after(() => stopApp(server));
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };

let acc, viewer, sales, id;
before(async () => {
  acc = await asRole('accountant@auction.ly'); viewer = await asRole('viewer@auction.ly'); sales = await asRole('sales@auction.ly');
});
const add = (body) => acc.post(`/api/bank-accounts/${id}/entries`, { entryDate: '2026-11-23', ...body });
const balance = async () => (await acc.get(`/api/bank-accounts/${id}`)).data.totals.balance;
const expenses = async () => (await acc.get('/api/expenses?month=2026-11')).data.items;
const profit = async () => (await acc.get('/api/reports/profit?month=2026-11')).data.totals;

describe('الحسابات المصرفية', () => {
  test('المحاسب ينشئ ويعدّل؛ الاطلاع يقرأ، والمبيعات لا ترى', async () => {
    assert.equal((await viewer.post('/api/bank-accounts', { name: 'حساب' })).status, 403);
    const r = await acc.post('/api/bank-accounts', { name: 'حساب الشركة المصرفي' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    id = r.data.id;
    assert.equal((await acc.put(`/api/bank-accounts/${id}`, { name: 'حساب الشركة المصرفي', bankName: 'مصرف' })).data.bank_name, 'مصرف');
    assert.equal((await viewer.get(`/api/bank-accounts/${id}`)).status, 200);
    assert.equal((await viewer.post(`/api/bank-accounts/${id}/entries`, { kind: 'DEPOSIT', entryDate: '2026-11-23', description: 'إيداع', amount: '1' })).status, 403);
    assert.equal((await sales.get('/api/bank-accounts')).status, 403);
  });

  test('الصرف فوق الرصيد مرفوض ولا يترك مصروفًا؛ والإيداع ليس إيرادًا', async () => {
    const before = await profit();
    assert.equal((await add({ kind: 'EXPENSE', description: 'قبل الإيداع', amount: '10', category: 'OTHER' })).data.error.code, 'BANK_OVERDRAW');
    assert.equal((await expenses()).filter((e) => e.description === 'قبل الإيداع').length, 0);
    assert.equal((await add({ kind: 'DEPOSIT', description: 'إيداع رأس مال', amount: '8840' })).status, 201);
    assert.equal(await balance(), '8840.000');
    assert.deepEqual(await profit(), before);
  });

  test('الصرف يدخل المصاريف مرة واحدة، ولا يُلغى إلا من كشف الحساب', async () => {
    const before = Number((await profit()).expensesLyd);
    const e = (await add({ kind: 'EXPENSE', description: 'باقي حساب الشيبورد', amount: '500', category: 'MAINTENANCE', reference: 'ف 1' })).data;
    assert.equal(await balance(), '8340.000');
    const x = (await expenses()).find((i) => i.id === e.expense_id);
    assert.deepEqual([x.method, x.bank_account, Number(x.amount)], ['BANK_TRANSFER', 'حساب الشركة المصرفي', 500]);
    assert.equal(Number((await profit()).expensesLyd), before + 500);
    assert.equal((await acc.post(`/api/expenses/${x.id}/void`, { reason: 'خطأ' })).data.error.code, 'BANK_EXPENSE');
    assert.equal((await acc.post(`/api/bank-entries/${e.id}/void`, { reason: 'مكرر' })).status, 200);
    assert.equal(await balance(), '8840.000');
    assert.equal(Number((await profit()).expensesLyd), before);
    assert.equal((await acc.post(`/api/bank-entries/${e.id}/void`, { reason: 'مكرر' })).status, 404);
  });

  test('سداد مصروف مسجل لا يكرره، ويردّ المبلغ لمن دفعه، ومرة واحدة فقط', async () => {
    const x = (await acc.post('/api/expenses', { category: 'OFFICE', description: 'كاميرات', amount: '3600', currency: 'LYD', expenseDate: '2026-11-08', paidBy: 'معتصم' })).data;
    const before = Number((await profit()).expensesLyd);
    assert.ok((await acc.get('/api/bank-accounts/payable')).data.items.some((i) => i.id === x.id));
    const e = await add({ kind: 'SETTLE', expenseId: x.id, entryDate: '2026-11-08' });
    assert.equal(e.status, 201, JSON.stringify(e.data));
    assert.equal(await balance(), '5240.000');
    assert.equal(Number((await profit()).expensesLyd), before);
    assert.ok((await expenses()).find((i) => i.id === x.id).reimbursed_at);
    assert.equal((await acc.get('/api/expenses/owed')).data.people.filter((p) => p.name === 'معتصم').length, 0);
    assert.equal((await add({ kind: 'SETTLE', expenseId: x.id })).data.error.code, 'BANK_EXPENSE');
    assert.ok(!(await acc.get('/api/bank-accounts/payable')).data.items.some((i) => i.id === x.id));
    // الإلغاء يعيده مستحقًا لصاحبه ويبقى المصروف
    assert.equal((await acc.post(`/api/bank-entries/${e.data.id}/void`, { reason: 'خطأ' })).status, 200);
    const y = (await expenses()).find((i) => i.id === x.id);
    assert.deepEqual([y.reimbursed_at, y.voided_at], [null, null]);
    assert.equal(await balance(), '8840.000');
    // مصروف رُدّ من قبل: يُربط فقط، وإلغاء الربط لا يمس ردّته
    assert.equal((await acc.post(`/api/expenses/${x.id}/reimburse`, {})).status, 200);
    const link = (await add({ kind: 'SETTLE', expenseId: x.id })).data;
    assert.equal((await acc.post(`/api/bank-entries/${link.id}/void`, { reason: 'خطأ' })).status, 200);
    assert.ok((await expenses()).find((i) => i.id === x.id).reimbursed_at);
  });

  test('مصروف العهدة لا يُسدَّد من المصرف، والسحب ليس مصروفًا، والتحقق من الحقول', async () => {
    const k = (await acc.post('/api/custodies', { holderName: 'عهدة' })).data;
    await acc.post(`/api/custodies/${k.id}/entries`, { kind: 'RECEIPT', entryDate: '2026-11-08', description: 'استلام', amount: '100' });
    const ce = (await acc.post(`/api/custodies/${k.id}/entries`, { kind: 'EXPENSE', entryDate: '2026-11-08', description: 'سقالة', amount: '65', category: 'MAINTENANCE' })).data;
    assert.equal((await add({ kind: 'SETTLE', expenseId: ce.expense_id })).data.error.code, 'CUSTODY_EXPENSE');
    const before = await profit();
    assert.equal((await add({ kind: 'WITHDRAW', description: 'سحب', amount: '40' })).status, 201);
    assert.deepEqual(await profit(), before);
    assert.equal(await balance(), '8800.000');
    for (const bad of [{ kind: 'SETTLE' }, { kind: 'DEPOSIT', description: 'بلا مبلغ' }, { kind: 'DEPOSIT', amount: '5' }, { kind: 'EXPENSE', description: 'بلا بند', amount: '5' }, { kind: 'DEPOSIT', description: 'سالب', amount: '-5' }]) {
      assert.equal((await add(bad)).status, 422, JSON.stringify(bad));
    }
    const l = (await acc.get('/api/bank-accounts')).data.items.find((a) => a.id === id);
    assert.deepEqual([l.deposited, l.spent, l.withdrawn, l.balance], ['8840.000', '0.000', '40.000', '8800.000']);
  });
});
