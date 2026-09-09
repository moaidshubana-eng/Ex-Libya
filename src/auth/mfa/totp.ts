import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { base32Decode, base32Encode } from './base32';

const DEFAULT_DIGITS = 6;
const DEFAULT_TIME_STEP_SECONDS = 30;
const DEFAULT_WINDOW = 1; // يقبل الرمز الحالي وخطوة واحدة قبله/بعده (انحراف ساعة العميل)

/** سرّ TOTP جديد بصيغة Base32 (160 بت) — يُخزَّن مشفّرًا، لا نصًا صريحًا (انظر secret-crypto.ts). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** رابط otpauth:// القياسي لعرضه كرمز QR في تطبيقات المصادقة. */
export function buildOtpAuthUrl(params: {
  secretBase32: string;
  accountEmail: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountEmail}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_TIME_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function hotp(secretBase32: string, counter: number, digits: number): string {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** رمز TOTP الحالي — يُستخدم أساسًا في الاختبارات؛ التحقق الفعلي عبر verifyTotpCode. */
export function generateTotpCode(
  secretBase32: string,
  forTimeMs: number = Date.now(),
  timeStepSeconds = DEFAULT_TIME_STEP_SECONDS,
  digits = DEFAULT_DIGITS,
): string {
  const counter = Math.floor(forTimeMs / 1000 / timeStepSeconds);
  return hotp(secretBase32, counter, digits);
}

/**
 * يتحقق من رمز TOTP بهامش زمني (نافذة خطوات) لتفادي رفض رموز صحيحة بسبب فارق
 * طفيف بين ساعة الخادم وساعة جهاز العميل — دون توسيع النافذة أكثر من اللازم
 * أمنيًا (window=1 افتراضيًا يعني خطوة واحدة ±30 ثانية).
 */
export function verifyTotpCode(
  secretBase32: string,
  candidateCode: string,
  options: { forTimeMs?: number; window?: number; timeStepSeconds?: number; digits?: number } = {},
): boolean {
  const digits = options.digits ?? DEFAULT_DIGITS;
  if (!/^\d+$/.test(candidateCode) || candidateCode.length !== digits) return false;

  const timeStepSeconds = options.timeStepSeconds ?? DEFAULT_TIME_STEP_SECONDS;
  const window = options.window ?? DEFAULT_WINDOW;
  const counter = Math.floor((options.forTimeMs ?? Date.now()) / 1000 / timeStepSeconds);
  const candidateBuffer = Buffer.from(candidateCode, 'utf-8');

  for (let delta = -window; delta <= window; delta += 1) {
    const expected = hotp(secretBase32, counter + delta, digits);
    const expectedBuffer = Buffer.from(expected, 'utf-8');
    if (timingSafeEqual(expectedBuffer, candidateBuffer)) return true;
  }
  return false;
}
