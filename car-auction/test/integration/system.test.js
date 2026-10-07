import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

resetDb();
const { query, tx } = await import('../../src/db.js');
const { placeBid, auctionTick } = await import('../../src/services/auctions.js');
const { syncPurchases } = await import('../../src/sync/engine.js');
const { server, base } = await startApp();
after(() => stopApp(server));

const one = async (sql, p) => (await query(sql, p)).rows[0];
const admin = client(base);
const bidder = client(base);
const accountant = client(base);
before(async () => {
  assert.equal((await admin.login('admin@auction.ly')).status, 200);
  assert.equal((await bidder.login('bidder1@auction.ly')).status, 200);
  assert.equal((await accountant.login('accountant@auction.ly')).status, 200);
});

// ===================================================================== قواعد قاعدة البيانات
describe('قاعدة البيانات تفرض قواعد الأعمال بنفسها', () => {
  test('Trigger يرفض انتقال حالة غير مسموح حتى بتحديث SQL مباشر', async () => {
    const v = await one(`SELECT id FROM vehicles WHERE status = 'PURCHASED' LIMIT 1`);
    await assert.rejects(query(`UPDATE vehicles SET status = 'IN_STOCK' WHERE id = $1`, [v.id]), /انتقال غير مسموح/);
  });
  test('رفع التعليق يعيد السيارة لحالتها السابقة فقط', async () => {
    const v = await one(`SELECT id, hold_return_status FROM vehicles WHERE status = 'ON_HOLD' LIMIT 1`);
    await assert.rejects(query(`UPDATE vehicles SET status = 'IN_STOCK' WHERE id = $1`, [v.id]), /رفع التعليق/);
    await query(`UPDATE vehicles SET status = $2 WHERE id = $1`, [v.id, v.hold_return_status]);
    const after = await one('SELECT status, hold_reason FROM vehicles WHERE id = $1', [v.id]);
    assert.equal(after.status, v.hold_return_status);
    assert.equal(after.hold_reason, null);
  });
  test('سجل التدقيق للإلحاق فقط (UPDATE/DELETE مرفوضان)', async () => {
    await query(`INSERT INTO audit_logs (action, entity) VALUES ('TEST','test')`);
    await assert.rejects(query(`UPDATE audit_logs SET action = 'X'`), /append-only/);
    await assert.rejects(query(`DELETE FROM audit_logs`), /append-only/);
  });
  test('لا يمكن تجاوز سعة الحاوية', async () => {
    const sh = await one(`SELECT sh.id FROM shipments sh WHERE (SELECT count(*) FROM shipment_vehicles WHERE shipment_id = sh.id) = 4 LIMIT 1`);
    const v = await one(`SELECT id FROM vehicles WHERE id NOT IN (SELECT vehicle_id FROM shipment_vehicles) LIMIT 1`);
    await assert.rejects(query('INSERT INTO shipment_vehicles (shipment_id, vehicle_id) VALUES ($1,$2)', [sh.id, v.id]), /ممتلئة/);
  });
  test('VIN غير صالح مرفوض بقيد CHECK', async () => {
    await assert.rejects(query(`INSERT INTO vehicles (stock_no, vin, year, make, model) VALUES ('T-1','IOQ00000000000000',2020,'X','Y')`));
  });
  test('التكلفة بالدينار تُحسب بعمود مولّد بسعر الصرف المحفوظ', async () => {
    const c = await one(`SELECT amount, fx_rate_to_lyd, amount_lyd FROM vehicle_costs WHERE currency = 'USD' LIMIT 1`);
    assert.equal(Number(c.amount_lyd), Math.round(Number(c.amount) * Number(c.fx_rate_to_lyd) * 1000) / 1000);
  });
});

