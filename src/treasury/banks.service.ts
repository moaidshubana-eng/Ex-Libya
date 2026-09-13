import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MovementType, Prisma } from '@prisma/client';
import { ACCOUNT_CODES } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/post-journal-entry';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { applyBankMovement } from './apply-bank-movement';
import { ConfigureBankPositionDto } from './dto/configure-bank-position.dto';
import { CreateBankDto } from './dto/create-bank.dto';
import { RecordBankMovementDto } from './dto/record-bank-movement.dto';
import { isIncreasingMovement } from './movement-direction';

/**
 * الحساب المقابل لكل نوع حركة مصرف — على غرار PLAIN_MOVEMENT_COUNTERPART_ACCOUNT
 * في TreasuryService، لكن DEPOSIT/WITHDRAWAL هنا تمثّل أموالًا خارجية حقيقية
 * (تحويل وارد من طرف خارجي، رسوم بنكية...) لا تمر بخزينة فرع — فطرفها المقابل
 * EXTERNAL_FUNDS_CLEARING لا BANK_CASH (BANK_CASH هو حساب المصرف نفسه الآن،
 * لا يصح أن يكون طرفي القيد معًا). التحويل الوارد/الصادر (TRANSFER_IN/OUT)
 * يمثّل الطرف الآخر لتحويل فعلي من/إلى خزينة فرع، فيستخدم نفس حساب التسوية
 * الداخلية (INTER_BRANCH_CLEARING) الذي يستخدمه الفرع في طرفه من نفس الحركة.
 */
const PLAIN_BANK_MOVEMENT_COUNTERPART_ACCOUNT: Partial<Record<MovementType, string>> = {
  [MovementType.DEPOSIT]: ACCOUNT_CODES.EXTERNAL_FUNDS_CLEARING,
  [MovementType.WITHDRAWAL]: ACCOUNT_CODES.EXTERNAL_FUNDS_CLEARING,
  [MovementType.TRANSFER_IN]: ACCOUNT_CODES.INTER_BRANCH_CLEARING,
  [MovementType.TRANSFER_OUT]: ACCOUNT_CODES.INTER_BRANCH_CLEARING,
  [MovementType.ADJUSTMENT_INCREASE]: ACCOUNT_CODES.CASH_OVER_INCOME,
  [MovementType.ADJUSTMENT_DECREASE]: ACCOUNT_CODES.CASH_SHORT_EXPENSE,
};

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/**
 * وحدة المصارف — حسابات بنكية للشركة مستقلة مركزيًا (غير مرتبطة بفرع)، تُدار
 * بنفس آلية خزينة الفروع تمامًا (TreasuryService): مركز رصيد لكل عملة ودفتر
 * حركات تراكمي. انظر التعليق أعلى نموذج Bank في schema.prisma لتفاصيل التصميم.
 */
