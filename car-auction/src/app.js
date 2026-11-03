import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { securityHeaders, csrfGuard, authenticate, errorHandler, HttpError } from './security/middleware.js';
import { api } from './routes/api.js';
import { portal } from './routes/portal.js';
import { mockFeedsRouter } from './sync/mock-feeds.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy); // نثق بـ X-Forwarded-For من البروكسي المحدد فقط

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, db: 'up', instance: config.instanceId });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // محاكي التغذيات الخارجية (تطوير/عرض فقط) — قبل رؤوس الأمان لأنه يمثل خادمًا خارجيًا
  if (config.mockFeeds) app.use('/mock', mockFeedsRouter());

  app.use(securityHeaders);
  // رفع الصور وحده يقبل جسمًا أكبر (صورة مضغوطة بترميز base64)؛ بقية المسارات تبقى بحد 200kb
  app.use(/^\/api\/(vehicles|watchlist)\/[^/]+\/images\/?$/, express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use('/api/portal', csrfGuard, portal); // بوابة العملاء: جلسات منفصلة عن الموظفين
  app.use('/api', csrfGuard, authenticate, api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'المسار غير موجود')));

  const pub = fileURLToPath(new URL('../public', import.meta.url));
  // ملفات الواجهة تُخدم تحت مسار يحمل بصمة محتواها (/v/<بصمة>/js/app.js). الصفحة الرئيسية تُفحص في كل
  // تحميل، فإن تغيّر الكود تغيّر المسار، فيجلب المتصفح النسخة الجديدة حتمًا ولا يبقى على كود قديم من ذاكرته.
  // والملفات تحت المسار ذي البصمة لا تتغير أبدًا، فتُخزَّن سنة كاملة
  const build = buildId(pub);
  const indexHtml = readFileSync(join(pub, 'index.html'), 'utf8')
    .replace('src="/js/app.js"', `src="/v/${build}/js/app.js"`)
    .replace('href="/styles.css"', `href="/v/${build}/styles.css"`);
  app.get(['/', '/index.html'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });
  // الحاسبة العامة: صفحة مستقلة بلا تسجيل دخول لأي زائر (الحساب كله في المتصفح، لا تلمس الـAPI)
  const calcHtml = readFileSync(join(pub, 'calc.html'), 'utf8')
    .replace('src="/js/calc-page.js"', `src="/v/${build}/js/calc-page.js"`)
    .replace('href="/styles.css"', `href="/v/${build}/styles.css"`);
  app.get(['/calc', '/calc/', '/calc.html'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(calcHtml);
  });
  // بوابة العملاء: صفحة مستقلة بهوية الشركة (دخول العميل + التتبّع العام بالكود)
  const portalHtml = readFileSync(join(pub, 'portal.html'), 'utf8')
    .replace('src="/js/portal.js"', `src="/v/${build}/js/portal.js"`)
    .replace('href="/styles.css"', `href="/v/${build}/styles.css"`);
  app.get(['/portal', '/portal/', '/portal.html'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(portalHtml);
  });
  app.use('/v/:build', express.static(pub, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
  // الكود (html/js/css) بلا ذاكرة مؤقتة ثابتة: المتصفح يتحقق كل مرة (304 سريع بـ ETag)،
  // فيصل أي تحديث للمستخدمين فورًا. الصور والخطوط فقط تُخزَّن يومًا
  app.use(express.static(pub, {
    index: 'index.html',
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', /\.(html|js|mjs|css|json)$/.test(file) || !config.isProd ? 'no-cache' : 'public, max-age=86400');
    },
  }));
  app.use(errorHandler);
  return app;
}

/** بصمة قصيرة لمحتوى ملفات الواجهة (js و css) — تتغير مع أي تعديل */
function buildId(pub) {
  const h = createHash('sha256');
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (/\.(js|css)$/.test(f.name)) h.update(f.name).update(readFileSync(full));
    }
  };
  walk(pub);
  return h.digest('hex').slice(0, 12);
}