// ===================================================================== الأمان عبر HTTP
describe('الأمان والصلاحيات عبر واجهة HTTP', () => {
  test('بلا جلسة → 401', async () => {
    assert.equal((await client(base).get('/api/vehicles')).status, 401);
  });
  test('المزايد لا يرى التكاليف ولا التقارير ولا لوحة المؤشرات', async () => {
    assert.equal((await bidder.get('/api/reports/costs')).status, 403);
    assert.equal((await bidder.get('/api/dashboard')).status, 403);
    assert.equal((await bidder.get('/api/integrations')).status, 403);
    const list = await bidder.get('/api/vehicles');
    assert.ok(list.data.items.every((v) => v.total_cost_lyd === null && ['IN_AUCTION', 'IN_STOCK'].includes(v.status)));
    const v = await bidder.get(`/api/vehicles/${list.data.items[0].id}`);
    assert.equal(v.data.costs, null);
    assert.equal(v.data.notes, undefined);
    assert.deepEqual(v.data.history, []);
  });
  test('المزايد لا يرى سيارة ليست معروضة للبيع', async () => {
    const v = await one(`SELECT id FROM vehicles WHERE status = 'IN_CUSTOMS' LIMIT 1`);
    assert.equal((await bidder.get(`/api/vehicles/${v.id}`)).status, 404);
  });
  test('المزايد لا يرى الحد الأدنى السري للوت', async () => {
    const lot = await one(`SELECT id FROM auction_lots WHERE status = 'OPEN' AND reserve_price IS NOT NULL LIMIT 1`);
    const r = await bidder.get(`/api/lots/${lot.id}`);
    assert.equal(r.status, 200);
    assert.ok(!('reserve_price' in r.data));
    assert.ok(!('leading_customer_id' in r.data));
    assert.ok(r.data.bids.every((b) => !('customer' in b)));
  });
  test('المحاسب لا يغيّر حالة سيارة (صلاحية العمليات فقط)', async () => {
    const v = await one(`SELECT id FROM vehicles WHERE status = 'PURCHASED' LIMIT 1`);
    assert.equal((await accountant.post(`/api/vehicles/${v.id}/status`, { to: 'AWAITING_PICKUP' })).status, 403);
  });
  test('CSRF: طلب معدِّل بغير JSON → 415، ومن أصل أجنبي → 403', async () => {
    const r = await admin.post('/api/vehicles/00000000-0000-0000-0000-000000000000/status', 'to=SOLD', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
    const r2 = await admin.post('/api/auth/logout', {}, { origin: 'https://evil.example' });
    assert.equal(r2.status, 403);
  });
  test('حقل غير معروف في الطلب يُرفض (منع Mass assignment)', async () => {
    const v = await one(`SELECT id FROM vehicles WHERE status = 'PURCHASED' LIMIT 1`);
    const r = await admin.post(`/api/vehicles/${v.id}/status`, { to: 'AWAITING_PICKUP', role: 'ADMIN' });
    assert.equal(r.status, 422);
  });
  test('محاولة حقن SQL في البحث لا تؤثر (استعلامات مُعلَمة)', async () => {
    const before = await one('SELECT count(*)::int n FROM vehicles');
    const r = await admin.get(`/api/vehicles?q=${encodeURIComponent("' OR 1=1; DROP TABLE vehicles; --")}&sort=${encodeURIComponent('v.id; DROP TABLE x')}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 0);
    assert.equal((await one('SELECT count(*)::int n FROM vehicles')).n, before.n);
  });
  test('رؤوس الأمان موجودة (CSP, nosniff, frame-deny)', async () => {
    const r = await admin.get('/api/auth/me');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  test('كوكي الجلسة httpOnly و SameSite=Strict، والرمز لا يُخزَّن صريحًا', async () => {
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'viewer@auction.ly', password: 'Demo@2026pass' }) });
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Strict/i);
    const token = decodeURIComponent(sc.split(';')[0].split('=')[1]);
    assert.equal((await query('SELECT 1 FROM user_sessions WHERE token_hash = $1', [token])).rowCount, 0);
  });
  test('قفل الحساب بعد 5 محاولات فاشلة', async () => {
    const c = client(base);
    for (let i = 0; i < 5; i++) assert.equal((await c.login('viewer@auction.ly', 'wrong-pass-123')).status, 401);
    assert.equal((await c.login('viewer@auction.ly')).status, 423);
  });
  test('تسجيل الخروج يُبطل الجلسة على الخادم', async () => {
    const c = client(base);
    await c.login('ops@auction.ly');
    const cookie = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    const r = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(r.status, 401);
  });
  test('البيانات الحساسة للعملاء مشفّرة في القاعدة ومقنّعة في الواجهة', async () => {
    const row = await one('SELECT phone_enc, national_id_enc FROM customers LIMIT 1');
    assert.match(row.phone_enc, /^v1:/);
    assert.doesNotMatch(row.phone_enc, /09\d{8}/);
    const r = await admin.get('/api/customers');
    assert.match(r.data.items[0].phone, /^\d{3}\*+\d{3}$/);
  });
});

// ===================================================================== المزايدة والتزامن
describe('المزايدة: التزامن، المزايدة الآلية، منع القنص، الإغلاق', () => {
  const actor = async () => ({ id: (await one(`SELECT id FROM users WHERE role = 'SALES'`)).id, ip: '127.0.0.1' });
  const registered = async (lotId) => (await query(
    `SELECT r.customer_id FROM bidder_registrations r JOIN auction_lots l ON l.auction_event_id = r.auction_event_id
      WHERE l.id = $1 AND r.deposit_status = 'HELD' ORDER BY r.paddle_no`, [lotId])).rows.map((r) => r.customer_id);

  test('25 مزايدة متزامنة بنفس المبلغ → واحدة فقط تُقبل', async () => {
    const lot = await one(`SELECT * FROM auction_lots WHERE status = 'OPEN' AND bid_count > 0 AND ends_at > now() + interval '20 minutes' ORDER BY lot_no LIMIT 1`);
    await query('DELETE FROM proxy_bids WHERE lot_id = $1', [lot.id]);
    const custs = (await registered(lot.id)).filter((c) => c !== lot.leading_customer_id);
    const a = await actor();
    const amount = String(Number(lot.current_price) + 1000);
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => placeBid(lot.id, { amount, customerId: custs[i % custs.length] }, a)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.code || 'ok')));
    const after = await one('SELECT bid_count, current_price FROM auction_lots WHERE id = $1', [lot.id]);
    assert.equal(after.bid_count, lot.bid_count + 1);
    assert.equal(Number(after.current_price), Number(amount));
  });

  test('40 مزايدة متزامنة بمبالغ مختلفة → سجل متصاعد بصرامة وسعر نهائي = أعلى مقبولة', async () => {
    const lot = await one(`SELECT * FROM auction_lots WHERE status = 'OPEN' AND ends_at > now() + interval '20 minutes' ORDER BY lot_no OFFSET 1 LIMIT 1`);
    await query('DELETE FROM proxy_bids WHERE lot_id = $1', [lot.id]);
    const custs = await registered(lot.id);
    const a = await actor();
    const startP = Number(lot.current_price ?? lot.starting_price);
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) =>
      placeBid(lot.id, { amount: String(startP + 1000 * (1 + Math.floor(Math.random() * 30))), customerId: custs[i % custs.length] }, a)));
    const { rows } = await query('SELECT amount FROM bids WHERE lot_id = $1 ORDER BY id', [lot.id]);
    for (let i = 1; i < rows.length; i++) assert.ok(Number(rows[i].amount) > Number(rows[i - 1].amount), 'سجل المزايدات غير متصاعد');
    const final = await one('SELECT current_price, bid_count FROM auction_lots WHERE id = $1', [lot.id]);
    assert.equal(Number(final.current_price), Number(rows.at(-1).amount));
    assert.equal(final.bid_count, rows.length);
    assert.ok(results.some((r) => r.status === 'fulfilled'));
  });

  test('عبر HTTP: مزايدة صحيحة، ثم رفض مزايدة أقل من الحد الأدنى، ثم تكرار بنفس مفتاح عدم التكرار', async () => {
    const lot = await one(`SELECT l.* FROM auction_lots l JOIN users u ON u.email = 'bidder1@auction.ly'
                            WHERE l.status = 'OPEN' AND l.ends_at > now() + interval '20 minutes' AND l.leading_customer_id IS DISTINCT FROM u.customer_id
                            ORDER BY l.lot_no OFFSET 2 LIMIT 1`);
    await query('DELETE FROM proxy_bids WHERE lot_id = $1', [lot.id]);
    const info = await bidder.get(`/api/lots/${lot.id}`);
    const min = Number(info.data.next_minimum);
    const low = await bidder.post(`/api/lots/${lot.id}/bids`, { amount: String(min - 1) });
    assert.equal(low.status, 422);
    assert.equal(low.data.error.code, 'BELOW_MINIMUM');
    const ok = await bidder.post(`/api/lots/${lot.id}/bids`, { amount: String(min), idempotencyKey: 'net-retry-1' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.leading, true);
    const dup = await bidder.post(`/api/lots/${lot.id}/bids`, { amount: String(min), idempotencyKey: 'net-retry-1' });
    assert.equal(dup.data.duplicate, true);
    const again = await bidder.post(`/api/lots/${lot.id}/bids`, { amount: String(min + 5000) });
    assert.equal(again.data.error.code, 'ALREADY_LEADING');
  });

  test('المزايدة الآلية: حد سري يرد تلقائيًا على مزايدة منافس', async () => {
    const b2 = client(base);
    await b2.login('bidder2@auction.ly');
    const lot = await one(`SELECT l.* FROM auction_lots l WHERE l.status = 'OPEN' AND l.ends_at > now() + interval '20 minutes' ORDER BY l.lot_no OFFSET 3 LIMIT 1`);
    await query('DELETE FROM proxy_bids WHERE lot_id = $1', [lot.id]);
    const min = Number((await bidder.get(`/api/lots/${lot.id}`)).data.next_minimum);
    const p = await bidder.put(`/api/lots/${lot.id}/proxy`, { maxAmount: String(min + 20000) });
    assert.equal(p.status, 200);
    assert.equal(p.data.leading, true);
    const next = Number((await b2.get(`/api/lots/${lot.id}`)).data.next_minimum);
    const r = await b2.post(`/api/lots/${lot.id}/bids`, { amount: String(next) });
    assert.equal(r.status, 201);
    assert.equal(r.data.outbidByProxy, true);
    const view = await bidder.get(`/api/lots/${lot.id}`);
    assert.equal(view.data.is_leading, true);
    assert.equal(view.data.bids[0].kind, 'PROXY');
  });

  test('منع القنص: مزايدة في آخر دقيقتين تمدد نهاية اللوت', async () => {
    const lot = await one(`SELECT * FROM auction_lots WHERE status = 'OPEN' ORDER BY lot_no OFFSET 4 LIMIT 1`);
    await query(`UPDATE auction_lots SET ends_at = now() + interval '30 seconds' WHERE id = $1`, [lot.id]);
    await query('DELETE FROM proxy_bids WHERE lot_id = $1', [lot.id]);
    const custs = (await registered(lot.id)).filter((c) => c !== lot.leading_customer_id);
    const fresh = await one('SELECT * FROM auction_lots WHERE id = $1', [lot.id]);
    const { nextMinimumBid } = await import('../../src/domain/bidding.js');
    const r = await placeBid(lot.id, { amount: nextMinimumBid(fresh), customerId: custs[0] }, await actor());
    const secondsLeft = (new Date(r.endsAt) - Date.now()) / 1000;
    assert.ok(secondsLeft > 100 && secondsLeft <= 121, `المتبقي ${secondsLeft}`);
  });

  test('بث لحظي (SSE): المتصفح يستلم المزايدة فور تسجيلها', async () => {
    const lot = await one(`SELECT * FROM auction_lots WHERE status = 'OPEN' AND ends_at > now() + interval '20 minutes' ORDER BY lot_no OFFSET 5 LIMIT 1`);
    await query('DELETE FROM proxy_bids WHERE lot_id = $1', [lot.id]);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/lots/${lot.id}/stream`, { headers: { cookie: admin.cookie }, signal: ac.signal });
    const reader = res.body.getReader();
    const got = (async () => {
      let buf = '';
      for (;;) {
        const { value } = await reader.read();
        buf += new TextDecoder().decode(value);
        if (buf.includes('event: bid')) return buf;
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    const custs = (await registered(lot.id)).filter((c) => c !== lot.leading_customer_id);
    const { nextMinimumBid } = await import('../../src/domain/bidding.js');
    const t0 = Date.now();
    await placeBid(lot.id, { amount: nextMinimumBid(lot), customerId: custs[0] }, await actor());
    const text = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('لم يصل الحدث')), 3000))]);
    assert.match(text, /"lotId":"[0-9a-f-]+"/);
    assert.ok(Date.now() - t0 < 1000);
    ac.abort();
  });

  test('إغلاق آلي: لوت تجاوز الحد الأدنى → بيع وفاتورة، ولوت لم يبلغه → يعود للمخزون', async () => {
    const lots = (await query(`SELECT * FROM auction_lots WHERE status = 'OPEN' AND bid_count > 0 ORDER BY lot_no DESC LIMIT 2`)).rows;
    const [soldLot, unsoldLot] = lots;
    await query(`UPDATE auction_lots SET reserve_price = NULL, ends_at = now() - interval '1 second' WHERE id = $1`, [soldLot.id]);
    await query(`UPDATE auction_lots SET reserve_price = current_price + 100000, ends_at = now() - interval '1 second' WHERE id = $1`, [unsoldLot.id]);
    const r = await auctionTick();
    assert.ok(r.closed >= 2);
    const sale = await one('SELECT * FROM sales WHERE lot_id = $1', [soldLot.id]);
    assert.match(sale.invoice_no, /^INV-\d{4}-\d{5}$/);
    assert.equal(sale.customer_id, soldLot.leading_customer_id);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [soldLot.vehicle_id])).status, 'SOLD');
    assert.equal((await one('SELECT status FROM auction_lots WHERE id = $1', [unsoldLot.id])).status, 'CLOSED_UNSOLD');
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [unsoldLot.vehicle_id])).status, 'IN_STOCK');
  });
});

