import { DealDirection, MovementType, Prisma } from '@prisma/client';
import { toMoney, Money } from '../common/money';

export class UnpricableDealError extends Error {}

export interface UsdEquivalentInput {
  currencyCode: string;
  amount: Prisma.Decimal.Value;
  lydEquivalent: Prisma.Decimal.Value;
  /** آخر سعر منشور للدولار مقابل الدينار — أساس تحويل ثابت نسبيًا لمقارنة الحدود عبر العملات. */
  usdRate: Prisma.Decimal.Value | null;
}

/**
 * يحوّل قيمة الصفقة إلى ما يعادلها بالدولار الأمريكي لفحصها مقابل حدود العميل
 * (المُعبَّر عنها دومًا بالدولار بصرف النظر عن عملة الصفقة نفسها).
 */
export function computeUsdEquivalent(input: UsdEquivalentInput): Money {
  if (input.currencyCode === 'USD') return toMoney(input.amount);
  if (!input.usdRate) {
    throw new UnpricableDealError(
      'تعذّر تحويل قيمة الصفقة إلى ما يعادلها بالدولار لعدم توفر سعر صرف منشور للدولار',
    );
  }
  return toMoney(input.lydEquivalent).dividedBy(input.usdRate);
}

export interface DealProfitInput {
  direction: DealDirection;
  amount: Prisma.Decimal.Value;
  /** سعر بيع/شراء الصفقة المقفل من ExchangeRate.rate عند الإنشاء. */
  lockedRate: Prisma.Decimal.Value;
  /** سعر السوق الموازي المرجعي وقت الصفقة — أساس التكلفة الحقيقية لاحتساب الهامش. */
  parallelMarketRate: Prisma.Decimal.Value;
}

/**
 * هامش ربح/خسارة الصفقة بالدينار الليبي — الفرق بين سعر البيع المقفل وسعر
 * السوق الموازي المرجعي، مضروبًا بكمية الصفقة. الاتجاه يقلب الإشارة: في
 * البيع (SELL) الشركة تُسلِّم للسوق الموازي بسعره وتُحصِّل من العميل بسعرها
 * — فالهامش موجب إن كان سعرها أعلى من الموازي. في الشراء (BUY) العكس: الشركة
 * تدفع للعميل بسعرها وتُقيَّم العملة المُستلَمة بسعر السوق الموازي — فالهامش
 * موجب إن كان سعرها (المدفوع للعميل) أقل من قيمة العملة في السوق الموازي.
 */
export function computeDealProfitLyd(input: DealProfitInput): Money {
  const perUnitDiff = toMoney(input.lockedRate).minus(input.parallelMarketRate);
  const signedPerUnit =
    input.direction === DealDirection.SELL ? perUnitDiff : perUnitDiff.negated();
  return signedPerUnit.times(input.amount);
}

/** نوع حركة الخزينة الناتجة عن تنفيذ صفقة (طرف العملة الأجنبية)، بحسب اتجاهها. */
export function movementTypeForDirection(direction: DealDirection): MovementType {
  return direction === DealDirection.BUY ? MovementType.TRADE_BUY : MovementType.TRADE_SELL;
}

/**
 * نوع حركة الخزينة للطرف المقابل بالدينار الليبي (التسوية النقدية الفعلية مع
 * العميل بسعر الصفقة المقفل) — عكس اتجاه طرف العملة الأجنبية: شراء عملة من
 * عميل يعني دفع دينار له (نقصان)، وبيعها له يعني تحصيل دينار منه (زيادة).
 */
export function settlementMovementTypeForDirection(direction: DealDirection): MovementType {
  return direction === DealDirection.BUY
    ? MovementType.TRADE_BUY_SETTLEMENT
    : MovementType.TRADE_SELL_SETTLEMENT;
}
