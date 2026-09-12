import { MovementType } from '@prisma/client';
import { isIncreasingMovement } from './movement-direction';

describe('isIncreasingMovement', () => {
  it.each([
    [MovementType.DEPOSIT, true],
    [MovementType.TRANSFER_IN, true],
    [MovementType.ADJUSTMENT_INCREASE, true],
    [MovementType.TRADE_BUY, true],
    [MovementType.TRADE_SELL_SETTLEMENT, true],
    [MovementType.WITHDRAWAL, false],
    [MovementType.TRANSFER_OUT, false],
    [MovementType.ADJUSTMENT_DECREASE, false],
    [MovementType.TRADE_SELL, false],
    [MovementType.TRADE_BUY_SETTLEMENT, false],
  ])('%s → يزيد الرصيد: %s', (type, expected) => {
    expect(isIncreasingMovement(type)).toBe(expected);
  });
});
