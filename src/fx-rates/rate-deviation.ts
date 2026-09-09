import { Prisma } from '@prisma/client';
import { deviationPercent, toMoney } from '../common/money';

export interface RateDeviationCheckInput {
  previousOfficialRate: Prisma.Decimal.Value | null;
  previousParallelRate: Prisma.Decimal.Value | null;
  nextOfficialRate: Prisma.Decimal.Value;
  nextParallelRate: Prisma.Decimal.Value;
  maxDeviationPercent: number;
  hasOverrideReason: boolean;
}

export interface RateDeviationResult {
  /** أعلى نسبة انحراف مسجّلة بين السعرَين الرسمي والموازي مقارنة بآخر سعر منشور. */
  officialDeviationPercent: Prisma.Decimal;
  parallelDeviationPercent: Prisma.Decimal;
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
 * بسبب تجاوز يدوي موثّق (overrideReason)، وهو ما يُترجم لاحقًا في الخدمة إلى
 * صلاحية "مدير خزينة" على مستوى المسار نفسه.
 *
 * دالة نقية بلا اتصال بقاعدة بيانات؛ سهلة الاختبار بمعزل عن Prisma.
 */
export function assessRateChange(input: RateDeviationCheckInput): RateDeviationResult {
  // لا يوجد سعر سابق (أول سعر يُنشر لهذه العملة) — لا معنى لفحص الانحراف.
  if (input.previousOfficialRate === null || input.previousParallelRate === null) {
    return {
      officialDeviationPercent: toMoney(0),
      parallelDeviationPercent: toMoney(0),
      exceedsThreshold: false,
      accepted: true,
      resolvedIsOverride: false,
    };
  }

  const officialDeviationPercent = deviationPercent(
    input.previousOfficialRate,
    input.nextOfficialRate,
  );
  const parallelDeviationPercent = deviationPercent(
    input.previousParallelRate,
    input.nextParallelRate,
  );

  const exceedsThreshold =
    officialDeviationPercent.greaterThan(input.maxDeviationPercent) ||
    parallelDeviationPercent.greaterThan(input.maxDeviationPercent);

  const accepted = !exceedsThreshold || input.hasOverrideReason;

  return {
    officialDeviationPercent,
    parallelDeviationPercent,
    exceedsThreshold,
    accepted,
    resolvedIsOverride: exceedsThreshold && input.hasOverrideReason,
  };
}
