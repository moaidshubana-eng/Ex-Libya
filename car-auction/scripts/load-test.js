// اختبار الأداء والتحمّل عبر HTTP الحقيقي.
// الاستخدام: BASE_URL=http://localhost:4100 DATABASE_URL=<قاعدة الأداء> node scripts/load-test.js
// يُنشئ 60 مزايدًا تجريبيًا في قاعدة الأداء فقط، ثم يشغّل سيناريوهات قراءة وكتابة متزامنة
// ويقيس زمن الاستجابة (p50/p95/p99) والإنتاجية ونسبة الأخطاء، ثم بث SSE إلى 300 متصفح.
import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { config } from '../src/config.js';

const BASE = process.env.BASE_URL || 'http://localhost:4100';
const DURATION = Number(process.env.DURATION_SEC || 20) * 1000;
if (!/perf/.test(config.databaseUrl)) throw new Error('يُشغَّل على قاعدة أداء منفصلة فقط (اسمها يحتوي perf)');

const db = new pg.Client({ connectionString: config.databaseUrl, options: '-c search_path=auction,public' });
await db.connect();

// ---------------------------------------------------------------- تجهيز المزايدين
const { rows: [ev] } = await db.query(`SELECT id FROM auction_events WHERE status = 'LIVE' LIMIT 1`);
const { rows: [pw] } = await db.query(`SELECT password_hash FROM users WHERE email = 'bidder1@auction.ly'`);
await db.query(`DELETE FROM users WHERE email LIKE 'load%@auction.ly'`);
const bidders = [];
for (let i = 0; i < 60; i++) {
  const { rows: [c] } = await db.query(`INSERT INTO customers (code, full_name, kyc_status) VALUES ($1, $2, 'VERIFIED')
    ON CONFLICT (code) DO UPDATE SET full_name = EXCLUDED.full_name RETURNING id`, [`L-${i}`, `مزايد حمل ${i}`]);
  await db.query(`INSERT INTO bidder_registrations (auction_event_id, customer_id, paddle_no, deposit_status) VALUES ($1,$2,$3,'HELD') ON CONFLICT DO NOTHING`, [ev.id, c.id, 500 + i]);
  await db.query(`INSERT INTO users (email, full_name, password_hash, role, customer_id) VALUES ($1,$2,$3,'BIDDER',$4)`, [`load${i}@auction.ly`, `load ${i}`, pw.password_hash, c.id]);
  bidders.push(`load${i}@auction.ly`);
}
await db.query(`UPDATE auction_lots SET ends_at = now() + interval '2 hours' WHERE auction_event_id = $1 AND status = 'OPEN'`, [ev.id]);
const { rows: lots } = await db.query(`SELECT id FROM auction_lots WHERE auction_event_id = $1 AND status = 'OPEN' ORDER BY lot_no`, [ev.id]);
const { rows: sampleIds } = await db.query(`SELECT id FROM vehicles ORDER BY random() LIMIT 500`);

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Demo@2026pass' }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}

