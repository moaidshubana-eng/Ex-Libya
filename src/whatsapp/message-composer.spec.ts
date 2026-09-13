import { ClientBalanceMovementType, DealDirection } from '@prisma/client';
import {
  composeClientBalanceUpdateLogBody,
  composeClientBalanceUpdateParams,
  composeDealConfirmationParams,
  composeLimitAlertParams,
  composeRateInquiryReply,
} from './message-composer';

describe('composeRateInquiryReply', () => {
  it('يبني نصًا يعرض سعر كل عملة', () => {
    const text = composeRateInquiryReply([{ code: 'USD', name: 'دولار أمريكي', rate: '7.90' }]);
    expect(text).toContain('USD');
    expect(text).toContain('7.90');
  });

  it('يعيد رسالة اعتذار عند غياب أي سعر منشور', () => {
    expect(composeRateInquiryReply([])).toMatch(/عذرًا/);
  });
});

describe('composeDealConfirmationParams', () => {
  it('يصف صفقة BUY من منظور العميل كـ"شراء منك"', () => {
    const params = composeDealConfirmationParams({
      clientName: 'شركة الوفاء',
      direction: DealDirection.BUY,
      amount: '5000',
      currencyCode: 'USD',
      lockedRate: '4.85',
    });
    expect(params[1]).toBe('شراء منك');
  });

  it('يصف صفقة SELL من منظور العميل كـ"بيع لك"', () => {
    const params = composeDealConfirmationParams({
      clientName: 'شركة الوفاء',
      direction: DealDirection.SELL,
      amount: '5000',
      currencyCode: 'USD',
      lockedRate: '4.85',
    });
    expect(params[1]).toBe('بيع لك');
  });
});

describe('composeLimitAlertParams', () => {
  it('يترجم نوع الحد إلى تسميته العربية', () => {
    const params = composeLimitAlertParams({
      clientName: 'محمد الفيتوري',
      limitType: 'DAILY',
      usagePercent: '85',
    });
    expect(params).toEqual(['محمد الفيتوري', 'الحد اليومي', '85%']);
  });
});

describe('composeClientBalanceUpdateParams', () => {
  it('يضع إشارة + مع نوع زيادة (إيداع) ويعرض الرصيد الجديد', () => {
    const params = composeClientBalanceUpdateParams({
      clientName: 'محمد الفيتوري',
      type: ClientBalanceMovementType.DEPOSIT,
      amount: '500.00',
      balanceAfter: '1200.00',
      currencyCode: 'USD',
    });
    expect(params).toEqual(['محمد الفيتوري', 'إيداع', '+500.00 USD', '1200.00 USD']);
  });

  it('يضع إشارة - مع نوع نقصان (سحب)', () => {
    const params = composeClientBalanceUpdateParams({
      clientName: 'محمد الفيتوري',
      type: ClientBalanceMovementType.WITHDRAWAL,
      amount: '200.00',
      balanceAfter: '1000.00',
      currencyCode: 'USD',
    });
    expect(params).toEqual(['محمد الفيتوري', 'سحب', '-200.00 USD', '1000.00 USD']);
  });

  it('يترجم تصحيح الزيادة/النقصان اليدوي إلى تسميته العربية', () => {
    expect(
      composeClientBalanceUpdateParams({
        clientName: 'ع',
        type: ClientBalanceMovementType.ADJUSTMENT_INCREASE,
        amount: '10',
        balanceAfter: '20',
        currencyCode: 'LYD',
      })[1],
    ).toBe('تصحيح بالزيادة');
    expect(
      composeClientBalanceUpdateParams({
        clientName: 'ع',
        type: ClientBalanceMovementType.ADJUSTMENT_DECREASE,
        amount: '10',
        balanceAfter: '20',
        currencyCode: 'LYD',
      })[1],
    ).toBe('تصحيح بالنقصان');
  });
});

describe('composeClientBalanceUpdateLogBody', () => {
  it('يبني نصًا يعكس النوع والمبلغ الموقَّع والرصيد الجديد', () => {
    const body = composeClientBalanceUpdateLogBody({
      clientName: 'محمد الفيتوري',
      type: ClientBalanceMovementType.DEPOSIT,
      amount: '500.00',
      balanceAfter: '1200.00',
      currencyCode: 'USD',
    });
    expect(body).toContain('إيداع');
    expect(body).toContain('+500.00 USD');
    expect(body).toContain('1200.00 USD');
  });
});
