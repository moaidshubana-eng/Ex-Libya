import { MovementType } from '@prisma/client';

const INCREASING_TYPES: MovementType[] = [
  MovementType.DEPOSIT,
  MovementType.TRANSFER_IN,
  MovementType.ADJUSTMENT_INCREASE,
  MovementType.TRADE_BUY,
];

/** يحدد ما إذا كان نوع الحركة يزيد رصيد الخزينة أم ينقصه. */
export function isIncreasingMovement(type: MovementType): boolean {
  return INCREASING_TYPES.includes(type);
}
