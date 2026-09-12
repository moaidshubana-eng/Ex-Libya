import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientBalanceMovementType, Prisma } from '@prisma/client';
import { ACCOUNT_CODES } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/post-journal-entry';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { applyClientBalanceMovement } from './apply-client-balance-movement';
import { AdjustClientBalanceDto } from './dto/adjust-client-balance.dto';
import { CreateClientDto } from './dto/create-client.dto';
import { ListClientsQuery } from './dto/list-clients.query';
import { UpdateKycDto } from './dto/update-kyc.dto';
import { UpdateLimitsDto } from './dto/update-limits.dto';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateClientDto, actor: AuthenticatedUser) {
    try {
      const client = await this.prisma.client.create({
        data: {
          fullName: dto.fullName,
          clientType: dto.clientType,
          nationalIdOrReg: dto.nationalIdOrReg,
          phone: dto.phone,
          address: dto.address,
          dailyLimitUsd: dto.dailyLimitUsd,
          creditLimitUsd: dto.creditLimitUsd,
          whatsappOptIn: dto.whatsappOptIn ?? false,
        },
      });

      await this.audit.record({
        entityType: 'Client',
        entityId: client.id,
        action: 'CREATE',
        actorId: actor.id,
        after: client,
      });

      return client;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new ConflictException('يوجد عميل مسجّل مسبقًا بنفس الرقم الوطني/السجل أو رقم الهاتف');
      }
      throw error;
    }
  }

  async findAll(query: ListClientsQuery) {
    const where: Prisma.ClientWhereInput = {
      ...(query.riskTier && { riskTier: query.riskTier }),
      ...(query.kycStatus && { kycStatus: query.kycStatus }),
      ...(query.search && {
        OR: [
          { fullName: { contains: query.search, mode: 'insensitive' } },
          { nationalIdOrReg: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.client.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { balances: { include: { currency: true } } },
      }),
      this.prisma.client.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { balances: { include: { currency: true } } },
    });
    if (!client) throw new NotFoundException('العميل غير موجود');
    return client;
  }

  async updateLimits(id: string, dto: UpdateLimitsDto, actor: AuthenticatedUser) {
    const before = await this.findOne(id);

    const after = await this.prisma.client.update({
      where: { id },
      data: { dailyLimitUsd: dto.dailyLimitUsd, creditLimitUsd: dto.creditLimitUsd },
    });

    await this.audit.record({
      entityType: 'Client',
      entityId: id,
      action: 'UPDATE_LIMITS',
      actorId: actor.id,
      before: { dailyLimitUsd: before.dailyLimitUsd, creditLimitUsd: before.creditLimitUsd },
      after: {
        dailyLimitUsd: after.dailyLimitUsd,
        creditLimitUsd: after.creditLimitUsd,
        reason: dto.reason,
      },
    });

    return after;
  }

  async updateKyc(id: string, dto: UpdateKycDto, actor: AuthenticatedUser) {
    const before = await this.findOne(id);

    const after = await this.prisma.client.update({
      where: { id },
      data: { kycStatus: dto.kycStatus, riskTier: dto.riskTier },
    });

    await this.audit.record({
      entityType: 'Client',
      entityId: id,
      action: 'UPDATE_KYC',
      actorId: actor.id,
      before: { kycStatus: before.kycStatus, riskTier: before.riskTier },
      after: { kycStatus: after.kycStatus, riskTier: after.riskTier, reason: dto.reason },
    });

    return after;
  }

  // ---- رصيد وديعة العميل (Custody) ----

  private async getCurrencyOrThrow(currencyCode: string) {
    const currency = await this.prisma.currency.findUnique({
      where: { code: currencyCode.toUpperCase() },
    });
    if (!currency || !currency.isActive) {
      throw new NotFoundException(`العملة ${currencyCode} غير مسجّلة أو غير مفعّلة`);
    }
    return currency;
  }

  /** سجل حركات رصيد العميل (إيداع/سحب/تعديلات) — اختياريًا لعملة واحدة، الأحدث أولًا. */
  async listBalanceMovements(clientId: string, currencyCode?: string, take = 50) {
    await this.findOne(clientId);
    const currency = currencyCode ? await this.getCurrencyOrThrow(currencyCode) : null;

    return this.prisma.clientBalanceMovement.findMany({
      where: { clientId, ...(currency && { currencyId: currency.id }) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
      include: {
        currency: true,
        performedBy: { select: { id: true, fullName: true, role: true } },
      },
    });
  }

  /**
   * تصحيح يدوي لرصيد وديعة عميل — لا علاقة له بخزينة أي فرع (لا يُنشئ أي
   * TreasuryMovement)، ومخصص فقط لتصحيح أخطاء إدخال سابقة أو تسويات إدارية
   * موثّقة بسبب واضح. الإيداع/السحب الفعلي المرتبط بخزينة فرع يمر عبر
   * TreasuryService.recordMovement (حقل clientId) لا من هنا.
   */
  async adjustBalance(clientId: string, dto: AdjustClientBalanceDto, actor: AuthenticatedUser) {
    const client = await this.findOne(clientId);
    if (!client.isActive) throw new ConflictException('العميل معطَّل — لا يمكن تعديل رصيده');
    const currency = await this.getCurrencyOrThrow(dto.currencyCode);

    const isIncrease = dto.direction === 'INCREASE';
    const result = await this.prisma.$transaction(async (tx) => {
      const movementResult = await applyClientBalanceMovement(tx, {
        clientId,
        currencyId: currency.id,
        type: isIncrease
          ? ClientBalanceMovementType.ADJUSTMENT_INCREASE
          : ClientBalanceMovementType.ADJUSTMENT_DECREASE,
        amount: dto.amount,
        reason: dto.reason,
        performedById: actor.id,
      });

      // ترحيل محاسبي: زيادة التزام تجاه عميل بلا صرف نقدي مقابل = خسارة/مصروف على
      // الشركة؛ تخفيض التزام بلا سداد فعلي = مكسب/إيراد آخر — تسويات إدارية لا
      // تمرّ بخزينة أي فرع (خلافًا لحركات الإيداع/السحب المرتبطة بعميل).
      await postJournalEntry(tx, {
        description: `تصحيح يدوي لرصيد وديعة عميل: ${dto.reason}`,
        sourceType: 'ClientBalanceMovement',
        sourceId: movementResult.movement.id,
        postedById: actor.id,
        lines: [
          {
            accountCode: isIncrease
              ? ACCOUNT_CODES.CUSTODY_ADJUSTMENT_EXPENSE
              : ACCOUNT_CODES.CLIENT_CUSTODY_PAYABLE,
            debit: dto.amount,
            currencyId: currency.id,
          },
          {
            accountCode: isIncrease
              ? ACCOUNT_CODES.CLIENT_CUSTODY_PAYABLE
              : ACCOUNT_CODES.CUSTODY_ADJUSTMENT_INCOME,
            credit: dto.amount,
            currencyId: currency.id,
          },
        ],
      });

      return movementResult;
    });

    await this.audit.record({
      entityType: 'ClientBalanceMovement',
      entityId: result.movement.id,
      action: 'ADJUST_CLIENT_BALANCE',
      actorId: actor.id,
      before: { balance: result.balanceBefore.toFixed(2) },
      after: {
        balance: result.balanceAfter.toFixed(2),
        direction: dto.direction,
        amount: dto.amount,
        reason: dto.reason,
      },
    });

    return result.movement;
  }
}
