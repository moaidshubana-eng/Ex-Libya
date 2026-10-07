// بث أحداث المزاد لحظيًا (Server-Sent Events).
// كل نسخة من الخادم تستمع لقناة PostgreSQL (LISTEN/NOTIFY) فتصل المزايدة
// المسجلة على أي نسخة إلى كل المتصفحين على كل النسخ — توسع أفقي بلا Redis.
import pg from 'pg';
import { config } from '../config.js';

const CHANNEL = 'auction_events';
const clients = new Map(); // lotId -> Set<res>
let listener = null;

export async function startRealtime() {
  listener = new pg.Client({ connectionString: config.databaseUrl });
  await listener.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  listener.on('notification', (msg) => {
    try {
      const evt = JSON.parse(msg.payload);
      fanOut(evt.lotId, evt);
      fanOut('*', evt);
    } catch (e) {
      console.error('[realtime] bad payload', e.message);
    }
  });
  listener.on('error', (e) => console.error('[realtime] listener error', e.message));
  // نبض كل 25 ثانية يبقي الاتصال حيًا عبر البروكسيات
  setInterval(() => {
    for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
  }, 25_000).unref();
}

export async function stopRealtime() {
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
