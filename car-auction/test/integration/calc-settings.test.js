import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { query } = await import('../../src/db.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };

const ship = (quad) => ({ quad, triple: quad + 300, loading: quad + 600 });
const body = (extra = {}) => ({ exchange: 9.5, transferPct: 2, wire: 5, towingMargin: 75, ports: { GA: ship(1000), NJ: ship(1010), TX: ship(1100), CA: ship(1500) }, ...extra });

describe('إعدادات الحاسبة العامة', () => {
  test('قبل الحفظ: أي زائر يقرأ ولا يجد إعدادات', async () => {
    const r = await client(base).get('/api/public/calc-settings');
    assert.equal(r.status, 200);
    assert.equal(r.data.settings, null);
  });

  test('التعديل للمدير فقط', async () => {
    assert.equal((await client(base).put('/api/calc-settings', body())).status, 401);
    assert.equal((await (await asRole('sales@auction.ly')).put('/api/calc-settings', body())).status, 403);
    assert.equal((await (await asRole('viewer@auction.ly')).put('/api/calc-settings', body())).status, 403);
  });

  test('المدير يحفظ، والزائر يقرأ القيم الجديدة، والتعديل يُسجَّل', async () => {
    const admin = await asRole('admin@auction.ly');
    const r = await admin.put('/api/calc-settings', body());
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const pub = (await client(base).get('/api/public/calc-settings')).data.settings;
    assert.deepEqual([pub.exchange, pub.towingMargin, pub.ports.CA.quad], [9.5, 75, 1500]);
    const again = await admin.put('/api/calc-settings', body({ exchange: 11 }));
    assert.equal(again.status, 200);
    assert.equal((await client(base).get('/api/public/calc-settings')).data.settings.exchange, 11);
    const { rows } = await query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'CALC_SETTINGS_SET'`);
    assert.equal(rows[0].n, 2);
    assert.equal((await query('SELECT count(*)::int AS n FROM calc_settings')).rows[0].n, 1);
  });

  test('القيم غير المعقولة تُرفض ولا تغيّر المحفوظ', async () => {
    const admin = await asRole('admin@auction.ly');
    for (const bad of [{ exchange: 0 }, { exchange: 'abc' }, { exchange: '' }, { transferPct: 101 }, { towingMargin: -1 }, { ports: { GA: ship(1000) } }]) {
      const r = await admin.put('/api/calc-settings', body(bad));
      assert.equal(r.status, 422, JSON.stringify(bad));
    }
    assert.equal((await client(base).get('/api/public/calc-settings')).data.settings.exchange, 11);
  });
});