// ===================================================================== التكاليف والتقارير
describe('التكاليف والتقارير', () => {
  test('تكلفة بالدولار تأخذ سعر الصرف الساري في تاريخها', async () => {
    const v = await one(`SELECT id FROM vehicles WHERE status = 'IN_STOCK' LIMIT 1`);
    const date = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    const r = await accountant.post(`/api/vehicles/${v.id}/costs`, { categoryCode: 'REPAIRS', amount: '100', currency: 'USD', incurredAt: date });
    assert.equal(r.status, 201);
    const rate = await one(`SELECT rate_to_lyd FROM exchange_rates WHERE currency = 'USD' AND effective_date <= $1 ORDER BY effective_date DESC LIMIT 1`, [date]);
    assert.equal(r.data.fx_rate_to_lyd, rate.rate_to_lyd);
  });
  test('الإلغاء يتطلب سببًا ولا يحذف السجل', async () => {
    const c = await one(`SELECT id FROM vehicle_costs WHERE shared_cost_id IS NULL AND voided_at IS NULL LIMIT 1`);
    assert.equal((await accountant.post(`/api/costs/${c.id}/void`, {})).status, 422);
    assert.equal((await accountant.post(`/api/costs/${c.id}/void`, { reason: 'فاتورة مكررة' })).status, 200);
    assert.ok((await one('SELECT voided_at FROM vehicle_costs WHERE id = $1', [c.id])).voided_at);
  });
  test('التكلفة المشتركة توزع على سيارات الحاوية ومجموعها = الإجمالي بالضبط', async () => {
    const sh = await one(`SELECT sh.id FROM shipments sh WHERE (SELECT count(*) FROM shipment_vehicles WHERE shipment_id = sh.id) >= 3 LIMIT 1`);
    const r = await accountant.post(`/api/shipments/${sh.id}/shared-costs`, { categoryCode: 'PORT_HANDLING', totalAmount: '1000.001', currency: 'LYD', method: 'EQUAL', incurredAt: '2026-10-01' });
    assert.equal(r.status, 201);
    const s = await one('SELECT sum(amount) AS total FROM vehicle_costs WHERE shared_cost_id = $1', [r.data.sharedCost.id]);
    assert.equal(s.total, '1000.001');
  });
  test('المزايد لا يضيف تكلفة', async () => {
    const v = await one(`SELECT id FROM vehicles WHERE status = 'IN_AUCTION' LIMIT 1`);
    assert.equal((await bidder.post(`/api/vehicles/${v.id}/costs`, { categoryCode: 'OTHER', amount: '1', currency: 'LYD', incurredAt: '2026-10-01' })).status, 403);
  });
  test('تقرير Excel: ملف xlsx صالح بثلاث أوراق، وإجمالياته تطابق قاعدة البيانات', async () => {
    const r = await accountant.get('/api/reports/costs.xlsx');
    assert.equal(r.status, 200);
    assert.equal(r.data.subarray(0, 2).toString(), 'PK');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.data);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['الملخص', 'تكلفة كل سيارة', 'البنود التفصيلية']);
    const sheet = wb.getWorksheet('تكلفة كل سيارة');
    let colIdx = 0;
    sheet.getRow(1).eachCell((c, i) => { if (c.value === 'إجمالي التكلفة') colIdx = i; });
    let sumX = 0;
    sheet.getColumn(colIdx).eachCell((c, row) => { if (row > 1 && typeof c.value === 'number') sumX += c.value; });
    const db = await one('SELECT sum(total_cost_lyd) AS t FROM v_vehicle_landed_cost');
    assert.ok(Math.abs(sumX - Number(db.t)) < 0.01, `${sumX} ≠ ${db.t}`);
    const lines = wb.getWorksheet('البنود التفصيلية').rowCount - 1;
    assert.equal(lines, (await one('SELECT count(*)::int n FROM vehicle_costs WHERE voided_at IS NULL')).n);
  });
  test('CSV: يبدأ بـ BOM ويحيّد محاولة حقن الصيغ', async () => {
    await query(`INSERT INTO vehicles (stock_no, vin, year, make, model) VALUES ('T-CSV', '1M8GDM9A3KP042700', 2020, 'Test', '=HYPERLINK("http://evil")')`);
    const res = await fetch(`${base}/api/reports/costs.csv`, { headers: { cookie: accountant.cookie } });
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    assert.ok(text.slice(1).startsWith('stock_no,vin'));
    if (text.includes('HYPERLINK')) assert.ok(text.includes(`"'=HYPERLINK`), 'الصيغة لم تُحيَّد');
  });
  test('الجمارك: الإفراج ينقل السيارة آليًا، وسداد الرسم يُسجَّل تكلفة', async () => {
    const cd = await one(`SELECT cd.id, cd.vehicle_id FROM customs_declarations cd JOIN vehicles v ON v.id = cd.vehicle_id WHERE v.status = 'IN_CUSTOMS' LIMIT 1`);
    const ops = client(base);
    await ops.login('ops@auction.ly');
    await query(`DELETE FROM vehicle_costs WHERE vehicle_id = $1 AND category_code = 'CUSTOMS_DUTY'`, [cd.vehicle_id]);
    assert.equal((await ops.patch(`/api/customs/${cd.id}`, { status: 'DUTY_PAID', dutyAmountLyd: '12345.5', declarationNo: 'CD/TEST/1' })).status, 200);
    const cost = await one(`SELECT amount_lyd FROM vehicle_costs WHERE vehicle_id = $1 AND category_code = 'CUSTOMS_DUTY' AND voided_at IS NULL`, [cd.vehicle_id]);
    assert.equal(cost.amount_lyd, '12345.500');
    assert.equal((await ops.patch(`/api/customs/${cd.id}`, { status: 'RELEASED' })).status, 200);
    assert.equal((await one('SELECT status FROM vehicles WHERE id = $1', [cd.vehicle_id])).status, 'CUSTOMS_CLEARED');
  });
});

