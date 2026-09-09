import { DealDirection } from '@prisma/client';
import {
  composeDealConfirmationParams,
  composeLimitAlertParams,
  composeRateInquiryReply,
} from './message-composer';

describe('composeRateInquiryReply', () => {
  it('يبني نصًا يعرض كل عملة بسعرَيها الرسمي والموازي', () => {
    const text = composeRateInquiryReply([
      { code: 'USD', name: 'دولار أمريكي', officialRate: '4.85', parallelRate: '7.90' },
    ]);
    expect(text).toContain('USD');
    expect(text).toContain('4.85');
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
