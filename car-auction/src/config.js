// الإعدادات من متغيرات البيئة — لا أسرار مكتوبة في الكود.
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// تحميل ملف .env بسيط (بدون مكتبة خارجية) إن وُجد
if (existsSync(new URL('../.env', import.meta.url))) {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function requiredInProd(name, devFallback) {
  if (env[name]) return env[name];
  if (isProd) throw new Error(`متغير البيئة ${name} مطلوب في الإنتاج`);
  return devFallback;
}

export const config = {
  isProd,
  port: Number(env.PORT || 4000),
  databaseUrl: env.DATABASE_URL || 'postgresql://auction:auction@localhost:5432/car_auction',
  dbPoolMax: Number(env.DB_POOL_MAX || 20),
  // مفتاح تشفير البيانات الحساسة (32 بايت base64). في التطوير يُولَّد ثابتًا للتجربة فقط.
  dataKey: Buffer.from(requiredInProd('DATA_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64')), 'base64'),
  // مفتاح HMAC منفصل لبصمات البحث (الهاتف/الهوية)
  lookupKey: Buffer.from(requiredInProd('LOOKUP_HMAC_KEY', Buffer.alloc(32, 9).toString('base64')), 'base64'),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 10),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  mockFeeds: env.MOCK_FEEDS ? env.MOCK_FEEDS === 'true' : !isProd,
  schedulerEnabled: env.SCHEDULER_ENABLED ? env.SCHEDULER_ENABLED === 'true' : true,
  sources: {
    COPART: { baseUrl: env.COPART_FEED_URL || null, token: env.COPART_API_TOKEN || null },
    IAAI: { baseUrl: env.IAAI_FEED_URL || null, token: env.IAAI_API_TOKEN || null },
    TRACKING: { baseUrl: env.TRACKING_API_URL || null, token: env.TRACKING_API_TOKEN || null },
  },
  instanceId: env.INSTANCE_ID || randomBytes(4).toString('hex'),
};