// ---------------------------------------------------------------- محرك القياس
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
async function run(name, concurrency, makeReq, durationMs = DURATION, thinkMs = 0) {
  const lat = [];
  let errors = 0, done = 0;
  const statuses = {};
  const end = Date.now() + durationMs;
  const worker = async (w) => {
    while (Date.now() < end) {
      const { url, init, ok = (s) => s < 400 } = await makeReq(w);
      const t = performance.now();
      try {
        const r = await fetch(BASE + url, init);
        await r.arrayBuffer();
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (!ok(r.status)) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t);
      done++;
      if (thinkMs) await new Promise((r) => setTimeout(r, thinkMs * (0.5 + Math.random())));
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  const secs = (Date.now() - t0) / 1000;
  const res = { name, concurrency, requests: done, rps: +(done / secs).toFixed(1), p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1), max: +Math.max(...lat).toFixed(1), errors, errorRate: +((errors / Math.max(1, done)) * 100).toFixed(2), statuses };
  console.log(JSON.stringify(res));
  return res;
}

const staffCookie = await login('admin@auction.ly');
const accCookie = await login('accountant@auction.ly');
const bidderCookies = await Promise.all(bidders.map(login));
const H = (cookie) => ({ headers: { cookie } });
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
const results = [];

results.push(await run('GET /api/vehicles (قائمة مقسمة صفحات، 20 ألف سيارة)', 50, () => ({ url: `/api/vehicles?page=${1 + Math.floor(Math.random() * 400)}&pageSize=24`, init: H(staffCookie) })));
results.push(await run('GET /api/vehicles (بحث + مرشحات)', 50, () => ({ url: `/api/vehicles?q=${rnd(['Camry', 'Sonata', 'K5', 'BLK-0001', 'Accord'])}&status=${rnd(['IN_STOCK', 'IN_TRANSIT_SEA', 'IN_CUSTOMS'])}&sort=${rnd(['newest', 'year_desc', 'eta'])}`, init: H(staffCookie) })));
results.push(await run('GET /api/vehicles/:id (ملف كامل مع التكاليف)', 50, () => ({ url: `/api/vehicles/${rnd(sampleIds).id}`, init: H(staffCookie) })));
const tc = performance.now();
await (await fetch(`${BASE}/api/dashboard`, H(staffCookie))).arrayBuffer();
const dashboardColdMs = +(performance.now() - tc).toFixed(1); // أول طلب: تجميع فعلي بلا ذاكرة مؤقتة
console.log('dashboard cold', dashboardColdMs);
results.push(await run('GET /api/dashboard (مع ذاكرة مؤقتة 10 ثوانٍ)', 20, () => ({ url: '/api/dashboard', init: H(staffCookie) })));
results.push(await run('GET /api/reports/costs?status=IN_STOCK (تقرير ~2,200 سيارة)', 10, () => ({ url: '/api/reports/costs?status=IN_STOCK', init: H(accCookie) })));
results.push(await run('GET /api/reports/costs (كل الأسطول: 20 ألف سيارة)', 5, () => ({ url: '/api/reports/costs', init: H(accCookie) })));
results.push(await run('GET /api/reports/costs.xlsx?status=SOLD (تصدير Excel ~4,400 سيارة)', 3, () => ({ url: '/api/reports/costs.xlsx?status=SOLD', init: H(accCookie) })));
// أثر التصدير الثقيل على المزايدين: قراءة اللوتات بالتوازي مع 3 تصديرات Excel متزامنة
const [lotsDuringExport, exportsDuring] = await Promise.all([
  run('GET /api/lots/:id أثناء 3 تصديرات Excel متزامنة', 60, (w) => ({ url: `/api/lots/${rnd(lots).id}`, init: H(bidderCookies[w]) })),
  run('(خلفية) تصدير Excel أثناء المزايدة', 3, () => ({ url: '/api/reports/costs.xlsx?status=SOLD', init: H(accCookie) })),
]);
results.push(lotsDuringExport, exportsDuring);
results.push(await run('GET /api/lots/:id (60 مزايدًا يتابعون اللوتات)', 60, (w) => ({ url: `/api/lots/${rnd(lots).id}`, init: H(bidderCookies[w]) })));

// كتابة متزامنة: 60 مزايدًا يتنافسون على 3 لوتات (أسوأ حالة تنافس على القفل)
const hot = lots.slice(0, 3);
const minByLot = {};
results.push(await run('POST /api/lots/:id/bids (60 مزايدًا على 3 لوتات)', 60, async (w) => {
  const lot = hot[w % 3];
  if (!minByLot[lot.id] || Math.random() < 0.2) {
    const r = await fetch(`${BASE}/api/lots/${lot.id}`, H(bidderCookies[w]));
    minByLot[lot.id] = Number((await r.json()).next_minimum);
  }
  const amount = minByLot[lot.id] + 1000 * Math.floor(Math.random() * 3);
  minByLot[lot.id] = amount + 1000;
  // 409/422 هنا نتائج تنافس صحيحة (سبقتك مزايدة أعلى/أنت الأعلى أصلًا) لا أخطاء نظام
  return { url: `/api/lots/${lot.id}/bids`, init: { method: 'POST', headers: { cookie: bidderCookies[w], 'content-type': 'application/json' }, body: JSON.stringify({ amount: String(amount) }) }, ok: (s) => s < 500 && s !== 429 };
}, Math.min(DURATION, 15000), 900)); // كل مزايد يزايد مرة كل ~0.9 ثانية (أسرع بكثير من الواقع)

// تحقق سلامة البيانات بعد الضغط: سجل كل لوت متصاعد بصرامة، والسعر الحالي = آخر مزايدة
const integrity = [];
for (const lot of hot) {
  const { rows } = await db.query('SELECT amount FROM bids WHERE lot_id = $1 ORDER BY id', [lot.id]);
  const mono = rows.every((r, i) => i === 0 || Number(r.amount) > Number(rows[i - 1].amount));
  const { rows: [l] } = await db.query('SELECT current_price, bid_count FROM auction_lots WHERE id = $1', [lot.id]);
  integrity.push({ lot: lot.id.slice(0, 8), bids: rows.length, strictlyIncreasing: mono, priceMatchesLastBid: Number(l.current_price) === Number(rows.at(-1).amount), countMatches: l.bid_count === rows.length });
}
console.log('integrity', integrity);

// بث SSE: 300 متصفح على نفس اللوت، نقيس زمن وصول المزايدة للجميع
const sseLot = lots[5];
const N = 300;
const conns = [];
const arrivals = [];
let tBid = 0;
for (let i = 0; i < N; i++) {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/lots/${sseLot.id}/stream`, { headers: { cookie: bidderCookies[i % bidderCookies.length] }, signal: ac.signal });
  const reader = res.body.getReader();
  conns.push(ac);
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        if (buf.includes('event: bid')) { arrivals.push(performance.now() - tBid); return; }
      }
    } catch { /* أُغلق */ }
  })();
}
await new Promise((r) => setTimeout(r, 11_000)); // انتظار انقضاء نافذة محدد المعدل بعد سيناريو المزايدة
const lr = await fetch(`${BASE}/api/lots/${sseLot.id}`, H(bidderCookies[59]));
const nm = (await lr.json()).next_minimum;
tBid = performance.now();
const br = await fetch(`${BASE}/api/lots/${sseLot.id}/bids`, { method: 'POST', headers: { cookie: bidderCookies[59], 'content-type': 'application/json' }, body: JSON.stringify({ amount: String(Number(nm)) }) });
await new Promise((r) => setTimeout(r, 3000));
conns.forEach((c) => c.abort());
const sse = { clients: N, bidStatus: br.status, delivered: arrivals.length, p50: +pct(arrivals, 50).toFixed(1), p95: +pct(arrivals, 95).toFixed(1), max: +Math.max(0, ...arrivals).toFixed(1) };
console.log('sse', sse);

const { rows: [size] } = await db.query(`SELECT (SELECT count(*) FROM vehicles) vehicles, (SELECT count(*) FROM vehicle_costs) costs, (SELECT count(*) FROM bids) bids, pg_size_pretty(pg_database_size(current_database())) db_size`);
await db.end();

const out = { at: new Date().toISOString(), base: BASE, dashboardColdMs, durationSecPerScenario: DURATION / 1000, dataset: size, node: process.version, results, integrity, sse };
mkdirSync(new URL('../docs/test-results/', import.meta.url), { recursive: true });
writeFileSync(new URL('../docs/test-results/load-test.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('written docs/test-results/load-test.json');
