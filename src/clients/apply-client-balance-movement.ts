import { ClientBalanceMovementType, Prisma } from '@prisma/client';
import { toMoney } from '../common/money';

/** الحد الأدنى من عمليات Prisma التي تحتاجها حركة رصيد عميل — يقبل عميل Prisma العادي أو عميل معاملة (tx). */
export interface ClientBalanceTxClient {
  clientBalance: Pick<Prisma.ClientBalanceDelegate, 'findUnique' | 'upsert'>;
  clientBalanceMovement: Pick<Prisma.ClientBalanceMovementDelegate, 'create'>;
}

export interface ApplyClientBalanceMovementInput {
  clientId: string;
  currencyId: string;
  type: ClientBalanceMovementType;
  amount: Prisma.Decimal.Value;
  reason: string;
  performedById: string;
  treasuryMovementId?: string;
}

const INCREASING_TYPES: ClientBalanceMovementType[] = [
  ClientBalanceMovementType.DEPOSIT,
  ClientBalanceMovementType.ADJUSTMENT_INCREASE,
];

/**
 * القلب المشترك لكل تحديث على رصيد وديعة عميل: يحدّث ClientBalance.balance
 * وينشئ صف ClientBalanceMovement يحمل الرصيد بعده مباشرة — على غرار
 * treasury/apply-movement.ts تمامًا، بفارق جوهري واحد: رصيد العميل هنا
 * **يُسمح له أن يصبح سالبًا عمدًا** (عميل مدين)، فلا يُرفض أي سحب هنا مهما كان
 * الرصيد الحالي؛ يُعرض بالأحمر في الواجهة بدل رفضه، تمامًا كما طلب صاحب النظام.
 */
export async function applyClientBalanceMovement(
  tx: ClientBalanceTxClient,
  input: ApplyClientBalanceMovementInput,
) {
  const existing = await tx.clientBalance.findUnique({
    where: { clientId_currencyId: { clientId: input.clientId, currencyId: input.currencyId } },
  });
  const balanceBefore = existing ? toMoney(existing.balance) : toMoney(0);

  const amount = toMoney(input.amount);
  const increasing = INCREASING_TYPES.includes(input.type);
  const balanceAfter = increasing ? balanceBefore.plus(amount) : balanceBefore.minus(amount);

  await tx.clientBalance.upsert({
    where: { clientId_currencyId: { clientId: input.clientId, currencyId: input.currencyId } },
    create: { clientId: input.clientId, currencyId: input.currencyId, balance: balanceAfter },
    update: { balance: balanceAfter },
  });

  const movement = await tx.clientBalanceMovement.create({
    data: {
      clientId: input.clientId,
      currencyId: input.currencyId,
      type: input.type,
      amount,
      balanceAfter,
      reason: input.reason,
      performedById: input.performedById,
      treasuryMovementId: input.treasuryMovementId,
    },
  });

  return { movement, balanceBefore, balanceAfter };
}
