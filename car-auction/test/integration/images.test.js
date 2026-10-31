import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };

// صورة PNG حقيقية 1×1 وأخرى JPEG دنيا صالحة التوقيع
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64');

let ops, viewer, bidder, vid;
before(async () => {
  ops = await asRole('ops@auction.ly'); viewer = await asRole('viewer@auction.ly'); bidder = await asRole('bidder1@auction.ly');
  vid = (await query(`SELECT id FROM vehicles ORDER BY stock_no LIMIT 1`)).rows[0].id;
  await query('DELETE FROM vehicle_images WHERE vehicle_id = $1', [vid]);
});

describe('صور السيارات المرفوعة', () => {
  let first, second;
  test('رفع صورة: أول صورة تصبح الرئيسية وتُعرض بنوعها الحقيقي', async () => {
    const r = await ops.post(`/api/vehicles/${vid}/images`, { data: `data:image/png;base64,${PNG}`, width: 1, height: 1 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.is_primary, true);
    first = r.data.id;
    const img = await ops.get(`/api/media/vehicles/${vid}/${first}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    // المسار القديم .svg يخدم نفس المحتوى
    assert.equal((await ops.get(`/api/media/vehicles/${vid}/${first}.svg`)).headers.get('content-type'), 'image/png');
    const r2 = await ops.post(`/api/vehicles/${vid}/images`, { data: JPEG });
    assert.equal(r2.status, 201, JSON.stringify(r2.data));
    assert.equal(r2.data.is_primary, false);
    second = r2.data.id;
  });

  test('الصورة نفسها مرتين مرفوضة، والملفات المزيفة مرفوضة من البايتات لا من الاسم', async () => {
    assert.equal((await ops.post(`/api/vehicles/${vid}/images`, { data: PNG })).data.error.code, 'DUPLICATE_IMAGE');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    assert.equal((await ops.post(`/api/vehicles/${vid}/images`, { data: `data:image/png;base64,${svg}` })).data.error.code, 'UNSUPPORTED_IMAGE');
    assert.equal((await ops.post(`/api/vehicles/${vid}/images`, { data: 'not base64!!' })).data.error.code, 'BAD_IMAGE');
  });

  test('الصلاحيات: الاطلاع والمزايد لا يرفعون ولا يحذفون، والزائر بلا جلسة لا يرى', async () => {
    assert.equal((await viewer.post(`/api/vehicles/${vid}/images`, { data: JPEG })).status, 403);
    assert.equal((await bidder.post(`/api/vehicles/${vid}/images`, { data: JPEG })).status, 403);
    assert.equal((await bidder.delete(`/api/vehicles/${vid}/images/${first}`)).status, 403);
    assert.equal((await client(base).get(`/api/media/vehicles/${vid}/${first}`)).status, 401);
  });

  test('تعيين الرئيسية ثم حذفها ينقل الرئيسية للمتبقية، ويُسجَّل في التدقيق', async () => {
    assert.equal((await ops.post(`/api/vehicles/${vid}/images/${second}/primary`, {})).status, 200);
    const d = await ops.get(`/api/vehicles/${vid}`);
    assert.equal(d.data.images[0].id, second);
    assert.equal(d.data.images.filter((i) => i.is_primary).length, 1);
    assert.equal((await ops.delete(`/api/vehicles/${vid}/images/${second}`)).status, 200);
    const d2 = await ops.get(`/api/vehicles/${vid}`);
    assert.deepEqual(d2.data.images.map((i) => [i.id, i.is_primary]), [[first, true]]);
    const n = (await query(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action LIKE 'VEHICLE_IMAGE_%'`, [vid])).rows[0].n;
    assert.equal(n, 4);
  });

  test('الحد العام لحجم الطلب يبقى 200kb لبقية المسارات', async () => {
    const big = 'x'.repeat(300_000);
    assert.equal((await ops.patch(`/api/vehicles/${vid}`, { notes: big })).status, 413);
  });
});

describe('الهجرات في init-db', () => {
  test('تُطبَّق على قاعدة قديمة بلا الأعمدة، ومرة واحدة فقط', async () => {
    await query('ALTER TABLE vehicle_images DROP COLUMN IF EXISTS content, DROP COLUMN IF EXISTS mime');
    await query('DROP TABLE IF EXISTS schema_migrations');
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const run = () => execFileSync('node', ['scripts/init-db.js'], { cwd: root, env: process.env, encoding: 'utf8' });
    assert.match(run(), /0001_vehicle_image_content/);
    assert.doesNotMatch(run(), /طُبّقت الهجرة/);
    const cols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'auction' AND table_name = 'vehicle_images' AND column_name IN ('content','mime')`)).rows;
    assert.equal(cols.length, 2);
  });
});
