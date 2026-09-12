import { DealDirection, MovementType } from '@prisma/client';
import {
  computeDealProfitLyd,
  computeUsdEquivalent,
  movementTypeForDirection,
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

describe('computeDealProfitLyd', () => {
  it('BUY: ربح عند شراء العملة من العميل بأقل من قيمتها بالسوق الموازي', () => {
    // الشركة اشترت 1000 دولار بسعر 7.80 (دفعت 7800 دينار) بينما قيمتها بالسوق الموازي 7.90
    const profit = computeDealProfitLyd({
      direction: DealDirection.BUY,
      amount: '1000',
      lockedRate: '7.80',
      parallelMarketRate: '7.90',
    });
    expect(profit.toFixed(2)).toBe('100.00');
  });

  it('BUY: خسارة عند شراء العملة من العميل بأعلى من قيمتها بالسوق الموازي', () => {
    const profit = computeDealProfitLyd({
      direction: DealDirection.BUY,
      amount: '1000',
      lockedRate: '8.00',
      parallelMarketRate: '7.90',
    });
    expect(profit.toFixed(2)).toBe('-100.00');
  });

  it('SELL: ربح عند بيع العملة للعميل بأعلى من قيمتها بالسوق الموازي', () => {
    // الشركة باعت 1000 دولار بسعر 8.00 (حصّلت 8000 دينار) بينما قيمتها بالسوق الموازي 7.90
    const profit = computeDealProfitLyd({
      direction: DealDirection.SELL,
      amount: '1000',
      lockedRate: '8.00',
      parallelMarketRate: '7.90',
    });
    expect(profit.toFixed(2)).toBe('100.00');
  });

  it('SELL: خسارة عند بيع العملة للعميل بأقل من قيمتها بالسوق الموازي', () => {
    const profit = computeDealProfitLyd({
      direction: DealDirection.SELL,
      amount: '1000',
      lockedRate: '7.80',
      parallelMarketRate: '7.90',
    });
    expect(profit.toFixed(2)).toBe('-100.00');
  });

  it('ربح صفري إن تساوى سعر الصفقة مع السوق الموازي', () => {
    const profit = computeDealProfitLyd({
      direction: DealDirection.SELL,
      amount: '500',
      lockedRate: '7.90',
      parallelMarketRate: '7.90',
    });
    expect(profit.toFixed(2)).toBe('0.00');
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
