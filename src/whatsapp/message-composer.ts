import { DealDirection } from '@prisma/client';

export interface RateSummary {
  code: string;
  name: string;
  rate: string;
}

/** الرد الحر على استفسار سعر مباشر — نافذة الخدمة مفتوحة دومًا لأنها ردّ على رسالة العميل. */
export function composeRateInquiryReply(rates: RateSummary[]): string {
  if (rates.length === 0) {
    return 'عذرًا، لا تتوفر أسعار منشورة حاليًا. يرجى المحاولة لاحقًا أو التواصل مع أحد ممثلينا.';
  }
  const lines = rates.map((r) => `${r.name} (${r.code}): ${r.rate}`);
  return ['أسعار الصرف الحالية مقابل الدينار الليبي:', ...lines].join('\n');
}

export function composeHumanHandoffAck(): string {
  return 'شكرًا لتواصلك معنا. تم تحويل رسالتك لأحد ممثلي خدمة العملاء وسيتواصل معك خلال دقائق خلال أوقات الدوام.';
}

/** [رمز العملة، السعر] لقالب RATE_UPDATE. */
export function composeRateUpdateParams(rate: RateSummary): [string, string] {
  return [rate.code, rate.rate];
}

export function composeRateUpdateLogBody(rate: RateSummary): string {
  return `تحديث سعر ${rate.name}: ${rate.rate}`;
}

const DIRECTION_FROM_CLIENT_VIEW: Record<DealDirection, string> = {
  [DealDirection.BUY]: 'شراء منك', // الشركة اشترت من العميل
  [DealDirection.SELL]: 'بيع لك', // الشركة باعت للعميل
};

export interface DealConfirmationInput {
  clientName: string;
  direction: DealDirection;
  amount: string;
  currencyCode: string;
  lockedRate: string;
}

/** [اسم العميل، الاتجاه بالعربية، الكمية والعملة، السعر المنفَّذ] لقالب DEAL_CONFIRMATION. */
export function composeDealConfirmationParams(
  input: DealConfirmationInput,
): [string, string, string, string] {
  return [
    input.clientName,
    DIRECTION_FROM_CLIENT_VIEW[input.direction],
    `${input.amount} ${input.currencyCode}`,
    input.lockedRate,
  ];
}

export function composeDealConfirmationLogBody(input: DealConfirmationInput): string {
  return `تم تنفيذ صفقة ${DIRECTION_FROM_CLIENT_VIEW[input.direction]}: ${input.amount} ${input.currencyCode} بسعر ${input.lockedRate}`;
}

export interface LimitAlertInput {
  clientName: string;
  limitType: 'DAILY' | 'CREDIT';
  usagePercent: string;
}

const LIMIT_TYPE_LABEL: Record<LimitAlertInput['limitType'], string> = {
  DAILY: 'الحد اليومي',
  CREDIT: 'السقف الائتماني',
};

/** [اسم العميل، نوع الحد بالعربية، نسبة الاستخدام] لقالب LIMIT_ALERT. */
export function composeLimitAlertParams(input: LimitAlertInput): [string, string, string] {
  return [input.clientName, LIMIT_TYPE_LABEL[input.limitType], `${input.usagePercent}%`];
}

export function composeLimitAlertLogBody(input: LimitAlertInput): string {
  return `تنبيه اقتراب من ${LIMIT_TYPE_LABEL[input.limitType]} (${input.usagePercent}%) للعميل ${input.clientName}`;
}
