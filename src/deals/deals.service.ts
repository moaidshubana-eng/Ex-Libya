import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DealDirection, DealStatus, Prisma } from '@prisma/client';
import { ACCOUNT_CODES } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/post-journal-entry';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { applyMovement } from '../treasury/apply-movement';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { ListDealsQuery } from './dto/list-deals.query';
import { RejectDealDto } from './dto/reject-deal.dto';
import {
  computeDealProfitLyd,
  computeUsdEquivalent,
  movementTypeForDirection,
  settlementMovementTypeForDirection,
} from './deal-pricing';

const DEAL_INCLUDE = {
  client: { select: { id: true, fullName: true, phone: true, riskTier: true, kycStatus: true } },
  branch: { select: { id: true, code: true, name: true } },
  currency: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, fullName: true, role: true } },
  approvedBy: { select: { id: true, fullName: true, role: true } },
  executedBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.TransactionInclude;

@Injectable()
export class DealsService {
  private readonly lockTtlSeconds = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly whatsApp: WhatsAppService,
  ) {}

  // ---- إنشاء صفقة (تسعير + قفل سعر + احتساب هامش الربح/الخسارة) ----
  // لا فحص حدود عميل ولا موافقة مزدوجة قائمة على حد عام — أُلغيت الخاصيتان
  // صراحةً؛ كل صفقة صحيحة البيانات تُنشأ معتمدة (APPROVED) مباشرة.

  async create(dto: CreateDealDto, actor: AuthenticatedUser) {
    const branchId = actor.branchId ?? dto.branchId;
    if (!branchId) {
      throw new BadRequestException('يجب تحديد الفرع — المستخدم الحالي غير مرتبط بفرع ثابت');
    }

    const [client, currency, latestRate] = await Promise.all([
      this.prisma.client.findUnique({ where: { id: dto.clientId } }),
      this.prisma.currency.findUnique({ where: { code: dto.currencyCode.toUpperCase() } }),
      this.prisma.exchangeRate.findFirst({
        where: { currency: { code: dto.currencyCode.toUpperCase() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (!client || !client.isActive) throw new NotFoundException('العميل غير موجود أو غير مفعّل');
    if (!currency || !currency.isActive) {
      throw new NotFoundException(`العملة ${dto.currencyCode} غير مسجّلة أو غير مفعّلة`);
    }
    if (currency.code === 'LYD') {
      throw new BadRequestException('الدينار الليبي هو عملة الأساس ولا يمكن أن يكون محل صفقة صرف');
    }
    if (!latestRate) {
      throw new BadRequestException(`لا يوجد سعر صرف منشور لعملة ${currency.code} بعد`);
    }
    if (client.kycStatus !== 'VERIFIED') {
      throw new BadRequestException(
        'لا يمكن تنفيذ صفقة لعميل لم تكتمل مراجعة التحقق (KYC) الخاصة به',
      );
    }

    const lockedRate = toMoney(latestRate.rate);
    const lydEquivalent = toMoney(dto.amount).times(lockedRate);

    const usdRate =
      currency.code === 'USD'
        ? latestRate
        : await this.prisma.exchangeRate.findFirst({
            where: { currency: { code: 'USD' } },
            orderBy: { createdAt: 'desc' },
          });

    const amountUsdEquivalent = computeUsdEquivalent({
      currencyCode: currency.code,
      amount: toMoney(dto.amount),
      lydEquivalent,
      usdRate: usdRate?.rate ?? null,
    });

    const profitLyd = computeDealProfitLyd({
      direction: dto.direction,
      amount: dto.amount,
      lockedRate,
      parallelMarketRate: dto.parallelMarketRate,
    });

    const lockExpiresAt = new Date(Date.now() + this.lockTtlSeconds * 1000);

    const deal = await this.prisma.transaction.create({
      data: {
        clientId: client.id,
        branchId,
        currencyId: currency.id,
        direction: dto.direction,
        amount: dto.amount,
        lockedRate,
        lydEquivalent,
        amountUsdEquivalent,
        parallelMarketRate: dto.parallelMarketRate,
        profitLyd,
        sourceRateId: latestRate.id,
        status: DealStatus.APPROVED,
        lockExpiresAt,
        requestedById: actor.id,
      },
      include: DEAL_INCLUDE,
    });

    await this.audit.record({
      entityType: 'Transaction',
      entityId: deal.id,
      action: 'CREATE_DEAL',
      actorId: actor.id,
      after: {
        clientId: deal.clientId,
        direction: deal.direction,
        currency: currency.code,
        amount: deal.amount,
        lockedRate: deal.lockedRate,
        parallelMarketRate: deal.parallelMarketRate,
        profitLyd: deal.profitLyd,
        amountUsdEquivalent: deal.amountUsdEquivalent,
        status: deal.status,
      },
    });

    return deal;
  }

  // ---- الاستعلام ----

  async findAll(query: ListDealsQuery) {
    const where: Prisma.TransactionWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(query.branchId && { branchId: query.branchId }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
        include: DEAL_INCLUDE,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string) {
    const deal = await this.prisma.transaction.findUnique({ where: { id }, include: DEAL_INCLUDE });
    if (!deal) throw new NotFoundException('الصفقة غير موجودة');
    return deal;
  }

  /** يعلّم الصفقة كمنتهية المهلة إن تجاوزت lockExpiresAt وكانت ما تزال في حالة قابلة لذلك. */
  private async expireIfLockPassed(dealId: string) {
    const updated = await this.prisma.transaction.updateMany({
      where: {
        id: dealId,
        status: { in: [DealStatus.PENDING_APPROVAL, DealStatus.APPROVED] },
        lockExpiresAt: { lt: new Date() },
      },
      data: { status: DealStatus.EXPIRED },
    });
    return updated.count > 0;
  }

  // ---- الموافقة المزدوجة (Maker-Checker) ----

  async approve(id: string, actor: AuthenticatedUser) {
    if (await this.expireIfLockPassed(id)) {
      throw new BadRequestException(
        'انتهت مهلة قفل السعر لهذه الصفقة — يلزم إنشاء صفقة جديدة بسعر محدَّث',
      );
    }

    const deal = await this.findOne(id);
    if (deal.status !== DealStatus.PENDING_APPROVAL) {
      throw new ConflictException('هذه الصفقة ليست بانتظار موافقة');
    }
    if (deal.requestedById === actor.id) {
      throw new ForbiddenException('لا يجوز أن يكون معتمد الصفقة هو نفسه مَن أنشأها (ضابط مزدوج)');
    }

    const updated = await this.prisma.transaction.updateMany({
      where: { id, status: DealStatus.PENDING_APPROVAL },
      data: { status: DealStatus.APPROVED, approvedById: actor.id },
    });
    if (updated.count === 0) {
      throw new ConflictException('تغيّرت حالة الصفقة قبل تسجيل الموافقة — يرجى إعادة المحاولة');
    }

    await this.audit.record({
      entityType: 'Transaction',
      entityId: id,
      action: 'APPROVE_DEAL',
      actorId: actor.id,
      before: { status: DealStatus.PENDING_APPROVAL },
      after: { status: DealStatus.APPROVED },
    });

    return this.findOne(id);
  }

  async reject(id: string, dto: RejectDealDto, actor: AuthenticatedUser) {
    const deal = await this.findOne(id);
    if (deal.status !== DealStatus.PENDING_APPROVAL) {
      throw new ConflictException('لا يمكن رفض صفقة ليست بانتظار موافقة');
    }
    if (deal.requestedById === actor.id) {
      throw new ForbiddenException('لا يجوز أن يكون معتمد الصفقة هو نفسه مَن أنشأها (ضابط مزدوج)');
    }

    const updated = await this.prisma.transaction.updateMany({
      where: { id, status: DealStatus.PENDING_APPROVAL },
      data: { status: DealStatus.REJECTED, approvedById: actor.id, rejectedReason: dto.reason },
    });
    if (updated.count === 0) {
      throw new ConflictException('تغيّرت حالة الصفقة قبل تسجيل الرفض — يرجى إعادة المحاولة');
    }

    await this.audit.record({
      entityType: 'Transaction',
      entityId: id,
      action: 'REJECT_DEAL',
      actorId: actor.id,
      before: { status: DealStatus.PENDING_APPROVAL },
      after: { status: DealStatus.REJECTED, reason: dto.reason },
    });

    return this.findOne(id);
  }

  // ---- التنفيذ والتسوية ----

  async execute(id: string, actor: AuthenticatedUser) {
    if (await this.expireIfLockPassed(id)) {
      throw new BadRequestException(
        'انتهت مهلة قفل السعر لهذه الصفقة — يلزم إنشاء صفقة جديدة بسعر محدَّث',
      );
    }

    const deal = await this.findOne(id);
    if (deal.status !== DealStatus.APPROVED) {
      throw new ConflictException('لا يمكن تنفيذ صفقة ليست في حالة معتمدة');
    }

    // كل صفقة تحتاج عملة الدينار الليبي نفسها بصرف النظر عن عملتها الأجنبية
    // (deal.currencyId) — لتسوية الطرف المقابل نقدًا (lydEquivalent) وترحيل
    // هامش الصفقة (profitLyd) محاسبيًا، كلاهما بالدينار دومًا.
    const lydCurrency = await this.prisma.currency.findUnique({ where: { code: 'LYD' } });
    if (!lydCurrency) {
      throw new BadRequestException(
        'عملة الدينار الليبي غير مسجَّلة في النظام — تعذّر تسوية الصفقة',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // تحديث شرطي (optimistic) يمنع تنفيذ الصفقة مرتين في حال تزامن الطلبات
      const claimed = await tx.transaction.updateMany({
        where: { id, status: DealStatus.APPROVED },
        data: { status: DealStatus.EXECUTED, executedById: actor.id, executedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new ConflictException('تغيّرت حالة الصفقة قبل التنفيذ — يرجى إعادة المحاولة');
      }

      const dealDirection = deal.direction as DealDirection;
      const reason = `تنفيذ صفقة #${deal.id.slice(0, 8)} — ${dealDirection === DealDirection.BUY ? 'شراء من' : 'بيع لـ'} ${deal.client.fullName}`;

      // طرف العملة الأجنبية: الكمية المتداولة نفسها (deal.amount).
      const fxResult = await applyMovement(tx, {
        branchId: deal.branchId,
        currencyId: deal.currencyId,
        currencyCode: deal.currency.code,
        type: movementTypeForDirection(dealDirection),
        amount: deal.amount,
        reason,
        performedById: actor.id,
        dealId: deal.id,
      });

      // الطرف المقابل بالدينار الليبي: التسوية النقدية الفعلية مع العميل بسعر
      // الصفقة المقفل (lydEquivalent = amount × lockedRate) — شراء عملة من
      // عميل يعني دفع هذا المبلغ له نقدًا (نقصان خزينة الدينار)، وبيعها له يعني
      // تحصيله منه (زيادتها). بلا هذه الحركة يبقى رصيد خزينة الدينار غير متأثر
      // إطلاقًا بأي صفقة صرف، رغم أن نقدًا حقيقيًا يتغيّر يدًا بيد مع كل صفقة.
      const lydResult = await applyMovement(tx, {
        branchId: deal.branchId,
        currencyId: lydCurrency.id,
        currencyCode: lydCurrency.code,
        type: settlementMovementTypeForDirection(dealDirection),
        amount: deal.lydEquivalent,
        reason: `تسوية دينار — ${reason}`,
        performedById: actor.id,
        dealId: deal.id,
      });

      // ترحيل محاسبي لهامش الصفقة فقط (لا لكامل قيمتها — تبادل العملتين نفسه
      // ليس له تمثيل في دفتر الأستاذ حاليًا، انظر ملاحظة الفجوة في README) —
      // عند التنفيذ الفعلي لا عند مجرد الإنشاء، فصفقة أُلغيت أو انتهت مهلتها لا
      // تمسّ قائمة الدخل إطلاقًا. قيد بسيط بسطرين بالدينار: ربح ← مدين ذمم
      // الهامش / دائن الإيراد، وخسارة تُبادل الجانبين تلقائيًا (postJournalEntry
      // يرفض أي سطر صفري القيمتين).
      const profitLyd = toMoney(deal.profitLyd);
      if (!profitLyd.isZero()) {
        const isGain = profitLyd.isPositive();
        await postJournalEntry(tx, {
          description: `هامش صفقة #${deal.id.slice(0, 8)} — ${dealDirection === DealDirection.BUY ? 'شراء من' : 'بيع لـ'} ${deal.client.fullName} (${deal.currency.code})`,
          sourceType: 'Transaction',
          sourceId: deal.id,
          postedById: actor.id,
          lines: [
            {
              accountCode: ACCOUNT_CODES.FX_TRADING_MARGIN_RECEIVABLE,
              ...(isGain ? { debit: profitLyd } : { credit: profitLyd.abs() }),
              currencyId: lydCurrency.id,
            },
            {
              accountCode: ACCOUNT_CODES.FX_TRADING_REVENUE,
              ...(isGain ? { credit: profitLyd } : { debit: profitLyd.abs() }),
              currencyId: lydCurrency.id,
            },
          ],
        });
      }

      return { fx: fxResult, lyd: lydResult };
    });

    await this.audit.record({
      entityType: 'Transaction',
      entityId: id,
      action: 'EXECUTE_DEAL',
      actorId: actor.id,
      before: { status: DealStatus.APPROVED },
      after: {
        status: DealStatus.EXECUTED,
        fx: {
          currency: deal.currency.code,
          balanceBefore: result.fx.balanceBefore,
          balanceAfter: result.fx.balanceAfter.toFixed(2),
          exceedsMaxExposure: result.fx.exceedsMaxExposure,
        },
        lyd: {
          balanceBefore: result.lyd.balanceBefore,
          balanceAfter: result.lyd.balanceAfter.toFixed(2),
          belowMinThreshold: result.lyd.belowMinThreshold,
        },
        profitLyd: deal.profitLyd.toString(),
      },
    });

    const executedDeal = await this.findOne(id);
    await this.whatsApp.sendDealConfirmation({
      id: executedDeal.id,
      direction: executedDeal.direction as DealDirection,
      amount: executedDeal.amount.toString(),
      lockedRate: executedDeal.lockedRate.toString(),
      currency: { code: executedDeal.currency.code },
      client: executedDeal.client,
    });

    return {
      ...executedDeal,
      treasuryMovement: result.fx.movement,
      lydSettlementMovement: result.lyd.movement,
    };
  }

  async cancel(id: string, actor: AuthenticatedUser) {
    const deal = await this.findOne(id);
    const cancellableStatuses: DealStatus[] = [DealStatus.PENDING_APPROVAL, DealStatus.APPROVED];
    if (!cancellableStatuses.includes(deal.status)) {
      throw new ConflictException('لا يمكن إلغاء صفقة في هذه الحالة');
    }
    if (deal.requestedById !== actor.id) {
      throw new ForbiddenException('لا يجوز إلغاء صفقة أنشأها موظف آخر');
    }

    const updated = await this.prisma.transaction.updateMany({
      where: { id, status: { in: [DealStatus.PENDING_APPROVAL, DealStatus.APPROVED] } },
      data: { status: DealStatus.CANCELLED },
    });
    if (updated.count === 0) {
      throw new ConflictException('تغيّرت حالة الصفقة قبل الإلغاء — يرجى إعادة المحاولة');
    }

    await this.audit.record({
      entityType: 'Transaction',
      entityId: id,
      action: 'CANCEL_DEAL',
      actorId: actor.id,
      before: { status: deal.status },
      after: { status: DealStatus.CANCELLED },
    });

    return this.findOne(id);
  }
}
