import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const one = async (sql, p) => (await query(sql, p)).rows[0];
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };
let sales, ops, acc;
before(async () => { sales = await asRole('sales@auction.ly'); ops = await asRole('ops@auction.ly'); acc = await asRole('accountant@auction.ly'); });
const soon = (min) => new Date(Date.now() + min * 60_000).toISOString();

describe('العملاء', () => {
  test('إنشاء عميل بدون حساب، ومنع تكرار الهاتف والهوية، والصلاحيات', async () => {
    const r = await sales.post('/api/customers', { fullName: 'معرض النور للسيارات', customerType: 'DEALER', phone: '0925551234', nationalId: '119900011122', city: 'طرابلس' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.code, /^C-\d{4,5}$/);
    assert.equal((await sales.post('/api/customers', { fullName: 'مكرر', phone: '092-555-1234' })).data.error.code, 'DUPLICATE_PHONE');
    assert.equal((await sales.post('/api/customers', { fullName: 'مكرر هوية', nationalId: '119900011122' })).data.error.code, 'DUPLICATE_ID');
    assert.equal((await ops.post('/api/customers', { fullName: 'ممنوع' })).status, 403);
    const list = await sales.get('/api/customers?q=النور');
    assert.equal(list.data.items.length, 1);
    assert.match(list.data.items[0].phone, /\*/);
  });
  test('تغيير حالة التحقق KYC', async () => {
    const c = await one(`SELECT id FROM customers WHERE full_name = 'معرض النور للسيارات'`);
    assert.equal((await sales.patch(`/api/customers/${c.id}`, { kycStatus: 'VERIFIED' })).status, 200);
    assert.equal((await sales.patch(`/api/customers/${c.id}`, { kycStatus: 'BAD' })).status, 422);
  });
});

describe('إنشاء المزاد وتسجيل المزايدين والتأمين', () => {
  let eventId, lotId, vehicleId, custA, custB, regA;
  test('إنشاء مزاد؛ مواعيد خاطئة مرفوضة؛ غير المبيعات ممنوع', async () => {
    assert.equal((await sales.post('/api/auctions', { title: 'مزاد', startsAt: soon(-5), endsAt: soon(-10) })).data.error.code, 'BAD_TIMES');
    assert.equal((await ops.post('/api/auctions', { title: 'مزاد العمليات', startsAt: soon(0), endsAt: soon(60) })).status, 403);
    const r = await sales.post('/api/auctions', { title: 'مزاد الاختبار', startsAt: soon(-1), endsAt: soon(90), depositRequiredLyd: '3000' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    eventId = r.data.id;
    assert.equal(r.data.status, 'SCHEDULED');
  });
  test('تسجيل مزايدين: رقم مزايدة متسلسل، والتكرار مرفوض، والتأمين PENDING لا يسمح بالمزايدة', async () => {
    custA = (await one(`SELECT id FROM customers WHERE code = 'C-00001'`)).id;
    custB = (await one(`SELECT id FROM customers WHERE code = 'C-00002'`)).id;
    const a = await sales.post(`/api/auctions/${eventId}/registrations`, { customerId: custA });
    const b = await sales.post(`/api/auctions/${eventId}/registrations`, { customerId: custB });
    assert.equal(a.status, 201); assert.equal(a.data.paddle_no, 101); assert.equal(b.data.paddle_no, 102);
    assert.equal(a.data.deposit_status, 'PENDING'); assert.equal(Number(a.data.deposit_amount_lyd), 3000);
    regA = a.data.id;
    assert.equal((await sales.post(`/api/auctions/${eventId}/registrations`, { customerId: custA })).data.error.code, 'ALREADY');
    vehicleId = (await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' LIMIT 1`)).id;
    const lot = await sales.post(`/api/auctions/${eventId}/lots`, { vehicleId, startingPrice: '20000' });
    assert.equal(lot.status, 201); lotId = lot.data.id;
    await query(`UPDATE auction_lots SET status = 'OPEN' WHERE id = $1`, [lotId]);
    const { placeBid } = await import('../../src/services/auctions.js');
    await assert.rejects(placeBid(lotId, { amount: '20000', customerId: custA }, { id: null }), (e) => e.code === 'DEPOSIT_REQUIRED');
  });
  test('اعتماد التأمين يمكّن المزايدة؛ مسار الحالات محكوم؛ لا إفراج عن صاحب أعلى مزايدة', async () => {
    assert.equal((await sales.patch(`/api/registrations/${regA}`, { depositStatus: 'HELD' })).status, 200);
    assert.equal((await sales.patch(`/api/registrations/${regA}`, { depositStatus: 'HELD' })).data.error.code, 'BAD_FLOW');
    const { placeBid } = await import('../../src/services/auctions.js');
    const r = await placeBid(lotId, { amount: '20000', customerId: custA }, { id: null, ip: '1.1.1.1' });
    assert.equal(r.leading, true);
    assert.equal((await sales.patch(`/api/registrations/${regA}`, { depositStatus: 'RELEASED' })).data.error.code, 'LEADING');
    assert.equal((await acc.patch(`/api/registrations/${regA}`, { depositStatus: 'FORFEITED' })).status, 200);
  });
  test('لا يُسحب لوت عليه مزايدات ولا يُلغى مزاد عليه مزايدات', async () => {
    assert.equal((await sales.post(`/api/lots/${lotId}/cancel`)).data.error.code, 'HAS_BIDS');
    assert.equal((await sales.post(`/api/auctions/${eventId}/cancel`)).data.error.code, 'HAS_BIDS');
  });
  test('إلغاء مزاد بلا مزايدات يعيد سياراته للمعرض ويفرج عن التأمينات', async () => {
    const ev = (await sales.post('/api/auctions', { title: 'مزاد للإلغاء', startsAt: soon(30), endsAt: soon(120), depositRequiredLyd: '1000' })).data;
    const v = await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' LIMIT 1`);
    assert.equal((await sales.post(`/api/auctions/${ev.id}/lots`, { vehicleId: v.id, startingPrice: '15000' })).status, 201);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [v.id])).status, 'IN_AUCTION');
    const reg = (await sales.post(`/api/auctions/${ev.id}/registrations`, { customerId: custB })).data;
    await sales.patch(`/api/registrations/${reg.id}`, { depositStatus: 'HELD' });
    const r = await sales.post(`/api/auctions/${ev.id}/cancel`);
    assert.equal(r.status, 200); assert.equal(r.data.cancelledLots, 1);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [v.id])).status, 'IN_STOCK');
    assert.equal((await one('SELECT deposit_status FROM bidder_registrations WHERE id = $1', [reg.id])).deposit_status, 'RELEASED');
    assert.equal((await sales.post(`/api/auctions/${ev.id}/cancel`)).data.error.code, 'FINISHED');
  });
  test('قائمة المسجلين', async () => {
    const r = await sales.get(`/api/auctions/${eventId}/registrations`);
    assert.equal(r.data.items.length, 2);
    assert.equal((await ops.get(`/api/auctions/${eventId}/registrations`)).status, 403);
  });
});

