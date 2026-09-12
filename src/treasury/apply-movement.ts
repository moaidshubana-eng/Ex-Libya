import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MovementType, Prisma } from '@prisma/client';
import { toMoney } from '../common/money';
import { isIncreasingMovement } from './movement-direction';

/** الحد الأدنى من عمليات Prisma التي يحتاجها تطبيق حركة خزينة — يقبل عميل Prisma العادي أو عميل معاملة (tx). */
export interface TreasuryTxClient {
  treasuryPosition: Pick<Prisma.TreasuryPositionDelegate, 'findUnique' | 'update'>;
  treasuryMovement: Pick<Prisma.TreasuryMovementDelegate, 'create'>;
}

export interface ApplyMovementInput {
  branchId: string;
  currencyId: string;
  currencyCode: string;
  type: MovementType;
  amount: Prisma.Decimal.Value;
  reason: string;
  performedById: string;
  dealId?: string;
}

/**
 * القلب المشترك لكل تحديث على رصيد خزينة: يتحقق من كفاية الرصيد، يحدّث
 * TreasuryPosition.balance، وينشئ صف TreasuryMovement يحمل الرصيد بعده مباشرة.
 * يُستدعى من TreasuryService.recordMovement (حركات يدوية) ومن DealsService عند
 * تنفيذ صفقة (TRADE_BUY/TRADE_SELL) — دومًا ضمن معاملة واحدة (tx) تشمل أي
 * تحديثات أخرى مرتبطة (مثل تغيير حالة الصفقة) لضمان الذرّية.
 */
export async function applyMovement(tx: TreasuryTxClient, input: ApplyMovementInput) {
  const position = await tx.treasuryPosition.findUnique({
    where: { branchId_currencyId: { branchId: input.branchId, currencyId: input.currencyId } },
  });
  if (!position) {
    throw new NotFoundException(
      `لم يتم تفعيل عملة ${input.currencyCode} لهذا الفرع بعد — استخدم إعداد مركز الخزينة أولًا`,
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

  await tx.treasuryPosition.update({ where: { id: position.id }, data: { balance: newBalance } });

  const movement = await tx.treasuryMovement.create({
    data: {
      branchId: input.branchId,
      currencyId: input.currencyId,
      type: input.type,
      amount: input.amount,
      balanceAfter: newBalance,
      reason: input.reason,
      performedById: input.performedById,
      dealId: input.dealId,
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
