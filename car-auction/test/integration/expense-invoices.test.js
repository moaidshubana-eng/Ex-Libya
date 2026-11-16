import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { server, base } = await startApp();
after(() => stopApp(server));
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };

// أصغر PNG صالح (1×1) وملف PDF بسيط
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

let acc, viewer, id;
before(async () => { acc = await asRole('accountant@auction.ly'); viewer = await asRole('viewer@auction.ly'); });

describe('فواتير المصاريف ومستحقات من دفع من ماله', () => {
  test('مصروف دفعه موظف من ماله يظهر مستحقًا له', async () => {
    const r = await acc.post('/api/expenses', { category: 'OFFICE', description: 'كاميرات مراقبة', amount: '3780', currency: 'LYD', expenseDate: '2026-11-08', paidBy: 'معتصم شوبانة', method: 'BANK_TRANSFER' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    id = r.data.id;
    assert.equal(r.data.paid_by, 'معتصم شوبانة');
    const owed = (await acc.get('/api/expenses/owed')).data.people;
    assert.deepEqual(owed.map((p) => [p.name, p.totalLyd, p.items.length]), [['معتصم شوبانة', '3780.000', 1]]);
  });

  test('إرفاق صورة وPDF؛ النوع من البايتات لا من الاسم', async () => {
    assert.equal((await acc.post(`/api/expenses/${id}/attachments`, { data: `data:image/png;base64,${PNG}`, filename: 'فاتورة.png' })).status, 201);
    assert.equal((await acc.post(`/api/expenses/${id}/attachments`, { data: PDF, filename: 'invoice.pdf' })).status, 201);
    assert.equal((await acc.post(`/api/expenses/${id}/attachments`, { data: Buffer.from('<svg/>').toString('base64'), filename: 'x.pdf' })).status, 415);
    assert.equal((await viewer.post(`/api/expenses/${id}/attachments`, { data: PDF })).status, 403);
    const list = (await acc.get('/api/expenses?month=2026-11')).data.items.find((e) => e.id === id).attachments;
    assert.deepEqual(list.map((a) => a.mime), ['image/png', 'application/pdf']);
    const file = await fetch(`${base}/api/expense-attachments/${list[1].id}`, { headers: { cookie: viewer.cookie } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await file.arrayBuffer()).toString('ascii', 0, 5), '%PDF-');
    assert.equal((await fetch(`${base}/api/expense-attachments/${list[1].id}`)).status, 401);
    assert.equal((await acc.post(`/api/expense-attachments/${list[0].id}/remove`)).status, 200);
    assert.equal((await acc.get('/api/expenses?month=2026-11')).data.items.find((e) => e.id === id).attachments.length, 1);
  });

  test('ردّ المبلغ يخرجه من المستحقات، ولا يُردّ مرتين', async () => {
    assert.equal((await viewer.post(`/api/expenses/${id}/reimburse`, {})).status, 403);
    assert.equal((await acc.post(`/api/expenses/${id}/reimburse`, { note: 'حوالة' })).status, 200);
    assert.equal((await acc.post(`/api/expenses/${id}/reimburse`, {})).status, 409);
    assert.deepEqual((await acc.get('/api/expenses/owed')).data.people, []);
    const e = (await acc.get('/api/expenses?month=2026-11')).data.items.find((x) => x.id === id);
    assert.ok(e.reimbursed_at);
  });

  test('مصروف العهدة يحمل فواتيره في الكشف', async () => {
    const k = (await acc.post('/api/custodies', { holderName: 'تجربة' })).data;
    const en = (await acc.post(`/api/custodies/${k.id}/entries`, { kind: 'EXPENSE', entryDate: '2026-11-10', description: 'مواد تنظيف', amount: '154', category: 'OFFICE' })).data;
    assert.equal((await acc.post(`/api/expenses/${en.expense_id}/attachments`, { data: PNG })).status, 201);
    const s = (await acc.get(`/api/custodies/${k.id}`)).data;
    assert.equal(s.entries[0].attachments.length, 1);
    assert.equal(s.entries[0].expenseId, en.expense_id);
  });
});
