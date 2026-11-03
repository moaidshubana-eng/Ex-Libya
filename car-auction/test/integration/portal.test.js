import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };

let sales, viewer, custA, custB, phoneA, carA, carB;
before(async () => {
  sales = await asRole('sales@auction.ly'); viewer = await asRole('viewer@auction.ly');
  const { rows: cs } = await query(`SELECT id FROM customers WHERE phone_hash IS NOT NULL ORDER BY code LIMIT 2`);
  [custA, custB] = cs.map((r) => r.id);
  const { rows: vs } = await query(`SELECT id FROM vehicles WHERE customer_id IS NULL AND status NOT IN ('SOLD','DELIVERED','CANCELLED') ORDER BY stock_no LIMIT 2`);
  [carA, carB] = vs.map((r) => r.id);
  for (const [car, cust] of [[carA, custA], [carB, custB]]) {
    const r = await sales.put(`/api/vehicles/${car}/deal`, { customerId: cust, customerPrice: '5000', customerCurrency: 'USD' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  phoneA = (await sales.get(`/api/customers/${custA}/portal`)).data.phone;
  assert.ok(phoneA);
});

describe('بوابة العملاء', () => {
  let tempPw;
  test('الموظف يفعّل الحساب ويحصل على كلمة سر مؤقتة؛ الاطلاع والمزايد لا', async () => {
    assert.equal((await viewer.post(`/api/customers/${custA}/portal`)).status, 403);
    const r = await sales.post(`/api/customers/${custA}/portal`);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.password, /^[a-z2-9]{8}$/);
    tempPw = r.data.password;
    const list = (await sales.get('/api/customers')).data.items.find((c) => c.id === custA);
    assert.equal(list.portal_active, true);
  });

  let pa;
  test('الدخول برقم الهاتف: الخطأ يُرفض، والصحيح يفتح جلسة بوابة', async () => {
    pa = client(base);
    assert.equal((await pa.post('/api/portal/login', { phone: phoneA, password: 'wrong-pass' })).status, 401);
    assert.equal((await pa.post('/api/portal/login', { phone: '0900000000', password: tempPw })).status, 401);
    const ok = await pa.post('/api/portal/login', { phone: ` ${phoneA} `, password: tempPw });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.customer.mustChange, true);
    assert.equal((await pa.get('/api/portal/me')).status, 200);
  });

  test('الجلسات منفصلة: جلسة الموظف لا تفتح البوابة، وجلسة العميل لا تفتح واجهة الموظفين', async () => {
    assert.equal((await sales.get('/api/portal/me')).status, 401);
    assert.equal((await pa.get('/api/vehicles')).status, 401);
    assert.equal((await pa.get(`/api/customers/${custA}/portal`)).status, 401);
  });

  test('العميل يرى سياراته فقط، بلا تكاليف ولا موردين', async () => {
    const r = await pa.get('/api/portal/cars');
    assert.equal(r.status, 200);
    const ids = r.data.items.map((c) => c.id);
    assert.ok(ids.includes(carA));
    assert.ok(!ids.includes(carB));
    const car = r.data.items.find((c) => c.id === carA);
    assert.equal(Number(car.price), 5000);
    assert.equal(car.currency, 'USD');
    assert.equal(Number(car.remaining), 5000);
    assert.ok(car.stage >= 0 && car.stage <= 4);
    const blob = JSON.stringify(r.data);
    for (const k of ['total_cost', 'amount_lyd', 'vendor', 'notes', 'hold_reason', 'purchase_price']) assert.ok(!blob.includes(k), k);
    assert.equal((await pa.get(`/api/portal/cars/${carB}`)).status, 404);
    assert.equal((await pa.get(`/api/portal/cars/${carA}`)).status, 200);
  });

  test('كشف الحساب', async () => {
    const r = await pa.get('/api/portal/statement');
    assert.equal(r.status, 200);
    assert.equal(r.data.summary.find((s) => s.currency === 'USD').balance, '5000.000');
    assert.ok(r.data.lines.length >= 1);
  });

  test('التتبّع العام بالكود بلا دخول ولا مبالغ', async () => {
    const { rows: [{ track_code }] } = await query('SELECT track_code FROM vehicles WHERE id = $1', [carB]);
    assert.match(track_code, /^[0-9a-f]{12}$/);
    const anon = client(base);
    const r = await anon.get(`/api/portal/track/${track_code.toUpperCase()}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.id, carB);
    assert.equal(r.data.price, undefined);
    assert.equal(r.data.remaining, undefined);
    assert.equal((await anon.get('/api/portal/track/000000000000')).status, 404);
    assert.equal((await anon.get('/api/portal/track/../../x')).status, 404);
    // كود التتبّع لا يظهر لغير الموظفين في واجهة السيارات
    const bidder = await asRole('bidder1@auction.ly');
    const { rows: [stock] } = await query(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' LIMIT 1`);
    if (stock) assert.equal((await bidder.get(`/api/vehicles/${stock.id}`)).data.track_code, undefined);
  });

  test('التتبّع برقم الهيكل بلا دخول ولا مبالغ', async () => {
    const { rows: [{ vin }] } = await query('SELECT vin FROM vehicles WHERE id = $1', [carA]);
    const anon = client(base);
    const r = await anon.get(`/api/portal/vin/${vin.toLowerCase()}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.id, carA);
    assert.equal(r.data.vin, vin);
    assert.match(r.data.trackCode, /^[0-9a-f]{12}$/);
    for (const k of ['price', 'paid', 'remaining', 'currency']) assert.equal(r.data[k], undefined, k);
    assert.equal((await anon.get('/api/portal/vin/1HGCM82633A004352')).status, 404);
    assert.equal((await anon.get('/api/portal/vin/ABC123')).status, 422);
  });

  test('تغيير كلمة السر: الحالية خطأ تُرفض، والقصيرة تُرفض، وبعد التغيير لا تعمل المؤقتة', async () => {
    assert.equal((await pa.post('/api/portal/password', { current: 'nope-nope', next: 'NewPass123' })).status, 403);
    assert.equal((await pa.post('/api/portal/password', { current: tempPw, next: 'short' })).status, 422);
    assert.equal((await pa.post('/api/portal/password', { current: tempPw, next: 'NewPass123' })).status, 200);
    assert.equal((await pa.get('/api/portal/me')).data.customer.mustChange, false);
    assert.equal((await client(base).post('/api/portal/login', { phone: phoneA, password: tempPw })).status, 401);
    assert.equal((await client(base).post('/api/portal/login', { phone: phoneA, password: 'NewPass123' })).status, 200);
  });

  test('الإيقاف ينهي الجلسات ويمنع الدخول', async () => {
    assert.equal((await sales.delete(`/api/customers/${custA}/portal`)).status, 200);
    assert.equal((await pa.get('/api/portal/me')).status, 401);
    assert.equal((await client(base).post('/api/portal/login', { phone: phoneA, password: 'NewPass123' })).status, 401);
  });

  test('القفل بعد 5 محاولات فاشلة', async () => {
    const r = await sales.post(`/api/customers/${custB}/portal`);
    const phoneB = (await sales.get(`/api/customers/${custB}/portal`)).data.phone;
    const c = client(base);
    for (let i = 0; i < 5; i++) await c.post('/api/portal/login', { phone: phoneB, password: `bad-${i}-xxxx` });
    assert.equal((await c.post('/api/portal/login', { phone: phoneB, password: r.data.password })).status, 423);
    const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('PORTAL_ACCOUNT_CREATED','PORTAL_PASSWORD_CHANGED','PORTAL_ACCOUNT_DISABLED')`);
    assert.ok(n >= 3);
  });

  test('صفحة البوابة تفتح لأي زائر', async () => {
    const r = await fetch(`${base}/portal`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /src="\/v\/[0-9a-f]{12}\/js\/portal\.js"/);
  });
});
