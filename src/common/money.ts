import { Prisma } from '@prisma/client';

/**
 * أدوات مساعدة للتعامل مع القيم المالية باستخدام Prisma.Decimal بدل الأعداد
 * العشرية الاعتيادية (number)، لتفادي أخطاء التقريب في العمليات النقدية.
 */

export type Money = Prisma.Decimal;

export const toMoney = (value: Prisma.Decimal.Value): Money => new Prisma.Decimal(value);

/** نسبة الانحراف المطلقة بين قيمتين، كنسبة مئوية. يعيد 0 إذا كانت القيمة المرجعية صفرًا. */
export function deviationPercent(
  previous: Prisma.Decimal.Value,
  next: Prisma.Decimal.Value,
): Money {
  const prev = toMoney(previous);
  if (prev.isZero()) return toMoney(0);
  return toMoney(next).minus(prev).abs().dividedBy(prev).times(100);
}

export const isPositive = (value: Prisma.Decimal.Value): boolean => toMoney(value).greaterThan(0);
