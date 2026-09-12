import { assessRateChange } from './rate-deviation';

describe('assessRateChange (قاطع دائرة أسعار الصرف)', () => {
  it('يقبل أول سعر يُنشر لعملة دون فحص انحراف', () => {
    const result = assessRateChange({
      previousRate: null,
      nextRate: '7.90',
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.accepted).toBe(true);
    expect(result.exceedsThreshold).toBe(false);
    expect(result.resolvedIsOverride).toBe(false);
  });

  it('يقبل تغيّرًا ضمن الحد المسموح به دون الحاجة لسبب تجاوز', () => {
    const result = assessRateChange({
      previousRate: '7.90',
      nextRate: '8.00', // ~1.27% تغيّر
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.accepted).toBe(true);
    expect(result.exceedsThreshold).toBe(false);
    expect(result.resolvedIsOverride).toBe(false);
  });

  it('يرفض تغيّرًا يتجاوز الحد المسموح به إن لم يُرفَق بسبب تجاوز', () => {
    const result = assessRateChange({
      previousRate: '7.90',
      nextRate: '10.00', // ~26.6% تغيّر
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.accepted).toBe(false);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.resolvedIsOverride).toBe(false);
    expect(result.deviationPercent.greaterThan(20)).toBe(true);
  });

  it('يقبل تجاوز الحد إذا أُرفق بسبب تجاوز موثّق، ويعلّمه كتجاوز يدوي', () => {
    const result = assessRateChange({
      previousRate: '7.90',
      nextRate: '10.00',
      maxDeviationPercent: 8,
      hasOverrideReason: true,
    });

    expect(result.accepted).toBe(true);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.resolvedIsOverride).toBe(true);
  });
});
