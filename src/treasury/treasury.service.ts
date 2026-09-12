import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClientBalanceMovementType, MovementType, Prisma } from '@prisma/client';
import { ACCOUNT_CODES } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/post-journal-entry';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { applyClientBalanceMovement } from '../clients/apply-client-balance-movement';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { applyMovement } from './apply-movement';
import { ConfigurePositionDto } from './dto/configure-position.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { RecordMovementDto } from './dto/record-movement.dto';

/**
 * الحساب المقابل لكل نوع حركة خزينة عادية (بلا ربط بعميل) واتجاه القيد —
 * TRADE_BUY/TRADE_SELL غير مدرجَين عمدًا: لا يوجد بعد حقل تكلفة/هامش على
 * الصفقة (Transaction) يسمح بترحيل قيد صحيح لتبادل عملة بعملة أخرى (انظر
 * ملاحظة الفجوة في README) — تنفَّذ الحركة على الخزينة كالمعتاد لكن بلا أثر
 * على دفتر الأستاذ حتى يُضاف نموذج هامش الصفقات مستقبلًا.
 */
const PLAIN_MOVEMENT_COUNTERPART_ACCOUNT: Partial<Record<MovementType, string>> = {
  [MovementType.DEPOSIT]: ACCOUNT_CODES.BANK_CASH,
  [MovementType.WITHDRAWAL]: ACCOUNT_CODES.BANK_CASH,
  [MovementType.TRANSFER_IN]: ACCOUNT_CODES.INTER_BRANCH_CLEARING,
  [MovementType.TRANSFER_OUT]: ACCOUNT_CODES.INTER_BRANCH_CLEARING,
  [MovementType.ADJUSTMENT_INCREASE]: ACCOUNT_CODES.CASH_OVER_INCOME,
  [MovementType.ADJUSTMENT_DECREASE]: ACCOUNT_CODES.CASH_SHORT_EXPENSE,
};

