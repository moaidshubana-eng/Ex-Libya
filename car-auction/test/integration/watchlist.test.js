import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
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
    assert.equal((await ops.patch(`/api/watchlist/${id}`, { city: 'X' })).status, 422);
    assert.equal((await ops.post(`/api/watchlist/${id}/convert`, { vin: '3KPF24AD0KE132747' })).status, 422);
  });

  test('فشل إنشاء السيارة (VIN مكرر) لا يغيّر حالة اللوت', async () => {
    const r = await ops.post('/api/watchlist', { source: 'COPART', lotNumber: '73729736', year: 2019, make: 'KIA', model: 'FORTE' });
    assert.equal(r.status, 201);
    const c = await ops.post(`/api/watchlist/${r.data.id}/convert`, { vin: '3KPF24AD0KE132747' });
    assert.equal(c.status, 409);
    assert.equal((await ops.get(`/api/watchlist/${r.data.id}`)).data.status, 'WATCHING');
  });
});
