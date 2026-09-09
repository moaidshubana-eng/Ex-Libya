import { decryptMfaSecret, encryptMfaSecret, InvalidMfaEncryptionKeyError } from './secret-crypto';

const KEY = '2f1c9a4e7b6d3f0851a2c4e6b8d0f2a41c3e5a7b9d1f3042c5e7a9b1d3f5062e';
const OTHER_KEY = '0'.repeat(64);

describe('encryptMfaSecret / decryptMfaSecret', () => {
  it('عملية ذهاب وإياب تعيد السرّ الأصلي', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = encryptMfaSecret(secret, KEY);
    expect(decryptMfaSecret(encrypted, KEY)).toBe(secret);
  });

  it('لا يخزّن السرّ كنص صريح — القيمة المشفّرة لا تحتوي عليه', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptMfaSecret(secret, KEY)).not.toContain(secret);
  });

  it('كل تشفير ينتج قيمة مختلفة لنفس المدخل (IV عشوائي)', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encryptMfaSecret(secret, KEY)).not.toBe(encryptMfaSecret(secret, KEY));
  });

  it('يرفض فكّ التشفير بمفتاح مختلف', () => {
    const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP', KEY);
    expect(() => decryptMfaSecret(encrypted, OTHER_KEY)).toThrow();
  });

  it('يرفض قيمة مشفّرة جرى العبث بها (فشل التحقق من وسم GCM)', () => {
    const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP', KEY);
    const [iv, authTag, ciphertext] = encrypted.split(':');
    const tampered = [iv, authTag, ciphertext.slice(0, -2) + '00'].join(':');
    expect(() => decryptMfaSecret(tampered, KEY)).toThrow();
  });

  it('يرفض مفتاحًا بطول أو صيغة غير صالحة', () => {
    expect(() => encryptMfaSecret('secret', 'not-hex')).toThrow(InvalidMfaEncryptionKeyError);
    expect(() => encryptMfaSecret('secret', 'ab')).toThrow(InvalidMfaEncryptionKeyError);
  });
});