describe('البيع المباشر والدفعات', () => {
  let saleId, vehicleId, cust;
  test('بيع مباشر: يُصدر فاتورة ويحوّل السيارة إلى مباعة؛ لا يبيع المبيعات سيارة في أمريكا', async () => {
    cust = (await one(`SELECT id FROM customers WHERE code = 'C-00003'`)).id;
    vehicleId = (await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' LIMIT 1`)).id;
    const r = await sales.post(`/api/vehicles/${vehicleId}/sell`, { customerId: cust, priceLyd: '90000' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.invoice_no, /^INV-\d{4}-\d{5}$/); saleId = r.data.id;
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [vehicleId])).status, 'SOLD');
    assert.equal((await sales.post(`/api/vehicles/${vehicleId}/sell`, { customerId: cust, priceLyd: '1' })).data.error.code, 'NOT_SELLABLE');
    const us = await one(`SELECT id FROM vehicles WHERE status = 'AWAITING_PICKUP' LIMIT 1`);
    assert.equal((await sales.post(`/api/vehicles/${us.id}/sell`, { customerId: cust, priceLyd: '5000' })).data.error.code, 'NOT_SELLABLE');
    assert.equal((await ops.post(`/api/vehicles/${vehicleId}/sell`, { customerId: cust, priceLyd: '1' })).status, 403);
  });
  test('دفعات بالدينار والدولار (بسعر اليوم) وحماية من الدفع الزائد', async () => {
    assert.equal((await acc.post(`/api/sales/${saleId}/payments`, { amount: '40000', currency: 'LYD', method: 'BANK_TRANSFER', reference: 'TRF-1' })).status, 201);
    const usd = await acc.post(`/api/sales/${saleId}/payments`, { amount: '1000', currency: 'USD', method: 'CASH' });
    assert.equal(usd.status, 201, JSON.stringify(usd.data));
    const rate = Number((await one(`SELECT rate_to_lyd FROM exchange_rates WHERE currency = 'USD' ORDER BY effective_date DESC LIMIT 1`)).rate_to_lyd);
    assert.ok(Math.abs(Number(usd.data.paidLyd) - (40000 + 1000 * rate)) < 0.01);
    assert.equal((await acc.post(`/api/sales/${saleId}/payments`, { amount: '60000', currency: 'LYD', method: 'CASH' })).data.error.code, 'OVERPAID');
    const rest = await acc.post(`/api/sales/${saleId}/payments`, { amount: String(Math.round(Number(usd.data.remainingLyd))), currency: 'LYD', method: 'CASH' });
    assert.equal(rest.status, 201);
    assert.equal((await ops.post(`/api/sales/${saleId}/payments`, { amount: '1', currency: 'LYD', method: 'CASH' })).status, 403);
  });
  test('ملف السيارة يعرض البيع ودفعاته', async () => {
    const v = await sales.get(`/api/vehicles/${vehicleId}`);
    assert.equal(v.data.sale.id, saleId);
    assert.equal(v.data.sale.payments.length, 3);
  });
});