@Injectable()
export class BanksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---- المصارف ----

  async createBank(dto: CreateBankDto, actor: AuthenticatedUser) {
    try {
      const bank = await this.prisma.bank.create({ data: dto });
      await this.audit.record({
        entityType: 'Bank',
        entityId: bank.id,
        action: 'CREATE',
        actorId: actor.id,
        after: bank,
      });
      return bank;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new ConflictException('يوجد حساب مصرفي مسجَّل مسبقًا بنفس الرمز');
      }
      throw error;
    }
  }

  listBanks(includeInactive = false) {
    return this.prisma.bank.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  /** تعطيل/إعادة تفعيل حساب مصرفي — بلا حذف فعلي أبدًا؛ نفس منطق setBranchActive بالضبط. */
  async setBankActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const bank = await this.prisma.bank.findUnique({ where: { id } });
    if (!bank) throw new NotFoundException('الحساب المصرفي غير موجود');

    const updated = await this.prisma.bank.update({ where: { id }, data: { isActive } });

    await this.audit.record({
      entityType: 'Bank',
      entityId: id,
      action: isActive ? 'ACTIVATE_BANK' : 'DEACTIVATE_BANK',
      actorId: actor.id,
      before: { isActive: bank.isActive },
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

  private async getBankOrThrow(bankId: string) {
    const bank = await this.prisma.bank.findUnique({ where: { id: bankId } });
    if (!bank) throw new NotFoundException('الحساب المصرفي غير موجود');
    return bank;
  }

  // ---- مراكز المصرف (Positions) ----

  /** يفعّل خط عملة جديد لحساب مصرفي (أو يحدّث سقف تعرّضه) — لا يمس الرصيد الحالي. */
  async configurePosition(bankId: string, dto: ConfigureBankPositionDto, actor: AuthenticatedUser) {
    await this.getBankOrThrow(bankId);
    const currency = await this.getCurrencyOrThrow(dto.currencyCode);

    const existing = await this.prisma.bankPosition.findUnique({
      where: { bankId_currencyId: { bankId, currencyId: currency.id } },
    });

    // حقل فارغ في الطلب يعني إلغاء الحد الحالي صراحةً (null)، لا الإبقاء عليه.
    const maxExposure = dto.maxExposure ?? null;
    const minThreshold = dto.minThreshold ?? null;

    const position = await this.prisma.bankPosition.upsert({
      where: { bankId_currencyId: { bankId, currencyId: currency.id } },
      create: { bankId, currencyId: currency.id, maxExposure, minThreshold },
      update: { maxExposure, minThreshold },
    });

    await this.audit.record({
      entityType: 'BankPosition',
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

  async listPositions(bankId?: string, includeInactiveBanks = false) {
    const positions = await this.prisma.bankPosition.findMany({
      where: {
        ...(bankId && { bankId }),
        ...(!includeInactiveBanks && { bank: { isActive: true } }),
      },
      include: { bank: true, currency: true },
      orderBy: [{ bank: { name: 'asc' } }, { currency: { code: 'asc' } }],
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

  // ---- حركات المصرف (دفتر تراكمي) ----

  async recordMovement(bankId: string, dto: RecordBankMovementDto, actor: AuthenticatedUser) {
    await this.getBankOrThrow(bankId);
    const currency = await this.getCurrencyOrThrow(dto.currencyCode);

    const result = await this.prisma.$transaction(async (tx) => {
      const result = await applyBankMovement(tx, {
        bankId,
        currencyId: currency.id,
        currencyCode: currency.code,
        type: dto.type,
        amount: dto.amount,
        reason: dto.reason,
        performedById: actor.id,
      });

      await this.audit.record({
        entityType: 'BankMovement',
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

      // ترحيل محاسبي للحركة — BANK_CASH يمثّل الآن رصيدًا حقيقيًا (مجموع كل
      // مراكز المصارف)، فالطرف المقابل يعتمد على نوع الحركة (انظر الخريطة أعلاه).
      const counterpartCode = PLAIN_BANK_MOVEMENT_COUNTERPART_ACCOUNT[dto.type];
      const bankCashIncreases = isIncreasingMovement(dto.type);
      if (counterpartCode) {
        await postJournalEntry(tx, {
          description: `حركة مصرف: ${dto.reason}`,
          sourceType: 'BankMovement',
          sourceId: result.movement.id,
          postedById: actor.id,
          lines: [
            {
              accountCode: ACCOUNT_CODES.BANK_CASH,
              ...(bankCashIncreases ? { debit: dto.amount } : { credit: dto.amount }),
              currencyId: currency.id,
            },
            {
              accountCode: counterpartCode,
              ...(bankCashIncreases ? { credit: dto.amount } : { debit: dto.amount }),
              currencyId: currency.id,
            },
          ],
        });
      }

      return {
        ...result.movement,
        exceedsMaxExposure: result.exceedsMaxExposure,
        belowMinThreshold: result.belowMinThreshold,
      };
    });

    return result;
  }

  async listMovements(bankId: string, currencyCode?: string, take = 50) {
    await this.getBankOrThrow(bankId);
    const currency = currencyCode ? await this.getCurrencyOrThrow(currencyCode) : null;

    return this.prisma.bankMovement.findMany({
      where: { bankId, ...(currency && { currencyId: currency.id }) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
      include: {
        currency: true,
        performedBy: { select: { id: true, fullName: true, role: true } },
      },
    });
  }
}
