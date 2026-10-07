import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { query } from './db.js';
import { securityHeaders, csrfGuard, authenticate, errorHandler, HttpError } from './security/middleware.js';
import { api } from './routes/api.js';
import { mockFeedsRouter } from './sync/mock-feeds.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // خلف Nginx على نفس الخادم: نثق بـ X-Forwarded-For منه فقط

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
  app.use(express.json({ limit: '200kb' }));
  app.use('/api', csrfGuard, authenticate, api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'المسار غير موجود')));

  const pub = fileURLToPath(new URL('../public', import.meta.url));
  app.use(express.static(pub, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
  app.use(errorHandler);
  return app;
}
