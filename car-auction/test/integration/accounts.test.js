import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const one = async (sql, p) => (await query(sql, p)).rows[0];
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };
const sumBy = (acc, cur) => acc.summary.find((s) => s.currency === cur);

let admin, ops, acc, sales, viewer, bidder, cust, cust2, vendor, carUsd, carLyd;
const VIN1 = '1HGCM82633A004352', VIN2 = '2T1BURHE8JC034566';
before(async () => {
  [admin, ops, acc, sales, viewer, bidder] = await Promise.all(['admin', 'ops', 'accountant', 'sales', 'viewer', 'bidder1'].map((r) => asRole(`${r}@auction.ly`)));
  cust = (await sales.post('/api/customers', { fullName: 'معرض الأمانة', phone: '0911112222' })).data.id;
  cust2 = (await sales.post('/api/customers', { fullName: 'عميل ثان', phone: '0911113333' })).data.id;
  vendor = (await acc.post('/api/vendors', { name: 'وسيط الشراء التجريبي', vendorType: 'OTHER', country: 'US' })).data.id;
  // سعر دولار معروف لليوم (يطغى على سعر البذر) ليكون الحساب في الاختبار واضحًا
  await query(`DELETE FROM exchange_rates WHERE currency = 'USD' AND effective_date = current_date`);
  await query(`INSERT INTO exchange_rates (currency, rate_to_lyd, effective_date, source) VALUES ('USD', 7.2, current_date, 'MANUAL')`);
});

describe('ربط السيارة بالعميل والمورد', () => {
  test('إضافة سيارة لعميل بسعر متفق عليه ومن مورد: تكاليف الشراء تُنسب للمورد', async () => {
    const r = await ops.post('/api/vehicles', { vin: VIN1, year: 2022, make: 'Toyota', model: 'Camry', source: 'COPART', lotNumber: '55667788',
      purchasePriceUsd: '8000', buyerFeeUsd: '500', customerId: cust, customerPrice: '10000', customerCurrency: 'USD', vendorId: vendor });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    carUsd = r.data.id;
    const v = await one('SELECT customer_id, customer_price, customer_currency, vendor_id FROM vehicles WHERE id = $1', [carUsd]);
    assert.deepEqual([v.customer_id, v.customer_price, v.customer_currency, v.vendor_id], [cust, '10000.000', 'USD', vendor]);
    const lines = await query('SELECT vendor_id FROM vehicle_costs WHERE vehicle_id = $1', [carUsd]);
    assert.ok(lines.rows.length === 2 && lines.rows.every((l) => l.vendor_id === vendor));
    const r2 = await ops.post('/api/vehicles', { vin: VIN2, year: 2018, make: 'Toyota', model: 'Corolla', customerId: cust, customerPrice: '50000', customerCurrency: 'LYD' });
    assert.equal(r2.status, 201, JSON.stringify(r2.data));
    carLyd = r2.data.id;
  });

  test('السعر بلا عميل مرفوض، والمزايد لا يرى بيانات الصفقة', async () => {
    const r = await ops.post('/api/vehicles', { vin: '3VWFE21C04M000001', year: 2020, make: 'VW', model: 'Jetta', customerPrice: '100' });
    assert.equal(r.data.error.code, 'PRICE_WITHOUT_CUSTOMER');
    const seen = await bidder.get(`/api/vehicles/${carUsd}`);
    if (seen.status === 200) for (const k of ['customer_id', 'customer_price', 'vendor_id']) assert.equal(seen.data[k], undefined, k);
    assert.equal((await bidder.get(`/api/vehicles/${carUsd}/deal`)).status, 403);
    assert.equal((await bidder.get(`/api/accounts/customers/${cust}`)).status, 403);
  });
});

