import { DealDirection, MovementType, RateType } from '@prisma/client';
import {
  computeUsdEquivalent,
  movementTypeForDirection,
  requiresDualApproval,
  resolveLockedRate,
  UnpricableDealError,
} from './deal-pricing';

describe('resolveLockedRate', () => {
  const rate = { officialRate: '4.85', parallelRate: '7.90' };

  it('يختار السعر الرسمي عند RateType.OFFICIAL', () => {
    expect(resolveLockedRate(rate, RateType.OFFICIAL).toString()).toBe('4.85');
  });

  it('يختار السعر الموازي عند RateType.PARALLEL', () => {
    expect(resolveLockedRate(rate, RateType.PARALLEL).toString()).toBe('7.9');
  });
});

describe('computeUsdEquivalent', () => {
  it('يعيد المبلغ كما هو إن كانت العملة دولارًا', () => {
    const result = computeUsdEquivalent({
      currencyCode: 'USD',
      amount: '5000',
      lydEquivalent: '24250',
      usdOfficialRate: '4.85',
    });
    expect(result.toString()).toBe('5000');
  });

  it('يحوّل عبر سعر الدولار الرسمي لعملة أخرى', () => {
    // صفقة EUR بقيمة 1000 يورو مقفلة على 5.24 → 5240 دينار → ÷4.85 دولار ≈ 1080.41
    const result = computeUsdEquivalent({
      currencyCode: 'EUR',
      amount: '1000',
      lydEquivalent: '5240',
      usdOfficialRate: '4.85',
    });
    expect(result.toFixed(2)).toBe('1080.41');
  });

  it('يرفض التحويل إن لم يتوفر سعر دولار منشور', () => {
    expect(() =>
      computeUsdEquivalent({
        currencyCode: 'EUR',
        amount: '1000',
        lydEquivalent: '5240',
        usdOfficialRate: null,
      }),
    ).toThrow(UnpricableDealError);
  });
});

describe('requiresDualApproval', () => {
  it('لا يتطلب موافقة مزدوجة ضمن الحد', () => {
    expect(requiresDualApproval('29999.99', 30000)).toBe(false);
  });

  it('يتطلب موافقة مزدوجة عند تجاوز الحد', () => {
    expect(requiresDualApproval('30000.01', 30000)).toBe(true);
  });
});

describe('movementTypeForDirection', () => {
  it('BUY → TRADE_BUY', () => {
    expect(movementTypeForDirection(DealDirection.BUY)).toBe(MovementType.TRADE_BUY);
  });

  it('SELL → TRADE_SELL', () => {
    expect(movementTypeForDirection(DealDirection.SELL)).toBe(MovementType.TRADE_SELL);
  });
});