/** هل الحركة تزيد النقدية في خزينة الفرع (till) أم تنقصها؟ يحدّد أي طرف من القيد يأخذ التيل كاش. */
const INCREASES_TILL_CASH: Partial<Record<MovementType, boolean>> = {
  [MovementType.DEPOSIT]: true,
  [MovementType.WITHDRAWAL]: false,
  [MovementType.TRANSFER_IN]: true,
  [MovementType.TRANSFER_OUT]: false,
  [MovementType.ADJUSTMENT_INCREASE]: true,
  [MovementType.ADJUSTMENT_DECREASE]: false,
};

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class TreasuryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- الفروع ----

  async createBranch(dto: CreateBranchDto, actor: AuthenticatedUser) {
    try {
      const branch = await this.prisma.branch.create({ data: dto });
      await this.audit.record({
        entityType: 'Branch',
        entityId: branch.id,
        action: 'CREATE',
        actorId: actor.id,
        after: branch,
      });
      return branch;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new ConflictException('يوجد فرع مسجّل مسبقًا بنفس الرمز');
      }
      throw error;
    }
  }

  listBranches(includeInactive = false) {
    return this.prisma.branch.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * تعطيل/إعادة تفعيل فرع — لا حذف فعلي أبدًا: الفرع قد يحمل حركات خزينة
   * وصفقات وموظفين تاريخيين حقيقيين (onDelete: Restrict يمنع حذفه أصلًا لو
   * كانت له أي حركة). التعطيل يخفيه من كل قوائم الاختيار التشغيلية (صفقة
   * جديدة، حركة خزينة، مصروف...) دون فقدان أي سجل تاريخي مرتبط به.
   */
  async setBranchActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');

    const updated = await this.prisma.branch.update({ where: { id }, data: { isActive } });

    await this.audit.record({
      entityType: 'Branch',
      entityId: id,
      action: isActive ? 'ACTIVATE_BRANCH' : 'DEACTIVATE_BRANCH',
      actorId: actor.id,
      before: { isActive: branch.isActive },
      after: { isActive: updated.isActive },
    });

    return updated;
  }

  private async getCurrencyOrThrow(currencyCode: string) {
    const currency = await this.prisma.currency.findUnique({
      where: { code: currencyCode.toUpperCase() },
    });
    if (!currency || !currency.isActive) {
      throw new NotFoundException(`العملة ${currencyCode} غير مسجّلة أو غير مفعّلة`);
    }
    return currency;
  }

  private async getBranchOrThrow(branchId: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    return branch;
  }

  // ---- مراكز الخزينة (Positions) ----

  /** يفعّل خط عملة جديد لفرع (أو يحدّث سقف تعرّضه) — لا يمس الرصيد الحالي. */
  async configurePosition(branchId: string, dto: ConfigurePositionDto, actor: AuthenticatedUser) {
    await this.getBranchOrThrow(branchId);
    const currency = await this.getCurrencyOrThrow(dto.currencyCode);

    const existing = await this.prisma.treasuryPosition.findUnique({
      where: { branchId_currencyId: { branchId, currencyId: currency.id } },
    });

    // حقل فارغ في الطلب يعني إلغاء الحد الحالي صراحةً (null)، لا الإبقاء عليه —
    // فعدم إرسال القيمة يُترجَم صراحةً إلى إزالة الحد لا تجاهل التعديل.
    const maxExposure = dto.maxExposure ?? null;
    const minThreshold = dto.minThreshold ?? null;

    const position = await this.prisma.treasuryPosition.upsert({
      where: { branchId_currencyId: { branchId, currencyId: currency.id } },
      create: { branchId, currencyId: currency.id, maxExposure, minThreshold },
      update: { maxExposure, minThreshold },
    });

    await this.audit.record({
      entityType: 'TreasuryPosition',
      entityId: position.id,
      action: existing ? 'UPDATE_POSITION_LIMITS' : 'CREATE_POSITION',
      actorId: actor.id,
      before: existing
        ? { maxExposure: existing.maxExposure, minThreshold: existing.minThreshold }
        : null,
      after: { maxExposure: position.maxExposure, minThreshold: position.minThreshold },
    });

    return position;
  }

  async listPositions(branchId?: string, includeInactiveBranches = false) {
    const positions = await this.prisma.treasuryPosition.findMany({
      where: {
        ...(branchId && { branchId }),
        ...(!includeInactiveBranches && { branch: { isActive: true } }),
      },
      include: { branch: true, currency: true },
      orderBy: [{ branch: { name: 'asc' } }, { currency: { code: 'asc' } }],
    });

    return positions.map((position) => ({
      ...position,
      belowMinThreshold:
        position.minThreshold !== null && toMoney(position.balance).lessThan(position.minThreshold),
      aboveMaxExposure:
        position.maxExposure !== null &&
        toMoney(position.balance).greaterThan(position.maxExposure),
    }));
  }

  // ---- حركات الخزينة (دفتر تراكمي) ----

  async recordMovement(branchId: string, dto: RecordMovementDto, actor: AuthenticatedUser) {
    await this.getBranchOrThrow(branchId);
    const currency = await this.getCurrencyOrThrow(dto.currencyCode);

    // ربط اختياري برصيد وديعة عميل — لا يُقبل إلا مع إيداع/سحب فعلي نقدي حقيقي؛
    // باقي الأنواع (تحويل بين فروع، تسوية جرد، ناتج صفقة) لا معنى لربطها بعميل هنا.
    let client: { id: string; fullName: string; isActive: boolean } | null = null;
    if (dto.clientId) {
      if (dto.type !== MovementType.DEPOSIT && dto.type !== MovementType.WITHDRAWAL) {
        throw new BadRequestException(
          'ربط الحركة برصيد عميل غير مسموح إلا مع نوع DEPOSIT أو WITHDRAWAL',
        );
      }
      client = await this.prisma.client.findUnique({
        where: { id: dto.clientId },
        select: { id: true, fullName: true, isActive: true },
      });
      if (!client) throw new NotFoundException('العميل غير موجود');
      if (!client.isActive)
        throw new BadRequestException('العميل معطَّل — لا يمكن تسجيل حركة على رصيده');
    }

    return this.prisma.$transaction(async (tx) => {
      const result = await applyMovement(tx, {
        branchId,
        currencyId: currency.id,
        currencyCode: currency.code,
        type: dto.type,
        amount: dto.amount,
        reason: dto.reason,
        performedById: actor.id,
      });

      await this.audit.record({
        entityType: 'TreasuryMovement',
        entityId: result.movement.id,
        action: 'RECORD_MOVEMENT',
        actorId: actor.id,
        before: { balance: result.balanceBefore },
        after: {
          balance: result.balanceAfter.toFixed(2),
          type: dto.type,
          amount: dto.amount,
          reason: dto.reason,
        },
      });

      // ترحيل محاسبي للحركة على الخزينة نفسها. مرتبطة بعميل (DEPOSIT/WITHDRAWAL
      // فقط، مضمونة سلفًا بالتحقق أعلاه): الطرف الآخر وديعة العميل المستحقة، لا
      // البنك — فهذا نقل مسؤولية بين الشركة وعميل بعينه، لا تغذية فعلية من حساب
      // مصرفي. حركة عادية بلا عميل: الطرف الآخر يعتمد على النوع (انظر الخريطة أعلاه).
      if (client) {
        const isDeposit = dto.type === MovementType.DEPOSIT;
        await postJournalEntry(tx, {
          description: `حركة خزينة مرتبطة برصيد عميل: ${dto.reason}`,
          sourceType: 'TreasuryMovement',
          sourceId: result.movement.id,
          postedById: actor.id,
          lines: [
            {
              accountCode: ACCOUNT_CODES.TILL_CASH,
              ...(isDeposit ? { debit: dto.amount } : { credit: dto.amount }),
              currencyId: currency.id,
              branchId,
            },
            {
              accountCode: ACCOUNT_CODES.CLIENT_CUSTODY_PAYABLE,
              ...(isDeposit ? { credit: dto.amount } : { debit: dto.amount }),
              currencyId: currency.id,
              branchId,
            },
          ],
        });
      } else {
        const counterpartCode = PLAIN_MOVEMENT_COUNTERPART_ACCOUNT[dto.type];
        const tillIncreases = INCREASES_TILL_CASH[dto.type];
        if (counterpartCode && tillIncreases !== undefined) {
          await postJournalEntry(tx, {
            description: `حركة خزينة: ${dto.reason}`,
            sourceType: 'TreasuryMovement',
            sourceId: result.movement.id,
            postedById: actor.id,
            lines: [
              {
                accountCode: ACCOUNT_CODES.TILL_CASH,
                ...(tillIncreases ? { debit: dto.amount } : { credit: dto.amount }),
                currencyId: currency.id,
                branchId,
              },
              {
                accountCode: counterpartCode,
                ...(tillIncreases ? { credit: dto.amount } : { debit: dto.amount }),
                currencyId: currency.id,
                branchId,
              },
            ],
          });
        }
      }

      let clientBalanceMovement = null;
      if (client) {
        const clientResult = await applyClientBalanceMovement(tx, {
          clientId: client.id,
          currencyId: currency.id,
          type:
            dto.type === MovementType.DEPOSIT
              ? ClientBalanceMovementType.DEPOSIT
              : ClientBalanceMovementType.WITHDRAWAL,
          amount: dto.amount,
          reason: dto.reason,
          performedById: actor.id,
          treasuryMovementId: result.movement.id,
        });

        await this.audit.record({
          entityType: 'ClientBalanceMovement',
          entityId: clientResult.movement.id,
          action: 'RECORD_MOVEMENT',
          actorId: actor.id,
          before: { balance: clientResult.balanceBefore.toFixed(2) },
          after: {
            balance: clientResult.balanceAfter.toFixed(2),
            type: clientResult.movement.type,
            amount: dto.amount,
            clientId: client.id,
            treasuryMovementId: result.movement.id,
          },
        });

        clientBalanceMovement = {
          ...clientResult.movement,
          clientFullName: client.fullName,
        };
      }

      return {
        ...result.movement,
        exceedsMaxExposure: result.exceedsMaxExposure,
        belowMinThreshold: result.belowMinThreshold,
        clientBalanceMovement,
      };
    });
  }

  async listMovements(branchId: string, currencyCode?: string, take = 50) {
    await this.getBranchOrThrow(branchId);
    const currency = currencyCode ? await this.getCurrencyOrThrow(currencyCode) : null;

    return this.prisma.treasuryMovement.findMany({
      where: { branchId, ...(currency && { currencyId: currency.id }) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
      include: {
        currency: true,
        performedBy: { select: { id: true, fullName: true, role: true } },
      },
    });
  }
}
