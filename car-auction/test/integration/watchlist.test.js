import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.02, `${a} ≠ ${b}`);
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };

let ops, sales, viewer, bidder;
before(async () => {
  ops = await asRole('ops@auction.ly'); sales = await asRole('sales@auction.ly');
  viewer = await asRole('viewer@auction.ly'); bidder = await asRole('bidder1@auction.ly');
});

const lot = {
  source: 'IAAI', lotNumber: '46197727', lotUrl: 'https://www.iaai.com/vehicledetail/46697611~US', vin: '3KPF24AD0KE******',
  year: 2019, make: 'kia', model: 'forte', trim: 'LXS', odometer: 66833, primaryDamage: 'REAR', titleDoc: 'SALVAGE (TX)',
  runStatus: 'RUN_DRIVE', hasKeys: true, usState: 'tx', city: 'Lubbock', branch: 'Lubbock (TX)',
  auctionAt: '2026-11-03T15:30:00.000Z', currentBidUsd: '25', buyNowUsd: '2250', estValueUsd: '12993', maxBidUsd: '2000',
};

describe('مزادات أمريكا (لوتات قبل الشراء)', () => {
  let id;
  test('إضافة لوت: تُحفظ الولاية والمدينة والموعد والأسعار، والنصوص بأحرف كبيرة', async () => {
    const r = await sales.post('/api/watchlist', lot);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    id = r.data.id;
    assert.equal(r.data.status, 'WATCHING');
    assert.equal(r.data.us_state, 'TX');
    assert.equal(r.data.make, 'KIA');
    assert.equal(r.data.city, 'Lubbock');
    assert.equal(Number(r.data.buy_now_usd), 2250);
    assert.equal(new Date(r.data.auction_at).toISOString(), lot.auctionAt);
  });

  test('نفس اللوت مرتين يُرفض', async () => {
    const r = await ops.post('/api/watchlist', { source: 'IAAI', lotNumber: '46197727' });
    assert.equal(r.status, 409);
  });

  test('الحقول غير المعروفة والقيم الخاطئة تُرفض', async () => {
    assert.equal((await ops.post('/api/watchlist', { source: 'IAAI', lotNumber: '1234', hacker: 1 })).status, 422);
    assert.equal((await ops.post('/api/watchlist', { source: 'IAAI', lotNumber: '1234', usState: 'Texas' })).status, 422);
    assert.equal((await ops.post('/api/watchlist', { source: 'IAAI', lotNumber: '1234', lotUrl: 'javascript:alert(1)' })).status, 422);
  });

  test('الصلاحيات: الاطلاع يقرأ ولا يضيف، والمزايد لا يرى شيئًا', async () => {
    const list = await viewer.get('/api/watchlist');
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 1);
    assert.equal(list.data.counts.WATCHING, 1);
    assert.equal((await viewer.post('/api/watchlist', { source: 'COPART', lotNumber: '7777' })).status, 403);
    assert.equal((await bidder.get('/api/watchlist')).status, 403);
  });

  test('تعديل السعر وتفريغ حقل بـ null', async () => {
    const r = await ops.patch(`/api/watchlist/${id}`, { currentBidUsd: '900', maxBidUsd: null });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(Number(r.data.current_bid_usd), 900);
    assert.equal(r.data.max_bid_usd, null);
    const { rows } = await query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'WATCH_UPDATED' AND entity_id = $1`, [id]);
    assert.equal(rows[0].n, 1);
  });

  test('البحث والتصفية بالحالة', async () => {
    assert.equal((await ops.get('/api/watchlist?q=lubbock')).data.items.length, 1);
    assert.equal((await ops.get('/api/watchlist?q=camry')).data.items.length, 0);
    assert.equal((await ops.get('/api/watchlist?status=LOST')).data.items.length, 0);
  });

  test('الحالات: خسرنا ثم إعادة للمتابعة، ولا انتقال مباشر لـ«اشتريناها»', async () => {
    assert.equal((await ops.post(`/api/watchlist/${id}/status`, { to: 'LOST' })).status, 200);
    assert.equal((await ops.post(`/api/watchlist/${id}/status`, { to: 'DROPPED' })).status, 422);
    assert.equal((await ops.post(`/api/watchlist/${id}/status`, { to: 'WATCHING' })).status, 200);
    assert.equal((await ops.post(`/api/watchlist/${id}/status`, { to: 'PURCHASED' })).status, 422);
  });

  test('التحويل لسيارة يحتاج VIN كامل، والمبيعات لا تحوّل', async () => {
    assert.equal((await ops.post(`/api/watchlist/${id}/convert`, {})).data.error.code, 'BAD_VIN');
    assert.equal((await sales.post(`/api/watchlist/${id}/convert`, { vin: '3KPF24AD0KE132747' })).status, 403);
  });

  test('الصور: رفع وعرض، الأولى رئيسية، التكرار مرفوض، والاطلاع لا يرفع', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');
    const a = await sales.post(`/api/watchlist/${id}/images`, { data: `data:image/png;base64,${PNG}`, width: 1, height: 1 });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assert.equal(a.data.is_primary, true);
    assert.equal((await sales.post(`/api/watchlist/${id}/images`, { data: PNG })).status, 409);
    const b = await sales.post(`/api/watchlist/${id}/images`, { data: JPEG });
    assert.equal(b.status, 201);
    assert.equal((await viewer.post(`/api/watchlist/${id}/images`, { data: JPEG })).status, 403);
    assert.equal((await ops.post(`/api/watchlist/${id}/images`, { data: Buffer.from('<svg/>').toString('base64') })).status, 415);
    const img = await viewer.get(`/api/media/watch/${id}/${a.data.id}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await bidder.get(`/api/media/watch/${id}/${a.data.id}`)).status, 403);
    assert.equal((await sales.post(`/api/watchlist/${id}/images/${b.data.id}/primary`)).status, 200);
    const w = (await ops.get(`/api/watchlist/${id}`)).data;
    assert.deepEqual(w.images.map((i) => i.id), [b.data.id, a.data.id]);
    assert.equal((await ops.get('/api/watchlist')).data.items[0].images.length, 2);
  });

  test('اشتريناها: تُنشأ سيارة ببيانات اللوت، ويُربط اللوت بها ويُقفل', async () => {
    const r = await ops.post(`/api/watchlist/${id}/status`, { to: 'WON', finalPriceUsd: '2100' });
    assert.equal(r.status, 200);
    const c = await ops.post(`/api/watchlist/${id}/convert`, { vin: '3kpf24ad0ke132747' });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const { rows: [v] } = await query('SELECT * FROM vehicles WHERE id = $1', [c.data.id]);
    assert.equal(v.vin, '3KPF24AD0KE132747');
    assert.equal(v.make, 'KIA');
    assert.equal(v.title_type, 'SALVAGE');
    assert.equal(v.run_and_drive, true);
    assert.match(v.notes, /Lubbock/);
    const { rows: [sl] } = await query('SELECT lot_number FROM source_listings WHERE vehicle_id = $1', [v.id]);
    assert.equal(sl.lot_number, '46197727');
    const w = (await ops.get(`/api/watchlist/${id}`)).data;
    assert.equal(w.status, 'PURCHASED');
    assert.equal(w.vehicle_id, v.id);
    assert.equal(w.stock_no, v.stock_no);
    assert.equal(Number(w.final_price_usd), 2100);
    // الصور انتقلت للسيارة (والرئيسية بقيت رئيسية) ولم تبقَ نسخة في اللوت
    assert.equal(w.images.length, 0);
    const { rows: imgs } = await query('SELECT is_primary, mime FROM vehicle_images WHERE vehicle_id = $1 ORDER BY is_primary DESC', [v.id]);
    assert.equal(imgs.length, 2);
    assert.equal(imgs[0].is_primary, true);
    assert.equal(imgs[0].mime, 'image/jpeg');
    assert.equal((await ops.post(`/api/watchlist/${id}/images`, { data: 'iVBORw0KGgo=' })).status, 422);
    assert.equal((await ops.patch(`/api/watchlist/${id}`, { city: 'X' })).status, 422);
    assert.equal((await ops.post(`/api/watchlist/${id}/convert`, { vin: '3KPF24AD0KE132747' })).status, 422);
  });

  test('قائمة السيارات تعرض التكلفة بالدولار: بنود الدولار كما هي، والدينار بسعر الدولار يوم البند', async () => {
    const { rows: [r] } = await query(`SELECT effective_date::text AS d, rate_to_lyd FROM exchange_rates WHERE currency = 'USD' ORDER BY effective_date DESC LIMIT 1`);
    const v = await ops.post('/api/vehicles', { vin: '1HGCM82633A004352', year: 2003, make: 'HONDA', model: 'ACCORD', purchaseDate: r.d, purchasePriceUsd: '1000', buyerFeeUsd: '250',
      engine: '2.4L 4 cyl', transmission: 'AUTOMATIC', driveType: 'FWD', fuelType: 'Gasoline' });
    assert.equal(v.status, 201, JSON.stringify(v.data));
    // مواصفات فك الـVIN تُحفظ من نموذج الإضافة مباشرة
    const { rows: [spec] } = await query('SELECT engine, transmission, drive_type, fuel_type FROM vehicles WHERE id = $1', [v.data.id]);
    assert.deepEqual(spec, { engine: '2.4L 4 cyl', transmission: 'AUTOMATIC', drive_type: 'FWD', fuel_type: 'Gasoline' });
    const c = await ops.post(`/api/vehicles/${v.data.id}/costs`, { categoryCode: 'LY_TRANSPORT', amount: '1000', currency: 'LYD', incurredAt: r.d });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    const item = (await ops.get('/api/vehicles?q=1HGCM82633A004352')).data.items[0];
    near(Number(item.total_cost_usd), 1250 + 1000 / Number(r.rate_to_lyd));
    near(Number(item.total_cost_lyd), 1250 * Number(r.rate_to_lyd) + 1000);
  });

  test('فشل إنشاء السيارة (VIN مكرر) لا يغيّر حالة اللوت', async () => {
    const r = await ops.post('/api/watchlist', { source: 'COPART', lotNumber: '73729736', year: 2019, make: 'KIA', model: 'FORTE' });
    assert.equal(r.status, 201);
    const c = await ops.post(`/api/watchlist/${r.data.id}/convert`, { vin: '3KPF24AD0KE132747' });
    assert.equal(c.status, 409);
    assert.equal((await ops.get(`/api/watchlist/${r.data.id}`)).data.status, 'WATCHING');
  });
});
