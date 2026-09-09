import { randomInt } from 'crypto';

// يستبعد المتشابهة بصريًا (0/O، 1/I/L) لتقليل أخطاء النسخ اليدوي
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP_LENGTH = 5;
const GROUPS_PER_CODE = 2;

function randomGroup(): string {
  let group = '';
  for (let i = 0; i < GROUP_LENGTH; i += 1) {
    group += ALPHABET[randomInt(ALPHABET.length)];
  }
  return group;
}

/** رموز استرداد أحادية الاستخدام لحساب فقد جهاز المصادقة — بصيغة "XXXXX-XXXXX" سهلة القراءة والنسخ. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    Array.from({ length: GROUPS_PER_CODE }, randomGroup).join('-'),
  );
}