// ===================================================================== المزامنة
describe('محرك المزامنة مع Copart/IAAI', () => {
  const VIN = '1M8GDM9AXKP042788';
  const item = (over = {}) => ({ lotNumber: '70000001', vin: VIN, year: 2019, make: 'TOYOTA', modelGroup: 'CAMRY', saleDate: '2026-10-01T00:00:00Z', purchase: { price: 8000, buyerFee: 900 }, ...over });
  const adapterOf = (pages, normalize) => ({ normalize, async *fetchPurchases() { for (const p of pages) yield p; } });
  let normalizeCopart;
  before(async () => { ({ normalizeCopart } = await import('../../src/sync/adapters/copart.js')); });

  test('استيراد جديد ينشئ السيارة وتكاليف الشراء بالدولار', async () => {
    const r = await syncPurchases('COPART', { adapter: adapterOf([{ items: [item()], cursor: '2026-10-07T10:00:00Z' }], normalizeCopart), triggeredBy: 'TEST' });
    assert.equal(r.status, 'SUCCEEDED');
    assert.equal(r.created, 1);
    const v = await one('SELECT id, status FROM vehicles WHERE vin = $1', [VIN]);
    assert.equal(v.status, 'PURCHASED');
    const costs = (await query(`SELECT category_code, amount, currency FROM vehicle_costs WHERE vehicle_id = $1 ORDER BY category_code`, [v.id])).rows;
    assert.deepEqual(costs.map((c) => c.category_code), ['AUCTION_BUYER_FEE', 'HAMMER_PRICE']);
  });
  test('إعادة نفس البيانات لا تكتب شيئًا (Idempotent)', async () => {
    const r = await syncPurchases('COPART', { adapter: adapterOf([{ items: [item()], cursor: null }], normalizeCopart), triggeredBy: 'TEST' });
    assert.equal(r.unchanged, 1);
    assert.equal((await one(`SELECT count(*)::int n FROM vehicle_costs c JOIN vehicles v ON v.id = c.vehicle_id WHERE v.vin = $1`, [VIN])).n, 2);
  });
  test('تقدم لوجستي متعدد المراحل يُسجَّل خطوة خطوة، والحقول المقفلة يدويًا لا تُستبدل', async () => {
    const v = await one('SELECT id FROM vehicles WHERE vin = $1', [VIN]);
    await query(`UPDATE vehicles SET model = 'Camry Hybrid', locked_fields = '{model}' WHERE id = $1`, [v.id]);
    await syncPurchases('COPART', { adapter: adapterOf([{ items: [item({ odometer: 51000, purchase: { price: 8000, buyerFee: 900, paidAt: 'x', pickedUpAt: 'y', deliveredAt: 'z' } })] }], normalizeCopart), triggeredBy: 'TEST' });
    const after = await one('SELECT status, model, odometer FROM vehicles WHERE id = $1', [v.id]);
    assert.equal(after.status, 'AT_US_WAREHOUSE');
    assert.equal(after.model, 'Camry Hybrid');
    assert.equal(after.odometer, 51000);
    const steps = (await query(`SELECT to_status FROM vehicle_status_history WHERE vehicle_id = $1 AND source = 'SYNC' ORDER BY id`, [v.id])).rows.map((r) => r.to_status);
    assert.deepEqual(steps, ['PURCHASED', 'AWAITING_PICKUP', 'US_INLAND_TRANSIT', 'AT_US_WAREHOUSE']);
  });
  test('عنصر تالف يذهب لطابور الأخطاء دون إيقاف بقية الجولة، وتكراره لا يضاعف الصفوف', async () => {
    const bad = { lotNumber: '70000002', vin: 'NOTAVIN' };
    const { vinError, makeVin } = await import('../../src/domain/vin.js');
    const good = item({ lotNumber: '70000003', vin: makeVin('4T1G11AK', 'K', 'U', 123459) });
    assert.equal(vinError(good.vin), null);
    for (let i = 0; i < 2; i++) {
      const r = await syncPurchases('COPART', { adapter: adapterOf([{ items: [bad, good] }], normalizeCopart), triggeredBy: 'TEST' });
      assert.equal(r.status, 'PARTIAL');
      assert.equal(r.failed, 1);
    }
    const dl = (await query(`SELECT attempts FROM sync_dead_letters WHERE external_ref = '70000002' AND resolved_at IS NULL`)).rows;
    assert.equal(dl.length, 1);
    assert.equal(dl[0].attempts, 2);
  });
  test('قاطع الدائرة: 3 جولات فاشلة متتالية توقف المصدر مؤقتًا، والجولة المجدولة التالية تُرفض', async () => {
    const failing = { normalize: normalizeCopart, async *fetchPurchases() { throw new Error('ECONNREFUSED'); } };
    for (let i = 0; i < 3; i++) assert.equal((await syncPurchases('IAAI', { adapter: failing, triggeredBy: 'SCHEDULER' })).status, 'FAILED');
    const src = await one(`SELECT consecutive_failures, circuit_open_until FROM external_sources WHERE code = 'IAAI'`);
    assert.equal(src.consecutive_failures, 3);
    assert.ok(new Date(src.circuit_open_until) > new Date());
    await assert.rejects(syncPurchases('IAAI', { adapter: failing, triggeredBy: 'SCHEDULER' }), /قاطع الدائرة/);
    // المستخدم يستطيع التشغيل اليدوي رغم القاطع، والنجاح يعيد ضبطه
    const ok = { normalize: normalizeCopart, async *fetchPurchases() { yield { items: [], cursor: '2026-10-07T00:00:00Z' }; } };
    assert.equal((await syncPurchases('IAAI', { adapter: ok, triggeredBy: 'USER:test' })).status, 'SUCCEEDED');
    assert.equal((await one(`SELECT consecutive_failures FROM external_sources WHERE code = 'IAAI'`)).consecutive_failures, 0);
  });
  test('لا جولتان متزامنتان لنفس المصدر (قفل على مستوى قاعدة البيانات)', async () => {
    let release;
    const slow = { normalize: normalizeCopart, async *fetchPurchases() { await new Promise((r) => { release = r; }); yield { items: [] }; } };
    const first = syncPurchases('COPART', { adapter: slow, triggeredBy: 'TEST' });
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(syncPurchases('COPART', { adapter: slow, triggeredBy: 'TEST' }), /جارية بالفعل/);
    release();
    assert.equal((await first).status, 'SUCCEEDED');
  });
  test('استيراد CSV عبر الواجهة', async () => {
    const csv = 'lot_number,vin,year,make,model,purchase_price_usd,sale_date\n70000010,5NPEL4JA1LH123456,2020,hyundai,Sonata,"$6,250",2026-09-30\n';
    const { vinError } = await import('../../src/domain/vin.js');
    const ops = client(base);
    await ops.login('ops@auction.ly');
    const r = await ops.post('/api/integrations/csv', csv, { 'content-type': 'text/csv' });
    assert.equal(r.status, 200);
    assert.equal(r.data.seen, 1);
    assert.equal(r.data.created + r.data.failed, 1);
    if (vinError('5NPEL4JA1LH123456')) assert.equal(r.data.failed, 1); else assert.equal(r.data.created, 1);
  });
});
