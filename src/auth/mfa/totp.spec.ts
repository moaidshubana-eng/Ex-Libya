import { base32Encode } from './base32';
import { buildOtpAuthUrl, generateTotpCode, generateTotpSecret, verifyTotpCode } from './totp';

// سرّ الاختبار القياسي من RFC 6238 الملحق ب (Appendix B): 20 بايت ASCII "12345678901234567890"
const RFC_6238_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('generateTotpCode — مقارنة بمتجهات اختبار RFC 6238 المرجعية', () => {
  it.each([
    [59_000, '94287082'],
    [1_111_111_109_000, '07081804'],
    [1_111_111_111_000, '14050471'],
    [1_234_567_890_000, '89005924'],
    [2_000_000_000_000, '69279037'],
  ])('عند الزمن %p تُنتج الرمز %p (8 خانات، SHA1، خطوة 30 ثانية)', (timeMs, expected) => {
    expect(generateTotpCode(RFC_6238_SECRET, timeMs, 30, 8)).toBe(expected);
  });
});

describe('verifyTotpCode', () => {
  it('يقبل الرمز الصحيح للحظة الحالية', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = generateTotpCode(secret, now);
    expect(verifyTotpCode(secret, code, { forTimeMs: now })).toBe(true);
  });

  it('يقبل رمزًا من خطوة زمنية سابقة ضمن هامش النافذة (انحراف ساعة)', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const previousStepCode = generateTotpCode(secret, now - 30_000);
    expect(verifyTotpCode(secret, previousStepCode, { forTimeMs: now, window: 1 })).toBe(true);
  });

  it('يرفض رمزًا خارج نطاق النافذة الزمنية', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const farPastCode = generateTotpCode(secret, now - 5 * 30_000);
    expect(verifyTotpCode(secret, farPastCode, { forTimeMs: now, window: 1 })).toBe(false);
  });

  it('يرفض رمزًا خاطئًا أو غير رقمي', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, '000000')).toBe(false);
    expect(verifyTotpCode(secret, 'abcdef')).toBe(false);
    expect(verifyTotpCode(secret, '12345')).toBe(false); // طول خاطئ
  });
});

describe('buildOtpAuthUrl', () => {
  it('يبني رابط otpauth صالحًا يحمل السرّ والمُصدِر والحساب', () => {
    const url = buildOtpAuthUrl({
      secretBase32: 'JBSWY3DPEHPK3PXP',
      accountEmail: 'admin@exlibya.ly',
      issuer: 'ExLibya',
    });
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=ExLibya');
    expect(url).toContain(encodeURIComponent('ExLibya:admin@exlibya.ly'));
  });
});