describe('حساب العميل: دفعات بعملات مختلفة', () => {
  test('دفعة بالدولار على السيارة + دفعة بالدينار تُخصم من رصيد الدولار بسعر متفق عليه', async () => {
    let r = await acc.post(`/api/accounts/customers/${cust}/payments`, { amount: '3000', currency: 'USD', method: 'CASH', vehicleId: carUsd });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    r = await sales.post(`/api/accounts/customers/${cust}/payments`, { amount: '7500', currency: 'LYD', settleCurrency: 'USD', fxRate: '7.5', method: 'CASH' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.settle_amount, '1000.000');
    const a = (await acc.get(`/api/accounts/customers/${cust}`)).data;
    assert.deepEqual(sumBy(a, 'USD'), { currency: 'USD', charged: '10000.000', paid: '4000.000', balance: '6000.000' });
    assert.deepEqual(sumBy(a, 'LYD'), { currency: 'LYD', charged: '50000.000', paid: '0.000', balance: '50000.000' });
    const car = a.vehicles.find((v) => v.vehicleId === carUsd);
    assert.equal(car.remaining, '6000.000');
  });

  test('دفعة دينار على الحساب تُوزَّع على السيارة المستحقة بالدينار، وسعر الصرف الافتراضي من الجدول', async () => {
    let r = await acc.post(`/api/accounts/customers/${cust}/payments`, { amount: '20000', currency: 'LYD', method: 'BANK_TRANSFER', reference: 'TR-1' });
    assert.equal(r.status, 201);
    r = await acc.post(`/api/accounts/customers/${cust}/payments`, { amount: '100', currency: 'USD', settleCurrency: 'LYD', method: 'CASH' });
    assert.equal(r.data.fx_rate, '7.200000');
    assert.equal(r.data.settle_amount, '720.000');
    const a = (await acc.get(`/api/accounts/customers/${cust}`)).data;
    assert.equal(sumBy(a, 'LYD').balance, '29280.000');
    assert.equal(a.vehicles.find((v) => v.vehicleId === carLyd).remaining, '29280.000');
    // الكشف: الرصيد المتراكم الأخير لكل عملة = الرصيد الكلي
    for (const cur of ['USD', 'LYD']) assert.equal(a.lines.filter((l) => l.currency === cur).at(-1).balance, sumBy(a, cur).balance);
    // في اليوم نفسه: المستحق قبل الدفعة، فلا رصيد سالب وهمي في منتصف الكشف
    assert.ok(a.lines.every((l) => Number(l.balance) >= 0), JSON.stringify(a.lines.map((l) => [l.type, l.balance])));
  });

  test('التحويل بين عملتين أجنبيتين مرفوض، وسيارة ليست في الحساب مرفوضة', async () => {
    assert.equal((await acc.post(`/api/accounts/customers/${cust}/payments`, { amount: '10', currency: 'USD', settleCurrency: 'EUR', method: 'CASH' })).data.error.code, 'BAD_CONVERSION');
    assert.equal((await acc.post(`/api/accounts/customers/${cust2}/payments`, { amount: '10', currency: 'USD', method: 'CASH', vehicleId: carUsd })).data.error.code, 'VEHICLE_NOT_IN_ACCOUNT');
  });

  test('إلغاء دفعة يعيد الرصيد ويبقى ظاهرًا في الكشف', async () => {
    const p = await one(`SELECT id FROM account_payments WHERE customer_id = $1 AND reference = 'TR-1'`, [cust]);
    assert.equal((await sales.post(`/api/account-payments/${p.id}/void`, { reason: 'خطأ' })).status, 403);
    assert.equal((await acc.post(`/api/account-payments/${p.id}/void`, { reason: 'حوالة مرتجعة' })).status, 200);
    const a = (await acc.get(`/api/accounts/customers/${cust}`)).data;
    assert.equal(sumBy(a, 'LYD').balance, '49280.000');
    assert.ok(a.lines.some((l) => l.type === 'VOID' && l.label.includes('حوالة مرتجعة')));
    assert.equal((await acc.post(`/api/account-payments/${p.id}/void`, { reason: 'مرة ثانية' })).status, 404);
  });

  test('قائمة أرصدة العملاء', async () => {
    const r = await viewer.get('/api/accounts/customers?q=الأمانة');
    assert.equal(r.status, 200);
    const row = r.data.items.find((x) => x.id === cust);
    assert.equal(row.vehicles, 2);
    assert.equal(Number(row.balances.find((b) => b.currency === 'USD').balance), 6000);
  });
});

describe('حساب المورد', () => {
  test('المستحق = تكاليف الشراء باسمه، والدفعة بالدينار تُحوَّل للدولار', async () => {
    assert.equal((await ops.post(`/api/accounts/vendors/${vendor}/payments`, { amount: '1', currency: 'USD', method: 'CASH' })).status, 403);
    const r = await acc.post(`/api/accounts/vendors/${vendor}/payments`, { amount: '36000', currency: 'LYD', settleCurrency: 'USD', fxRate: '7.2', method: 'BANK_TRANSFER', vehicleId: carUsd });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const a = (await ops.get(`/api/accounts/vendors/${vendor}`)).data;
    assert.deepEqual(sumBy(a, 'USD'), { currency: 'USD', charged: '8500.000', paid: '5000.000', balance: '3500.000' });
    const d = (await acc.get(`/api/vehicles/${carUsd}/deal`)).data;
    assert.equal(d.vendor.lines[0].remaining, '3500.000');
    assert.equal(d.customer.lines[0].remaining, '6000.000');
    const vl = (await acc.get('/api/accounts/vendors?q=وسيط')).data.items[0];
    assert.equal(Number(vl.balances[0].balance), 3500);
  });

  test('تغيير المورد ينقل تكاليف الشراء لحسابه الجديد', async () => {
    const v2 = (await acc.post('/api/vendors', { name: 'مورد بديل', vendorType: 'AUCTION', country: 'US' })).data.id;
    assert.equal((await ops.put(`/api/vehicles/${carUsd}/deal`, { vendorId: v2 })).status, 200);
    assert.equal(sumBy((await acc.get(`/api/accounts/vendors/${v2}`)).data, 'USD').charged, '8500.000');
    assert.equal(sumBy((await acc.get(`/api/accounts/vendors/${vendor}`)).data, 'USD').charged, '0.000');
    assert.equal((await ops.put(`/api/vehicles/${carUsd}/deal`, { vendorId: vendor })).status, 200);
  });
});

describe('بنود التكلفة المعلَّمة «مسددة»', () => {
  test('تُحتسب مدفوعة في حساب المورد (في الكشف وفي قائمة الأرصدة)', async () => {
    const v3 = (await acc.post('/api/vendors', { name: 'شاحنات الاختبار', vendorType: 'TOWING', country: 'US' })).data.id;
    const cat = (await one(`SELECT code FROM cost_categories WHERE stage = 'US_LOGISTICS' LIMIT 1`)).code;
    let r = await acc.post(`/api/vehicles/${carUsd}/costs`, { categoryCode: cat, vendorId: v3, amount: '400', currency: 'USD', isPaid: true, incurredAt: new Date().toISOString().slice(0, 10) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    r = await acc.post(`/api/vehicles/${carUsd}/costs`, { categoryCode: cat, vendorId: v3, amount: '250', currency: 'USD', incurredAt: new Date().toISOString().slice(0, 10) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const a = (await acc.get(`/api/accounts/vendors/${v3}`)).data;
    assert.deepEqual(sumBy(a, 'USD'), { currency: 'USD', charged: '650.000', paid: '400.000', balance: '250.000' });
    const row = (await acc.get('/api/accounts/vendors?q=شاحنات الاختبار')).data.items.find((x) => x.id === v3);
    assert.equal(Number(row.balances[0].balance), 250);
  });
});

describe('السيارة المحجوزة لعميل', () => {
  test('لا تُدرج في مزاد ولا تُباع مباشرة لغيره، وتُعلَّم مباعة يدويًا عند التسليم', async () => {
    const v = await one(`SELECT id, version FROM vehicles WHERE status = 'IN_STOCK' AND customer_id IS NULL LIMIT 1`);
    assert.equal((await sales.put(`/api/vehicles/${v.id}/deal`, { customerId: cust2, customerPrice: '42000', customerCurrency: 'LYD' })).status, 200);
    assert.equal((await sales.post(`/api/vehicles/${v.id}/sell`, { customerId: cust, priceLyd: '40000' })).data.error.code, 'RESERVED');
    const ev = (await sales.post('/api/auctions', { title: 'مزاد الحجز', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString() })).data;
    assert.equal((await sales.post(`/api/auctions/${ev.id}/lots`, { vehicleId: v.id, startingPrice: '1000' })).data.error.code, 'RESERVED');
    const d = (await ops.get(`/api/vehicles/${v.id}`)).data;
    assert.ok(d.next_statuses.includes('SOLD'));
    assert.equal((await ops.post(`/api/vehicles/${v.id}/status`, { to: 'SOLD' })).status, 200);
    // سيارة غير محجوزة: «مباعة» يدويًا ممنوعة
    const free = await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' AND customer_id IS NULL LIMIT 1`);
    assert.equal((await ops.post(`/api/vehicles/${free.id}/status`, { to: 'SOLD' })).data.error.code, 'SYSTEM_ONLY');
  });

  test('إزالة العميل من السيارة (null) تعيدها حرة', async () => {
    assert.equal((await ops.put(`/api/vehicles/${carLyd}/deal`, { customerId: null })).status, 200);
    const v = await one('SELECT customer_id, customer_price FROM vehicles WHERE id = $1', [carLyd]);
    assert.deepEqual([v.customer_id, v.customer_price], [null, null]);
    // دفعات العميل تبقى في حسابه (رصيد له بالدينار)
    const a = (await acc.get(`/api/accounts/customers/${cust}`)).data;
    assert.equal(sumBy(a, 'LYD').charged, '0.000');
    assert.equal(Number(sumBy(a, 'LYD').balance), -720);
  });
});
