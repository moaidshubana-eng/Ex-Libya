// بث أحداث المزاد لحظيًا (Server-Sent Events).
// كل نسخة من الخادم تستمع لقناة PostgreSQL (LISTEN/NOTIFY) فتصل المزايدة
// المسجلة على أي نسخة إلى كل المتصفحين على كل النسخ — توسع أفقي بلا Redis.
import pg from 'pg';
import { config } from '../config.js';

const CHANNEL = 'auction_events';
const clients = new Map(); // lotId -> Set<res>
let listener = null;

let stopping = false;
let retryTimer = null;

export async function startRealtime() {
  stopping = false;
  await connectListener();
  // نبض كل 25 ثانية يبقي الاتصال حيًا عبر البروكسيات
  setInterval(() => {
    for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
  }, 25_000).unref();
}

// اتصال الاستماع قد ينقطع (إعادة تشغيل القاعدة المُدارة، سبات Neon، انقطاع شبكة):
// نعيد الاتصال تلقائيًا بفواصل متزايدة حتى لا يتوقف البث اللحظي بصمت
async function connectListener(attempt = 0) {
  const c = new pg.Client({ connectionString: config.databaseUrl });
  let dropped = false;
  const onDrop = (why) => {
    if (dropped || stopping) return;
    dropped = true;
    console.error('[realtime] listener lost:', why);
    c.end().catch(() => {});
    scheduleReconnect(0);
  };
  c.on('error', (e) => onDrop(e.message));
  c.on('end', () => onDrop('connection ended'));
  c.on('notification', (msg) => {
    try {
      const evt = JSON.parse(msg.payload);
      fanOut(evt.lotId, evt);
      fanOut('*', evt);
    } catch (e) {
      console.error('[realtime] bad payload', e.message);
    }
  });
  try {
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
  } catch (e) {
    dropped = true;
    c.end().catch(() => {});
    if (attempt === 0 && !listener) throw e; // فشل أول إقلاع: يظهر للمشغّل فورًا
    console.error('[realtime] reconnect failed:', e.message);
    scheduleReconnect(attempt + 1);
    return;
  }
  listener = c;
  if (attempt > 0) console.log('[realtime] listener reconnected');
}

function scheduleReconnect(attempt) {
  if (stopping || retryTimer) return;
  const delay = Math.min(30_000, 1000 * 2 ** attempt);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connectListener(Math.max(1, attempt)).catch((e) => console.error('[realtime]', e.message));
  }, delay);
  retryTimer.unref?.();
}

export async function stopRealtime() {
  stopping = true;
  clearTimeout(retryTimer);
  await listener?.end().catch(() => {});
}

function fanOut(key, evt) {
  const set = clients.get(key);
  if (!set) return;
  const data = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of set) res.write(data);
}

/** ينشر حدثًا داخل المعاملة: لا يصل للمشتركين إلا بعد COMMIT (سلوك NOTIFY في PostgreSQL) */
export async function publish(client, evt) {
  await client.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(evt)]);
}

export function subscribe(req, res, key) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);
  req.on('close', () => {
    clients.get(key)?.delete(res);
  });
}

export function subscriberCount() {
  let n = 0;
  for (const s of clients.values()) n += s.size;
  return n;
}
