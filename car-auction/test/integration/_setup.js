// يُستورد أولًا في كل اختبار تكامل: يوجّه الاتصال إلى قاعدة اختبار منفصلة
// ويعيد بناء المخطط وبذر البيانات، ثم يشغّل التطبيق على منفذ عشوائي.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://auction:auction@localhost:5432/car_auction_test';
process.env.MOCK_FEEDS = 'false';
process.env.SCHEDULER_ENABLED = 'false';
process.env.NODE_ENV = 'test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export function resetDb() {
  execFileSync('node', ['scripts/apply-schema.js'], { cwd: root, env: process.env, stdio: 'pipe' });
  execFileSync('node', ['scripts/seed.js'], { cwd: root, env: process.env, stdio: 'pipe' });
}

export async function startApp() {
  const { createApp } = await import('../../src/app.js');
  const { startRealtime } = await import('../../src/services/realtime.js');
  await startRealtime();
  const app = createApp();
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

export async function stopApp(server) {
  const { stopRealtime } = await import('../../src/services/realtime.js');
  const { pool } = await import('../../src/db.js');
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await stopRealtime();
  await pool.end();
}

/** عميل HTTP بسيط يحفظ كوكي الجلسة */
export function client(base) {
  let cookie = '';
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : ct.includes('sheet') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p, h) => req('GET', p, undefined, h),
    post: (p, b = {}, h) => req('POST', p, b, h),
    put: (p, b = {}, h) => req('PUT', p, b, h),
    patch: (p, b = {}, h) => req('PATCH', p, b, h),
    login: (email, password = 'Demo@2026pass') => req('POST', '/api/auth/login', { email, password }),
    get cookie() { return cookie; },
  };
}
