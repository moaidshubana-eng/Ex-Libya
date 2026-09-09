import { generateRecoveryCodes } from './recovery-codes';

describe('generateRecoveryCodes', () => {
  it('يولّد العدد المطلوب من الرموز', () => {
    expect(generateRecoveryCodes(8)).toHaveLength(8);
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it('بصيغة XXXXX-XXXXX بأحرف وأرقام واضحة فقط', () => {
    for (const code of generateRecoveryCodes(20)) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
  });

  it('لا يكرّر نفس الرمز عمليًا ضمن دفعة واحدة', () => {
    const codes = generateRecoveryCodes(20);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
