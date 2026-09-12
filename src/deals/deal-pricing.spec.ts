import { DealDirection, MovementType } from '@prisma/client';
import {
  computeUsdEquivalent,
  movementTypeForDirection,
  requiresDualApproval,
  UnpricableDealError,
} from './deal-pricing';

describe('computeUsdEquivalent', () => {
  it('يعيد المبلغ كما هو إن كانت العملة دولارًا', () => {
    const result = computeUsdEquivalent({
      currencyCode: 'USD',
      amount: '5000',
      lydEquivalent: '39500',
      usdRate: '7.90',
    });
    expect(result.toString()).toBe('5000');
  });

  it('يحوّل عبر سعر الدولار لعملة أخرى', () => {
    // صفقة EUR بقيمة 1000 يورو مقفلة على 8.55 → 8550 دينار → ÷7.90 دولار ≈ 1082.28
    const result = computeUsdEquivalent({
      currencyCode: 'EUR',
      amount: '1000',
      lydEquivalent: '8550',
      usdRate: '7.90',
    });
    expect(result.toFixed(2)).toBe('1082.28');
  });

  it('يرفض التحويل إن لم يتوفر سعر دولار منشور', () => {
    expect(() =>
      computeUsdEquivalent({
        currencyCode: 'EUR',
        amount: '1000',
        lydEquivalent: '8550',
        usdRate: null,
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
