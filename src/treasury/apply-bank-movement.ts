import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MovementType, Prisma } from '@prisma/client';
import { toMoney } from '../common/money';
import { isIncreasingMovement } from './movement-direction';

/** الحد الأدنى من عمليات Prisma التي يحتاجها تطبيق حركة مصرف — يقبل عميل Prisma العادي أو عميل معاملة (tx). */
export interface BankTxClient {
  bankPosition: Pick<Prisma.BankPositionDelegate, 'findUnique' | 'update'>;
  bankMovement: Pick<Prisma.BankMovementDelegate, 'create'>;
}

export interface ApplyBankMovementInput {
  bankId: string;
  currencyId: string;
  currencyCode: string;
  type: MovementType;
  amount: Prisma.Decimal.Value;
  reason: string;
  performedById: string;
}

/**
 * القلب المشترك لكل تحديث على رصيد مصرف — نسخة مطابقة تمامًا لـ applyMovement
 * (خزينة الفروع) لكن على BankPosition/BankMovement بدل TreasuryPosition/
 * TreasuryMovement؛ نفس منطق التحقق من كفاية الرصيد وتسجيل الحركة بالرصيد
 * بعدها مباشرة. يُستدعى من BanksService.recordMovement ضمن معاملة واحدة (tx).
 */
export async function applyBankMovement(tx: BankTxClient, input: ApplyBankMovementInput) {
  const position = await tx.bankPosition.findUnique({
    where: { bankId_currencyId: { bankId: input.bankId, currencyId: input.currencyId } },
  });
  if (!position) {
    throw new NotFoundException(
      `لم يتم تفعيل عملة ${input.currencyCode} لهذا المصرف بعد — استخدم إعداد مركز المصرف أولًا`,
    );
  }

  const amount = toMoney(input.amount);
  const increasing = isIncreasingMovement(input.type);
  const newBalance = increasing
    ? toMoney(position.balance).plus(amount)
    : toMoney(position.balance).minus(amount);

  if (newBalance.isNegative()) {
    throw new BadRequestException(
      `الرصيد غير كافٍ لإتمام هذه الحركة (الرصيد الحالي: ${toMoney(position.balance).toFixed(2)} ${input.currencyCode})`,
    );
  }

  await tx.bankPosition.update({ where: { id: position.id }, data: { balance: newBalance } });

  const movement = await tx.bankMovement.create({
    data: {
      bankId: input.bankId,
      currencyId: input.currencyId,
      type: input.type,
      amount: input.amount,
      balanceAfter: newBalance,
      reason: input.reason,
      performedById: input.performedById,
    },
  });

  return {
    movement,
    balanceBefore: position.balance,
    balanceAfter: newBalance,
    exceedsMaxExposure:
      position.maxExposure !== null && newBalance.greaterThan(position.maxExposure),
    belowMinThreshold: position.minThreshold !== null && newBalance.lessThan(position.minThreshold),
  };
}
