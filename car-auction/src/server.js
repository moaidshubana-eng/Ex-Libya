import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startRealtime, stopRealtime } from './services/realtime.js';
import { auctionTick } from './services/auctions.js';
import { schedulerTick } from './sync/engine.js';

const app = createApp();
await startRealtime();

const server = app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}  (instance ${config.instanceId}, mockFeeds=${config.mockFeeds})`);
});
server.keepAliveTimeout = 65_000;

// حلقات الخلفية: إغلاق/فتح المزادات كل 3 ثوانٍ، والمجدول كل دقيقة.
// كلتاهما محمية بقفل استشاري في PostgreSQL، فتشغيل عدة نسخ آمن.
const timers = [
  setInterval(() => auctionTick().catch((e) => console.error('[auction-tick]', e.message)), 3_000),
];
if (config.schedulerEnabled) {
  timers.push(setInterval(() => schedulerTick().catch((e) => console.error('[scheduler]', e.message)), 60_000));
}

// إيقاف نظيف: لا قبول لاتصالات جديدة، إنهاء الحلقات، ثم إغلاق قاعدة البيانات
async function shutdown(sig) {
  console.log(`[server] ${sig} — shutting down`);
  timers.forEach(clearInterval);
  server.close();
  server.closeAllConnections?.();
  await stopRealtime();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