describe('الشحنات والجمارك والموردون', () => {
  let shipId, cars;
  test('إنشاء مورد (والمكرر مرفوض) وشحنة برقم حاوية صحيح فقط', async () => {
    assert.equal((await ops.post('/api/vendors', { name: 'خط ملاحي تجريبي', vendorType: 'SHIPPING_LINE', country: 'DK' })).status, 201);
    assert.equal((await ops.post('/api/vendors', { name: 'خط ملاحي تجريبي', vendorType: 'SHIPPING_LINE' })).data.error.code, 'DUPLICATE');
    assert.equal((await ops.post('/api/shipments', { polCode: 'USHOU', podCode: 'LYMRA', containerNo: 'bad' })).status, 422);
    assert.equal((await ops.post('/api/shipments', { polCode: 'USHOU', podCode: 'USHOU' })).data.error.code, 'BAD_PORT');
    const r = await ops.post('/api/shipments', { polCode: 'USHOU', podCode: 'LYMRA', containerNo: 'MSCU7654321', billOfLading: 'BL-TEST-1', capacity: 2, etd: '2026-11-10', eta: '2026-12-08', vesselName: 'MSC TEST' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.shipment_no, /^SH-\d{4}-\d{4}$/); shipId = r.data.id;
    assert.equal((await ops.post('/api/shipments', { polCode: 'USHOU', podCode: 'LYMRA', billOfLading: 'BL-TEST-1' })).data.error.code, 'DUPLICATE_BL');
    assert.equal((await acc.post('/api/shipments', { polCode: 'USHOU', podCode: 'LYMRA' })).status, 403);
  });
  test('شحنة فارغة لا تغادر؛ التحميل يتطلب سيارة في مستودع التصدير؛ والسعة تُحترم', async () => {
    assert.equal((await ops.patch(`/api/shipments/${shipId}`, { status: 'DEPARTED' })).data.error.code, 'EMPTY');
    cars = (await query(`SELECT id FROM vehicles WHERE status = 'AT_US_WAREHOUSE' ORDER BY stock_no LIMIT 3`)).rows;
    assert.equal(cars.length, 3);
    const notReady = await one(`SELECT id FROM vehicles WHERE status = 'PURCHASED' LIMIT 1`);
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: notReady.id })).data.error.code, 'NOT_READY');
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: cars[0].id })).status, 201);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [cars[0].id])).status, 'LOADED');
    assert.equal((await one('SELECT status FROM shipments WHERE id = $1', [shipId])).status, 'LOADING');
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: cars[0].id })).data.error.code, 'ALREADY');
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: cars[1].id })).status, 201);
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: cars[2].id })).data.error.code, 'FULL');
  });
  test('إنزال سيارة قبل المغادرة يعيدها للمستودع', async () => {
    assert.equal((await ops.delete(`/api/shipments/${shipId}/vehicles/${cars[1].id}`)).status, 200);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [cars[1].id])).status, 'AT_US_WAREHOUSE');
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: cars[1].id })).status, 201);
  });
  test('المغادرة تنقل السيارات إلى "في البحر" وتسجل حدثًا؛ والرجوع للخلف وإضافة سيارة بعد المغادرة مرفوضان', async () => {
    assert.equal((await ops.patch(`/api/shipments/${shipId}`, { status: 'DEPARTED' })).status, 200);
    for (const c of cars.slice(0, 2)) assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [c.id])).status, 'IN_TRANSIT_SEA');
    const s = await one('SELECT status, atd FROM shipments WHERE id = $1', [shipId]);
    assert.equal(s.status, 'DEPARTED'); assert.ok(s.atd);
    assert.ok((await one(`SELECT 1 AS x FROM shipment_events WHERE shipment_id = $1 AND event_code = 'DEPA'`, [shipId])));
    assert.equal((await ops.patch(`/api/shipments/${shipId}`, { status: 'LOADING' })).data.error.code, 'BACKWARDS');
    assert.equal((await ops.post(`/api/shipments/${shipId}/vehicles`, { vehicleId: cars[2].id })).data.error.code, 'SHIPPED');
    assert.equal((await ops.delete(`/api/shipments/${shipId}/vehicles/${cars[0].id}`)).data.error.code, 'SHIPPED');
  });
  test('الوصول ينقلها إلى "في الميناء"، ثم يُفتح البيان الجمركي مرة واحدة بميناء الشحنة', async () => {
    assert.equal((await ops.patch(`/api/shipments/${shipId}`, { status: 'ARRIVED' })).status, 200);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [cars[0].id])).status, 'AT_PORT_LIBYA');
    const early = await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' LIMIT 1`);
    assert.equal((await ops.post(`/api/vehicles/${early.id}/customs`, {})).data.error.code, 'NOT_AT_PORT');
    const broker = (await ops.post('/api/vendors', { name: 'مخلص تجريبي', vendorType: 'CUSTOMS_BROKER' })).data;
    const r = await ops.post(`/api/vehicles/${cars[0].id}/customs`, { brokerId: broker.id });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const d = await one(`SELECT cd.status, p.code FROM customs_declarations cd JOIN ports p ON p.id = cd.port_id WHERE cd.vehicle_id = $1`, [cars[0].id]);
    assert.equal(d.status, 'DOCS_PENDING'); assert.equal(d.code, 'LYMRA');
    assert.equal((await ops.post(`/api/vehicles/${cars[0].id}/customs`, {})).data.error.code, 'EXISTS');
    // ودورة الجمارك الكاملة تنقل السيارة (اختبار تكاملي مع المسار القائم)
    const cd = await one('SELECT id FROM customs_declarations WHERE vehicle_id = $1', [cars[0].id]);
    assert.equal((await ops.patch(`/api/customs/${cd.id}`, { status: 'SUBMITTED', declarationNo: 'CD/T/1' })).status, 200);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [cars[0].id])).status, 'IN_CUSTOMS');
  });
  test('الإفراج المباشر من "بانتظار المستندات" يمر بالمرحلتين فتصبح السيارة "مُفرجًا عنها"', async () => {
    const car = await one(`SELECT id FROM vehicles WHERE status = 'AT_PORT_LIBYA' AND id NOT IN (SELECT vehicle_id FROM customs_declarations) LIMIT 1`);
    const d = (await ops.post(`/api/vehicles/${car.id}/customs`, {})).data;
    assert.equal((await ops.patch(`/api/customs/${d.id}`, { status: 'RELEASED', declarationNo: 'CD/DIRECT/1' })).status, 200);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [car.id])).status, 'CUSTOMS_CLEARED');
    const hist = (await query(`SELECT to_status FROM vehicle_status_history WHERE vehicle_id = $1 ORDER BY id DESC LIMIT 2`, [car.id])).rows.map((r) => r.to_status);
    assert.deepEqual(hist, ['CUSTOMS_CLEARED', 'IN_CUSTOMS']);
  });
});
