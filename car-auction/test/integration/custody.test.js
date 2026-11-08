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
const add = (body) => acc.post(`/api/custodies/${id}/entries`, body);
const statement = async () => (await acc.get(`/api/custodies/${id}`)).data;

describe('العُهد النقدية', () => {
  test('المحاسب ينشئ العهدة؛ الاطلاع يقرأ ولا يكتب، والمبيعات لا ترى', async () => {
    assert.equal((await viewer.post('/api/custodies', { holderName: 'معتصم' })).status, 403);
    const r = await acc.post('/api/custodies', { holderName: 'معتصم شوبانة' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    id = r.data.id;
    assert.equal((await viewer.get(`/api/custodies/${id}`)).status, 200);
    assert.equal((await sales.get('/api/custodies')).status, 403);
  });

  test('الكشف بترتيب التسجيل، والرصيد بعد كل حركة', async () => {
    assert.equal((await add({ kind: 'RECEIPT', entryDate: '2026-10-14', description: 'استلام العهدة من الخزينة', amount: '5000' })).status, 201);
    assert.equal((await add({ kind: 'EXPENSE', entryDate: '2026-10-13', description: 'واصل لعامل الصيانة', amount: '150', category: 'MAINTENANCE' })).status, 201);
    assert.equal((await add({ kind: 'EXPENSE', entryDate: '2026-11-08', description: 'نت قيقا', amount: '800', category: 'UTILITIES' })).status, 201);
    assert.equal((await add({ kind: 'RETURN', entryDate: '2026-11-08', description: 'إرجاع للخزينة', amount: '50' })).status, 201);
    const s = await statement();
    assert.deepEqual(s.entries.map((e) => [e.no, e.balance]), [[1, '5000.000'], [2, '4850.000'], [3, '4050.000'], [4, '4000.000']]);
    assert.deepEqual(s.totals, { in: '5000.000', out: '1000.000', balance: '4000.000' });
    assert.deepEqual(s.period, { from: '2026-10-13', to: '2026-11-08' });
    assert.equal(s.entries[1].date, '2026-10-13');
    const list = (await acc.get('/api/custodies')).data.items.find((k) => k.id === id);
    assert.deepEqual([list.received, list.spent, list.returned, list.balance], ['5000.000', '950.000', '50.000', '4000.000']);
  });

  test('الصرف يدخل مصاريف الشركة، والاستلام والإرجاع لا', async () => {
    const oct = (await acc.get('/api/expenses?month=2026-10')).data.items.filter((e) => e.reference === 'عهدة معتصم شوبانة');
    const nov = (await acc.get('/api/expenses?month=2026-11')).data.items.filter((e) => e.reference === 'عهدة معتصم شوبانة');
    assert.deepEqual(oct.map((e) => [e.category, Number(e.amount)]), [['MAINTENANCE', 150]]);
    assert.deepEqual(nov.map((e) => [e.category, Number(e.amount)]), [['UTILITIES', 800]]);
  });

  test('مصروف العهدة يُلغى من الكشف فقط، فيلغى مصروفه ويرجع المبلغ للرصيد', async () => {
    const s = await statement();
    const net = s.entries.find((e) => e.description === 'نت قيقا');
    const exp = (await acc.get('/api/expenses?month=2026-11')).data.items.find((e) => e.expense_no === net.expenseNo);
    assert.equal((await acc.post(`/api/expenses/${exp.id}/void`, { reason: 'خطأ' })).status, 409);
    assert.equal((await acc.post(`/api/custody-entries/${net.id}/void`, { reason: 'مكرر' })).status, 200);
    const after = await statement();
    assert.equal(after.totals.balance, '4800.000');
    assert.equal(after.entries.find((e) => e.id === net.id).voided, true);
    assert.deepEqual(after.entries.filter((e) => !e.voided).map((e) => e.no), [1, 2, 3]);
    const voided = (await acc.get('/api/expenses?month=2026-11')).data.items.find((e) => e.id === exp.id);
    assert.ok(voided.voided_at);
    assert.equal((await acc.post(`/api/custody-entries/${net.id}/void`, { reason: 'مكرر' })).status, 404);
  });

  test('التحقق: الصرف يحتاج بندًا، والمبلغ موجب', async () => {
    assert.equal((await add({ kind: 'EXPENSE', entryDate: '2026-11-08', description: 'بلا بند', amount: '10' })).status, 422);
    assert.equal((await add({ kind: 'RECEIPT', entryDate: '2026-11-08', description: 'سالب', amount: '-5' })).status, 422);
    assert.equal((await statement()).totals.balance, '4800.000');
  });
});
