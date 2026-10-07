import { scrypt, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** تجزئة كلمة المرور: scrypt$N$r$p$salt$hash */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(expected, actual);
}

/** سياسة كلمة المرور: 10 أحرف على الأقل مع حرف ورقم */
export function passwordPolicyError(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'كلمة المرور يجب ألا تقل عن 10 أحرف';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'كلمة المرور يجب أن تحتوي على حروف وأرقام';
  return null;
}

/** تشفير حقل حساس AES-256-GCM: v1:iv:tag:ciphertext (base64) */
export function encrypt(plain, key = config.dataKey) {
  if (plain == null || plain === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(blob, key = config.dataKey) {
  if (!blob) return null;
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('صيغة تشفير غير معروفة');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** بصمة بحث ثابتة (HMAC) — تسمح بالبحث بالمطابقة دون تخزين القيمة صريحة */
export function lookupHash(value) {
  if (!value) return null;
  const normalized = String(value).replace(/[\s\-+()]/g, '').toLowerCase();
  return createHmac('sha256', config.lookupKey).update(normalized).digest('hex');
}

export function sha256(data) {
  return createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** إخفاء جزئي للعرض: 0912345678 → 091****678 */
export function mask(value, keepStart = 3, keepEnd = 3) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= keepStart + keepEnd) return '*'.repeat(s.length);
  return s.slice(0, keepStart) + '*'.repeat(s.length - keepStart - keepEnd) + s.slice(-keepEnd);
}
