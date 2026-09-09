import { assessRateChange } from './rate-deviation';

describe('assessRateChange (قاطع دائرة أسعار الصرف)', () => {
  it('يقبل أول سعر يُنشر لعملة دون فحص انحراف', () => {
    const result = assessRateChange({
      previousOfficialRate: null,
      previousParallelRate: null,
      nextOfficialRate: '4.85',
      nextParallelRate: '7.90',
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.accepted).toBe(true);
    expect(result.exceedsThreshold).toBe(false);
    expect(result.resolvedIsOverride).toBe(false);
  });

  it('يقبل تغيّرًا ضمن الحد المسموح به دون الحاجة لسبب تجاوز', () => {
    const result = assessRateChange({
      previousOfficialRate: '4.85',
      previousParallelRate: '7.90',
      nextOfficialRate: '4.90', // ~1.03% تغيّر
      nextParallelRate: '8.00', // ~1.27% تغيّر
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.accepted).toBe(true);
    expect(result.exceedsThreshold).toBe(false);
    expect(result.resolvedIsOverride).toBe(false);
  });

  it('يرفض تغيّرًا يتجاوز الحد المسموح به إن لم يُرفَق بسبب تجاوز', () => {
    const result = assessRateChange({
      previousOfficialRate: '4.85',
      previousParallelRate: '7.90',
      nextOfficialRate: '6.00', // ~23.7% تغيّر
      nextParallelRate: '7.90',
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.accepted).toBe(false);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.resolvedIsOverride).toBe(false);
    expect(result.officialDeviationPercent.greaterThan(20)).toBe(true);
  });

  it('يقبل تجاوز الحد إذا أُرفق بسبب تجاوز موثّق، ويعلّمه كتجاوز يدوي', () => {
    const result = assessRateChange({
      previousOfficialRate: '4.85',
      previousParallelRate: '7.90',
      nextOfficialRate: '6.00',
      nextParallelRate: '7.90',
      maxDeviationPercent: 8,
      hasOverrideReason: true,
    });

    expect(result.accepted).toBe(true);
    expect(result.exceedsThreshold).toBe(true);
    expect(result.resolvedIsOverride).toBe(true);
  });

  it('يفحص السعر الموازي أيضًا وليس الرسمي فقط', () => {
    const result = assessRateChange({
      previousOfficialRate: '4.85',
      previousParallelRate: '7.90',
      nextOfficialRate: '4.86', // تغيّر طفيف
      nextParallelRate: '10.00', // تغيّر كبير في الموازي
      maxDeviationPercent: 8,
      hasOverrideReason: false,
    });

    expect(result.exceedsThreshold).toBe(true);
    expect(result.accepted).toBe(false);
  });
});
