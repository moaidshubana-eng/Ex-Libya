// واجهة بوابة العملاء /api/portal — منفصلة تمامًا عن واجهة الموظفين: كوكي مختلف (psid)، وكل استعلام مقيّد بالعميل.
import express from 'express';
import { asyncH, rateLimit, HttpError } from '../security/middleware.js';
import { validate, t, isUuid } from '../validate.js';
import { config } from '../config.js';
import { portalLogin, portalSession, portalLogout, portalChangePassword, myCars, myCar, myStatement, trackByCode, trackByVin, portalImage, PORTAL_SESSION_HOURS, PORTAL_STAGES } from '../services/portal.js';
import { apicarEnabled, lookupVin, auctionImage, publicCar } from '../services/apicar.js';

export const portal = express.Router();

const COOKIE = 'psid';
const readCookie = (req) => {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
};
const needCustomer = asyncH(async (req, _res, next) => {
  req.customer = await portalSession(readCookie(req));
  if (!req.customer) throw new HttpError(401, 'UNAUTHENTICATED', 'سجّل الدخول أولًا');
  next();
});
const sendImage = (res, r) => {
  res.set('Cache-Control', 'private, max-age=86400, immutable');
  res.set('Content-Security-Policy', "default-src 'none'");
  res.set('Content-Type', r.mime);
  res.set('ETag', `"${r.sha256}"`);
  res.send(r.content);
};

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `p|${req.ip}|${String(req.body?.phone || '').replace(/\D/g, '')}`, code: 'TOO_MANY_LOGINS' });
const trackLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (req) => `t|${req.ip}`, code: 'TOO_MANY_LOOKUPS' });

portal.get('/stages', (_req, res) => res.json({ stages: PORTAL_STAGES.map(({ key, label }) => ({ key, label })), auctionSearch: apicarEnabled() }));

portal.post('/login', loginLimiter, asyncH(async (req, res) => {
  const b = validate(req.body, { phone: t.string({ required: true, min: 6, max: 30 }), password: t.string({ required: true, max: 100 }) });
  const out = await portalLogin(b.phone, b.password, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(COOKIE, out.token, { httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, maxAge: PORTAL_SESSION_HOURS * 3600_000, path: '/' });
  res.json({ customer: out.customer });
}));

portal.post('/logout', needCustomer, asyncH(async (req, res) => {
  await portalLogout(req.customer.session_id);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}));

portal.get('/me', needCustomer, (req, res) => {
  res.json({ customer: { name: req.customer.full_name, code: req.customer.code, mustChange: req.customer.must_change } });
});

portal.post('/password', needCustomer, rateLimit({ windowMs: 15 * 60_000, max: 10, key: (req) => `pp|${req.customer.customer_id}` }), asyncH(async (req, res) => {
  const b = validate(req.body, { current: t.string({ required: true, max: 100 }), next: t.string({ required: true, max: 100 }) });
  res.json(await portalChangePassword(req.customer.customer_id, req.customer.session_id, b.current, b.next));
}));

portal.get('/cars', needCustomer, asyncH(async (req, res) => res.json({ items: await myCars(req.customer.customer_id) })));
portal.get('/cars/:id', needCustomer, asyncH(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
  res.json(await myCar(req.customer.customer_id, req.params.id));
}));
portal.get('/statement', needCustomer, asyncH(async (req, res) => res.json(await myStatement(req.customer.customer_id))));
portal.get('/media/:vehicleId/:imageId', needCustomer, asyncH(async (req, res) => {
  if (!isUuid(req.params.vehicleId) || !isUuid(req.params.imageId)) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  sendImage(res, await portalImage({ customerId: req.customer.customer_id, vehicleId: req.params.vehicleId, imageId: req.params.imageId }));
}));

// التتبّع العام بلا دخول
portal.get('/vin/:vin', trackLimiter, asyncH(async (req, res) => {
  try {
    // أولًا: سيارة مسجّلة عندنا (تتبّع كامل بمراحلها)
    return res.json({ ...await trackByVin(req.params.vin), source: 'ours' });
  } catch (e) {
    if (e.status !== 404 || !apicarEnabled()) throw e;
    // غير مسجّلة عندنا: نجيبها من المزاد للعرض (إن كانت الخدمة مفعّلة)
    const car = publicCar(await lookupVin(req.params.vin));
    if (!car) throw new HttpError(404, 'NOT_FOUND', 'ما لقيناش سيارة بهذا الرقم، لا عندنا ولا في المزادات');
    res.json(car);
  }
}));
portal.get('/auction/:vin/image/:idx', trackLimiter, asyncH(async (req, res) => {
  if (!/^[A-HJ-NPR-Za-hj-npr-z0-9]{17}$/.test(req.params.vin) || !/^\d{1,2}$/.test(req.params.idx)) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  const im = await auctionImage(req.params.vin, req.params.idx);
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('Content-Security-Policy', "default-src 'none'");
  res.set('Content-Type', im.mime);
  res.send(im.buf);
}));
portal.get('/track/:code', trackLimiter, asyncH(async (req, res) => res.json(await trackByCode(req.params.code))));
portal.get('/track/:code/media/:vehicleId/:imageId', trackLimiter, asyncH(async (req, res) => {
  const code = String(req.params.code).toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(code) || !isUuid(req.params.vehicleId) || !isUuid(req.params.imageId)) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
  sendImage(res, await portalImage({ trackCode: code, vehicleId: req.params.vehicleId, imageId: req.params.imageId }));
}));

portal.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'المسار غير موجود')));
