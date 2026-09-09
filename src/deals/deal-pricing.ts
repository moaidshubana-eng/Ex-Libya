import { DealDirection, MovementType, Prisma, RateType } from '@prisma/client';
import { toMoney, Money } from '../common/money';

export class UnpricableDealError extends Error {}

/** يحدد قيمة السعر المقفلة (رسمي أو موازٍ) من صف سعر صرف منشور. */
export function resolveLockedRate(
  rate: { officialRate: Prisma.Decimal.Value; parallelRate: Prisma.Decimal.Value },
  rateType: RateType,
): Money {
  return toMoney(rateType === RateType.OFFICIAL ? rate.officialRate : rate.parallelRate);
}

export interface UsdEquivalentInput {
  currencyCode: string;
  amount: Prisma.Decimal.Value;
  lydEquivalent: Prisma.Decimal.Value;
  /** آخر سعر رسمي منشور للدولار مقابل الدينار — أساس تحويل ثابت نسبيًا لمقارنة الحدود عبر العملات. */
  usdOfficialRate: Prisma.Decimal.Value | null;
}

/**
 * يحوّل قيمة الصفقة إلى ما يعادلها بالدولار الأمريكي لفحصها مقابل حدود العميل
 * (المُعبَّر عنها دومًا بالدولار بصرف النظر عن عملة الصفقة نفسها).
 * يُستخدم السعر الرسمي للدولار تحديدًا (لا الموازي) كأساس تحويل أكثر استقرارًا.
 */
export function computeUsdEquivalent(input: UsdEquivalentInput): Money {
  if (input.currencyCode === 'USD') return toMoney(input.amount);
  if (!input.usdOfficialRate) {
    throw new UnpricableDealError(
      'تعذّر تحويل قيمة الصفقة إلى ما يعادلها بالدولار لعدم توفر سعر صرف منشور للدولار',
    );
  }
  return toMoney(input.lydEquivalent).dividedBy(input.usdOfficialRate);
}

/** هل تتجاوز قيمة الصفقة (بما يعادلها بالدولار) حد الموافقة المزدوجة؟ */
export function requiresDualApproval(
  amountUsdEquivalent: Prisma.Decimal.Value,
  thresholdUsd: number,
): boolean {
  return toMoney(amountUsdEquivalent).greaterThan(thresholdUsd);
}

/** نوع حركة الخزينة الناتجة عن تنفيذ صفقة، بحسب اتجاهها. */
export function movementTypeForDirection(direction: DealDirection): MovementType {
  return direction === DealDirection.BUY ? MovementType.TRADE_BUY : MovementType.TRADE_SELL;
}
