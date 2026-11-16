import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

resetDb();
const { query, pool } = await import('../../src/db.js');
const { restoreBackup } = await import('../../src/services/backup.js');
const { server, base } = await startApp();
after(() => stopApp(server));
const asRole = async (email) => { const c = client(base); assert.equal((await c.login(email)).status, 200); return c; };
const download = async (c) => {
  const res = await fetch(`${base}/api/admin/backup`, { headers: { cookie: c.cookie } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
};
// بصمة محتوى كل جدول: عدد الصفوف + تجزئة كل الصفوف مرتبة (تشمل الأعمدة المولَّدة والصور)
const fingerprint = async (tables) => {
  const out = {};
  for (const t of tables) {
    const { rows: [r] } = await query(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) AS h FROM auction."${t}" x`);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
};

describe('حماية الطلبات', () => {
  test('أصل غريب أو غير قابل للتحليل يُرفض بـ403 لا بخطأ داخلي', async () => {
    const c = client(base);
    for (const origin of ['https://evil.example', 'null', 'not a url']) {
      const r = await c.post('/api/auth/login', { email: 'admin@auction.ly', password: 'x' }, { origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.data.error.code, 'BAD_ORIGIN');
    }
  });
});

describe('الجلسات', () => {
  test('لوحة الأمان للمدير فقط', async () => {
    assert.equal((await client(base).get('/api/admin/security')).status, 401);
    assert.equal((await (await asRole('accountant@auction.ly')).get('/api/admin/security')).status, 403);
    assert.equal((await (await asRole('accountant@auction.ly')).post('/api/admin/sessions/revoke-others')).status, 403);
  });

  test('المدير يرى الأجهزة الداخلة ويُخرج جلسة بعينها فتتوقف فورًا', async () => {
    const admin = await asRole('admin@auction.ly');
    const sales = await asRole('sales@auction.ly');
    const s = (await admin.get('/api/admin/security')).data;
    assert.equal(s.sessions.filter((x) => x.current).length, 1);
    assert.ok(!('token_hash' in s.sessions[0]), 'لا يُكشف رمز الجلسة');
    const target = s.sessions.find((x) => x.role === 'SALES');
    assert.ok(target);
    assert.equal((await sales.get('/api/auth/me')).status, 200);
    assert.equal((await admin.post(`/api/admin/sessions/${target.id}/revoke`)).status, 200);
    assert.equal((await sales.get('/api/auth/me')).status, 401);
    assert.equal((await admin.post(`/api/admin/sessions/${target.id}/revoke`)).status, 404);
    const cur = s.sessions.find((x) => x.current);
    assert.equal((await admin.post(`/api/admin/sessions/${cur.id}/revoke`)).status, 422);
  });

  test('إخراج كل الأجهزة الأخرى يبقي الجلسة الحالية وحدها', async () => {
    const admin = await asRole('admin@auction.ly');
    const other = await asRole('admin@auction.ly');
    const viewer = await asRole('viewer@auction.ly');
    const r = await admin.post('/api/admin/sessions/revoke-others');
    assert.equal(r.status, 200);
    assert.ok(r.data.revoked >= 2);
    assert.equal((await other.get('/api/auth/me')).status, 401);
    assert.equal((await viewer.get('/api/auth/me')).status, 401);
    assert.equal((await admin.get('/api/auth/me')).status, 200);
    assert.equal((await admin.get('/api/admin/security')).data.sessions.length, 1);
  });
});

describe('النسخة الاحتياطية', () => {
  test('للمدير فقط', async () => {
    assert.equal((await download(client(base))).status, 401);
    assert.equal((await download(await asRole('accountant@auction.ly'))).status, 403);
  });

  test('تُنزَّل كاملة ثم تُسترجع فترجع البيانات مطابقة تمامًا', async () => {
    const admin = await asRole('admin@auction.ly');
    // بيانات فيها عمود مولَّد (amount_lyd) ومرفق ثنائي وتسلسلات
    const e = await admin.post('/api/expenses', { category: 'OTHER', description: 'مصروف للنسخة', amount: '120.500', currency: 'LYD' });
    assert.equal(e.status, 201, JSON.stringify(e.data));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const a = await admin.post(`/api/expenses/${e.data.id}/attachments`, { data: `data:image/png;base64,${png.toString('base64')}`, filename: 'فاتورة.png' });
    assert.equal(a.status, 201, JSON.stringify(a.data));

    const d = await download(admin);
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-disposition'), /attachment; filename="ggm-backup-\d{4}-\d{2}-\d{2}\.ndjson\.gz"/);
    const lines = gunzipSync(d.buf).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    const head = lines[0];
    assert.equal(head.format, 'ggm-backup');
    assert.ok(head.tables.includes('company_expenses') && head.tables.includes('audit_logs'));
    assert.ok(!head.tables.includes('user_sessions'), 'الجلسات لا تُنسخ');
    assert.equal(lines.at(-1).end, true);
    assert.equal(lines.filter((l) => l.t).length, lines.at(-1).rows);

    const before = await fingerprint(head.tables);
    const seqBefore = (await query(`SELECT last_value FROM auction.expense_seq`)).rows[0].last_value;

    // تخريب بعد النسخة: حذف وتعديل وإضافة
    await query('DELETE FROM expense_attachments');
    await query(`UPDATE customers SET full_name = 'مخرَّب'`);
    assert.equal((await admin.post('/api/expenses', { category: 'OTHER', description: 'بعد النسخة', amount: '5', currency: 'LYD' })).status, 201);
    assert.notDeepEqual(await fingerprint(head.tables), before);

    const c = await pool.connect();
    try {
      const s = await restoreBackup(c, Readable.from([d.buf]));
      assert.equal(s.complete, true);
      assert.equal(s.rows, lines.at(-1).rows);
    } finally { c.release(); }

    assert.deepEqual(await fingerprint(head.tables), before);
    assert.equal((await query(`SELECT last_value FROM auction.expense_seq`)).rows[0].last_value, seqBefore);
    assert.equal((await query('SELECT count(*)::int AS n FROM user_sessions')).rows[0].n, 0);
    // القيود والمشغّلات رجعت تعمل
    await assert.rejects(query(`INSERT INTO expense_attachments (expense_id, filename, mime, bytes, content) VALUES (gen_random_uuid(), 'x', 'image/png', 1, '\\x00')`), /foreign key/);
    await assert.rejects(query('DELETE FROM audit_logs'), /append-only/);
    // والمنظومة تكمل العمل بعد الاسترجاع
    const again = await asRole('admin@auction.ly');
    assert.equal((await again.post('/api/expenses', { category: 'OTHER', description: 'بعد الاسترجاع', amount: '7', currency: 'LYD' })).status, 201);
    const sec = (await again.get('/api/admin/security')).data;
    assert.ok(sec.last_backup_at, 'تاريخ آخر نسخة يظهر');
  });

  test('نسخة مبتورة تُرفض ولا تغيّر شيئًا', async () => {
    const admin = await asRole('admin@auction.ly');
    const d = await download(admin);
    const { gzipSync } = await import('node:zlib');
    const cut = gzipSync(gunzipSync(d.buf).toString('utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
    const tables = JSON.parse(gunzipSync(d.buf).toString('utf8').split('\n')[0]).tables;
    const before = await fingerprint(tables);
    const c = await pool.connect();
    try {
      await assert.rejects(restoreBackup(c, Readable.from([cut])), /مبتورة/);
      await assert.rejects(restoreBackup(c, Readable.from([gzipSync('{"format":"other"}\n')])), /ليس نسخة/);
    } finally { c.release(); }
    assert.deepEqual(await fingerprint(tables), before);
  });
});
