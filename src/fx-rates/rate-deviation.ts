import { Prisma } from '@prisma/client';
import { deviationPercent, toMoney } from '../common/money';

export interface RateDeviationCheckInput {
  previousRate: Prisma.Decimal.Value | null;
  nextRate: Prisma.Decimal.Value;
  maxDeviationPercent: number;
  hasOverrideReason: boolean;
}

export interface RateDeviationResult {
  /** نسبة الانحراف بين السعر الجديد وآخر سعر منشور. */
  deviationPercent: Prisma.Decimal;
  /** هل تجاوز الانحراف الحد المسموح به؟ */
  exceedsThreshold: boolean;
  /** هل يُقبل النشر بعد تطبيق قاطع الدائرة؟ */
  accepted: boolean;
  /** مصدر السعر الناتج عن هذا التقييم. */
  resolvedIsOverride: boolean;
}

/**
 * قاطع الدائرة (Circuit Breaker) لمحرك أسعار الصرف: يقارن السعر الجديد بآخر
 * سعر منشور، ويرفض أي تغيّر يتجاوز نسبة الانحراف المسموح بها ما لم يُرفَق
 * بسبب تجاوز يدوي موثّق (overrideReason) — يُترجم لاحقًا في الخدمة إلى
 * صلاحية "مدير خزينة" على مستوى المسار نفسه.
 *
 * دالة نقية بلا اتصال بقاعدة بيانات؛ سهلة الاختبار بمعزل عن Prisma.
 */
export function assessRateChange(input: RateDeviationCheckInput): RateDeviationResult {
  // لا يوجد سعر سابق (أول سعر يُنشر لهذه العملة) — لا معنى لفحص الانحراف.
  if (input.previousRate === null) {
    return {
      deviationPercent: toMoney(0),
      exceedsThreshold: false,
      accepted: true,
      resolvedIsOverride: false,
    };
  }

  const deviation = deviationPercent(input.previousRate, input.nextRate);
  const exceedsThreshold = deviation.greaterThan(input.maxDeviationPercent);
  const accepted = !exceedsThreshold || input.hasOverrideReason;

  return {
    deviationPercent: deviation,
    exceedsThreshold,
    accepted,
    resolvedIsOverride: exceedsThreshold && input.hasOverrideReason,
  };
}
