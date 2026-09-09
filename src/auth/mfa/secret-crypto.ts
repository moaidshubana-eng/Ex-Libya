import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // الطول الموصى به لـ GCM

export class InvalidMfaEncryptionKeyError extends Error {}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new InvalidMfaEncryptionKeyError(
      'MFA_ENCRYPTION_KEY يجب أن يكون 64 خانة سداسية عشرية (32 بايت) — استخدم: openssl rand -hex 32',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * يشفّر سرّ TOTP قبل تخزينه (AES-256-GCM). خلافًا لكلمة المرور، يجب فكّ تشفير
 * هذا السرّ لاحقًا لحساب رمز TOTP ومقارنته — لذا لا يصلح التجزئة أحادية الاتجاه
 * (Argon2/bcrypt) هنا، ويصلح فقط تشفير عكسي بمفتاح خادم لا يُخزَّن في قاعدة البيانات.
 */
export function encryptMfaSecret(plainSecret: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainSecret, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

export function decryptMfaSecret(encrypted: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const [ivHex, authTagHex, ciphertextHex] = encrypted.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('صيغة سرّ TOTP المشفّر غير صالحة');
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(), // يرمي استثناءً تلقائيًا إن كان النص المشفّر أو الوسم قد جرى العبث بهما
  ]);
  return plaintext.toString('utf-8');
}
