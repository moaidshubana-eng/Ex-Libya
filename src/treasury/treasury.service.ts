import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { applyMovement } from './apply-movement';
import { ConfigurePositionDto } from './dto/configure-position.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { RecordMovementDto } from './dto/record-movement.dto';

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

      return {
        ...result.movement,
        exceedsMaxExposure: result.exceedsMaxExposure,
        belowMinThreshold: result.belowMinThreshold,
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
