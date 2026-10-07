import { query } from '../db.js';
import { sha256 } from './crypto.js';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const ROLES = {
  STAFF: ['ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES', 'VIEWER'],
  COST_READERS: ['ADMIN', 'ACCOUNTANT', 'OPERATIONS', 'VIEWER', 'SALES'],
  COST_WRITERS: ['ADMIN', 'ACCOUNTANT', 'OPERATIONS'],
  LOGISTICS_WRITERS: ['ADMIN', 'OPERATIONS'],
  AUCTION_MANAGERS: ['ADMIN', 'SALES'],
  BIDDERS: ['BIDDER', 'SALES', 'ADMIN'],
};

/** رؤوس أمان HTTP (بديل مختصر لـ helmet) */
export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** حماية CSRF: كل طلب معدِّل يجب أن يكون JSON ومن نفس الأصل (مع كوكي SameSite=Strict) */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'BAD_ORIGIN', 'أصل الطلب غير مسموح'));
  const ct = req.get('content-type') || '';
  if (!ct.startsWith('application/json') && !ct.startsWith('text/csv'))
    return next(new HttpError(415, 'UNSUPPORTED_MEDIA', 'يجب إرسال البيانات بصيغة JSON'));
  next();
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** التحقق من الجلسة (كوكي httpOnly أو Authorization: Bearer للأدوات الآلية) */
export async function authenticate(req, _res, next) {
  try {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const token = bearer || readCookie(req, 'sid');
    if (!token) return next();
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, s.id AS session_id
         FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
      [sha256(token)],
    );
    if (rows[0]) req.user = rows[0];
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'يجب تسجيل الدخول'));
  next();
}

export function requireRole(...allowed) {
  const set = new Set(allowed.flat());
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'يجب تسجيل الدخول'));
    if (!set.has(req.user.role)) return next(new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية هذا الإجراء'));
    next();
  };
}

/**
 * محدد معدل الطلبات (نافذة منزلقة في الذاكرة). في نشر متعدد النسخ يُستبدل بـ Redis
 * بنفس الواجهة — انظر docs/06-security-policy.md.
 */
export function rateLimit({ windowMs, max, key, code = 'RATE_LIMITED' }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => t > now - windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil((arr[0] + windowMs - now) / 1000));
      return next(new HttpError(429, code, 'طلبات كثيرة جدًا، حاول بعد قليل'));
    }
    arr.push(now);
    hits.set(k, arr);
    next();
  };
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.minimum ? { minimum: err.minimum } : {}) } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'JSON غير صالح' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'حجم الطلب كبير جدًا' } });
  // أخطاء قاعدة البيانات المعروفة تُترجم لرسائل مفهومة دون كشف التفاصيل الداخلية
  if (err.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'السجل موجود مسبقًا أو يتعارض مع سجل آخر' } });
  if (err.code === '23514' || err.code === '22P02' || err.code === '23503')
    return res.status(422).json({ error: { code: 'CONSTRAINT', message: err.code === '23514' && /[؀-ۿ]/.test(err.message) ? err.message : 'البيانات المدخلة تخالف قواعد النظام' } });
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'خطأ داخلي في الخادم' } });
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
