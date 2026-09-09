import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigurePositionDto } from './dto/configure-position.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { RecordMovementDto } from './dto/record-movement.dto';
import { isIncreasingMovement } from './movement-direction';

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

  listBranches() {
    return this.prisma.branch.findMany({ orderBy: { name: 'asc' } });
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

    const position = await this.prisma.treasuryPosition.upsert({
      where: { branchId_currencyId: { branchId, currencyId: currency.id } },
      create: {
        branchId,
        currencyId: currency.id,
        maxExposure: dto.maxExposure,
        minThreshold: dto.minThreshold,
      },
      update: { maxExposure: dto.maxExposure, minThreshold: dto.minThreshold },
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

  async listPositions(branchId?: string) {
    const positions = await this.prisma.treasuryPosition.findMany({
      where: branchId ? { branchId } : undefined,
      include: { branch: true, currency: true },
      orderBy: [{ branch: { name: 'asc' } }, { currency: { code: 'asc' } }],
    });

    return positions.map((position) => ({
      ...position,
      belowMinThreshold: toMoney(position.balance).lessThan(position.minThreshold),
      aboveMaxExposure: toMoney(position.balance).greaterThan(position.maxExposure),
    }));
  }

  // ---- حركات الخزينة (دفتر تراكمي) ----

  async recordMovement(branchId: string, dto: RecordMovementDto, actor: AuthenticatedUser) {
    await this.getBranchOrThrow(branchId);
    const currency = await this.getCurrencyOrThrow(dto.currencyCode);

    return this.prisma.$transaction(async (tx) => {
      const position = await tx.treasuryPosition.findUnique({
        where: { branchId_currencyId: { branchId, currencyId: currency.id } },
      });
      if (!position) {
        throw new NotFoundException(
          `لم يتم تفعيل عملة ${currency.code} لهذا الفرع بعد — استخدم إعداد مركز الخزينة أولًا`,
        );
      }

      const amount = toMoney(dto.amount);
      const increasing = isIncreasingMovement(dto.type);
      const newBalance = increasing
        ? toMoney(position.balance).plus(amount)
        : toMoney(position.balance).minus(amount);

      if (newBalance.isNegative()) {
        throw new BadRequestException(
          `الرصيد غير كافٍ لإتمام هذه الحركة (الرصيد الحالي: ${toMoney(position.balance).toFixed(2)} ${currency.code})`,
        );
      }

      await tx.treasuryPosition.update({
        where: { id: position.id },
        data: { balance: newBalance },
      });

      const movement = await tx.treasuryMovement.create({
        data: {
          branchId,
          currencyId: currency.id,
          type: dto.type,
          amount: dto.amount,
          balanceAfter: newBalance,
          reason: dto.reason,
          performedById: actor.id,
        },
      });

      await this.audit.record({
        entityType: 'TreasuryMovement',
        entityId: movement.id,
        action: 'RECORD_MOVEMENT',
        actorId: actor.id,
        before: { balance: position.balance },
        after: {
          balance: newBalance.toFixed(2),
          type: dto.type,
          amount: dto.amount,
          reason: dto.reason,
        },
      });

      return {
        ...movement,
        exceedsMaxExposure: newBalance.greaterThan(position.maxExposure),
        belowMinThreshold: newBalance.lessThan(position.minThreshold),
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
