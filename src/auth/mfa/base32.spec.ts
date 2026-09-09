import { base32Decode, base32Encode } from './base32';

describe('base32', () => {
  it('يشفّر ثم يفكّ نصًا معروفًا مطابقًا لمرجع RFC 4648', () => {
    // "Hello!" — قيمة اختبار قياسية شائعة للتحقق من تطابق التنفيذ
    const input = Buffer.from('Hello!', 'utf-8');
    expect(base32Encode(input)).toBe('JBSWY3DPEE======'.replace(/=+$/, ''));
  });

  it('عملية ذهاب وإياب (round-trip) تعيد البيانات الأصلية لأي طول', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'sixteen bytes!!!', 'عربي مختلط ASCII']) {
      const original = Buffer.from(text, 'utf-8');
      const roundTripped = base32Decode(base32Encode(original));
      expect(roundTripped.equals(original)).toBe(true);
    }
  });

  it('يتجاهل حروف الحشو (=) وحساسية حالة الأحرف عند فك الترميز', () => {
    const original = Buffer.from('test-secret', 'utf-8');
    const encoded = base32Encode(original);
    expect(base32Decode(encoded.toLowerCase() + '===').equals(original)).toBe(true);
  });
});
