import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RemittanceCustomerType, RemittanceStatus } from '@prisma/client';
import { ACCOUNT_CODES } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/post-journal-entry';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { ReportPeriodQuery } from '../reports/dto/report-period.query';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRemittanceDto } from './dto/create-remittance.dto';
import { ListRemittancesQuery } from './dto/list-remittances.query';
import { RejectRemittanceDto } from './dto/reject-remittance.dto';

/**
 * سطور القيد المحاسبي لهامش حوالة — يُبنى فقط عند السحب الفعلي (WITHDRAWN)،
 * لا عند مجرد التسجيل (PENDING). الهامش الأساسي بالدولار: ذمم الهامش تتحرك
 * بصافي الربح (مدينة إن كان موجبًا، دائنة إن كان خسارة)، مقابل سعر الاستلام
 * في تركيا كإيراد كامل وسعر التسليم في ليبيا كتكلفة كاملة — يعرض الإيراد
 * والتكلفة منفصلين في قائمة الدخل بدل صافي واحد فقط، ويظل متوازنًا حسابيًا
 * في كل الحالات (انظر post-journal-entry.ts). بدل تركيا (إن وُجد) سطران
 * إضافيان بالدينار الليبي ضمن القيد نفسه — عملة مستقلة تمامًا، تُوازَن على
 * حدة (postJournalEntry يتحقق من توازن كل عملة بمعزل عن الأخرى).
 */
function remittanceLedgerLines(params: {
  profit: Prisma.Decimal;
  turkeyReceiptAmount: Prisma.Decimal.Value;
  libyaDeliveryAmount: Prisma.Decimal.Value;
  currencyId: string;
  turkeyAllowanceLyd?: Prisma.Decimal.Value | null;
  lydCurrencyId?: string;
  branchId?: string | null;
}) {
  const profitIsGain = !params.profit.isNegative();
  const lines = [
    {
      accountCode: ACCOUNT_CODES.REMITTANCE_RECEIVABLE,
      ...(profitIsGain ? { debit: params.profit } : { credit: params.profit.abs() }),
      currencyId: params.currencyId,
      branchId: params.branchId,
    },
    {
      accountCode: ACCOUNT_CODES.REMITTANCE_MARGIN_REVENUE,
      credit: params.turkeyReceiptAmount,
      currencyId: params.currencyId,
      branchId: params.branchId,
    },
    {
      accountCode: ACCOUNT_CODES.REMITTANCE_NETWORK_COST,
      debit: params.libyaDeliveryAmount,
      currencyId: params.currencyId,
      branchId: params.branchId,
    },
  ];

  const allowance = params.turkeyAllowanceLyd ? toMoney(params.turkeyAllowanceLyd) : null;
  if (allowance && !allowance.isZero() && params.lydCurrencyId) {
    lines.push(
      {
        accountCode: ACCOUNT_CODES.REMITTANCE_RECEIVABLE,
        debit: allowance,
        currencyId: params.lydCurrencyId,
        branchId: params.branchId,
      },
      {
        accountCode: ACCOUNT_CODES.REMITTANCE_MARGIN_REVENUE,
        credit: allowance,
        currencyId: params.lydCurrencyId,
        branchId: params.branchId,
      },
    );
  }

  return lines;
}

const REMITTANCE_INCLUDE = {
  client: { select: { id: true, fullName: true, phone: true } },
  currency: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  recordedBy: { select: { id: true, fullName: true, role: true } },
  statusChangedBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.RemittanceInclude;

// وحدة حوالات تركيا↔ليبيا (عبر شبكة وسترن يونيون/موني جرام كوكيل) — تدفق
// ثابت واحد: استلام في تركيا ثم تسليم في ليبيا. مستقلة تمامًا عن حسابات
// وديعة العملاء وحركات خزينة الفروع؛ الربح (turkeyReceiptAmount -
// libyaDeliveryAmount) يُحسب ويُخزَّن لحظة التسجيل (PENDING)، لكن لا يُرحَّل
// محاسبيًا إلا عند السحب الفعلي (WITHDRAWN) — انظر تعليق schema.prisma.
@Injectable()
export class RemittancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async getUsdCurrencyOrThrow() {
    const currency = await this.prisma.currency.findUnique({ where: { code: 'USD' } });
    if (!currency || !currency.isActive) {
      throw new BadRequestException('عملة الدولار الأمريكي غير مسجّلة أو غير مفعّلة في النظام');
    }
    return currency;
  }

  async create(dto: CreateRemittanceDto, actor: AuthenticatedUser) {
    // تصنيف العميل: عميل داخلي يتطلب clientId وحده، وزبون خارجي يتطلب اسمًا يدويًا
    // وحده — لا يُقبل مزج الاثنين أو تركهما فارغين، لضمان وضوح من هو الطرف المتعامل.
    if (dto.customerType === RemittanceCustomerType.INTERNAL) {
      if (!dto.clientId) {
        throw new BadRequestException('عميل داخلي يتطلب تحديد clientId');
      }
      if (dto.externalCustomerName) {
        throw new BadRequestException('لا يُقبل اسم زبون خارجي مع عميل داخلي (clientId)');
      }
      const client = await this.prisma.client.findUnique({ where: { id: dto.clientId } });
      if (!client) throw new NotFoundException('العميل غير موجود');
      if (!client.isActive) throw new BadRequestException('العميل معطَّل — لا يمكن تسجيل حوالة له');
    } else {
      if (!dto.externalCustomerName) {
        throw new BadRequestException('زبون خارجي يتطلب تحديد externalCustomerName');
      }
      if (dto.clientId) {
        throw new BadRequestException('لا يُقبل clientId مع زبون خارجي (customerType = EXTERNAL)');
      }
    }

    if (dto.branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
      if (!branch) throw new NotFoundException('الفرع غير موجود');
    }

    const currency = await this.getUsdCurrencyOrThrow();
    const profit = toMoney(dto.turkeyReceiptAmount).minus(toMoney(dto.libyaDeliveryAmount));

    const remittance = await this.prisma.remittance.create({
      data: {
        provider: dto.provider,
        customerType: dto.customerType,
        clientId: dto.customerType === RemittanceCustomerType.INTERNAL ? dto.clientId : null,
        externalCustomerName:
          dto.customerType === RemittanceCustomerType.EXTERNAL ? dto.externalCustomerName : null,
        externalCustomerPhone:
          dto.customerType === RemittanceCustomerType.EXTERNAL ? dto.externalCustomerPhone : null,
        counterpartyName: dto.counterpartyName,
        referenceNumber: dto.referenceNumber,
        countryCode: dto.countryCode,
        principalAmount: dto.principalAmount,
        currencyId: currency.id,
        turkeyReceiptAmount: dto.turkeyReceiptAmount,
        libyaDeliveryAmount: dto.libyaDeliveryAmount,
        profit,
        turkeyAllowanceLyd: dto.turkeyAllowanceLyd ?? null,
        branchId: dto.branchId,
        status: RemittanceStatus.PENDING,
        recordedById: actor.id,
      },
      include: REMITTANCE_INCLUDE,
    });

    await this.audit.record({
      entityType: 'Remittance',
      entityId: remittance.id,
      action: 'CREATE_REMITTANCE',
      actorId: actor.id,
      after: {
        provider: remittance.provider,
        customerType: remittance.customerType,
        referenceNumber: remittance.referenceNumber,
        principalAmount: remittance.principalAmount.toString(),
        turkeyReceiptAmount: remittance.turkeyReceiptAmount.toString(),
        libyaDeliveryAmount: remittance.libyaDeliveryAmount.toString(),
        profit: remittance.profit.toString(),
        turkeyAllowanceLyd: remittance.turkeyAllowanceLyd?.toString() ?? null,
        status: remittance.status,
      },
    });

    return remittance;
  }

  async findAll(query: ListRemittancesQuery) {
    const where: Prisma.RemittanceWhereInput = {
      ...(query.provider && { provider: query.provider }),
      ...(query.status && { status: query.status }),
      ...(query.customerType && { customerType: query.customerType }),
      ...(query.branchId && { branchId: query.branchId }),
      ...(query.clientId && { clientId: query.clientId }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.remittance.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
        include: REMITTANCE_INCLUDE,
      }),
      this.prisma.remittance.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string) {
    const remittance = await this.prisma.remittance.findUnique({
      where: { id },
      include: REMITTANCE_INCLUDE,
    });
    if (!remittance) throw new NotFoundException('الحوالة غير موجودة');
    return remittance;
  }

  /**
   * تسجيل السحب الفعلي (تم السحب) — الانتقال الوحيد الذي يُرحِّل هامش الحوالة
   * محاسبيًا؛ لا يجوز إلا من PENDING (قيد التعديل)، ولا يجوز التراجع عنه لاحقًا.
   */
  async withdraw(id: string, actor: AuthenticatedUser) {
    const remittance = await this.findOne(id);
    if (remittance.status !== RemittanceStatus.PENDING) {
      throw new ConflictException('لا يمكن تسجيل السحب إلا لحوالة قيد التعديل (PENDING)');
    }

    const lydCurrency = await this.prisma.currency.findUnique({ where: { code: 'LYD' } });
    if (remittance.turkeyAllowanceLyd && !lydCurrency) {
      throw new BadRequestException('عملة الدينار الليبي غير مسجَّلة — تعذّر ترحيل بدل تركيا');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.remittance.updateMany({
        where: { id, status: RemittanceStatus.PENDING },
        data: {
          status: RemittanceStatus.WITHDRAWN,
          statusChangedById: actor.id,
          statusChangedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException('تغيّرت حالة الحوالة قبل تسجيل السحب — يرجى إعادة المحاولة');
      }

      await postJournalEntry(tx, {
        description: `هامش حوالة ${remittance.referenceNumber} — تم السحب`,
        sourceType: 'Remittance',
        sourceId: remittance.id,
        postedById: actor.id,
        lines: remittanceLedgerLines({
          profit: toMoney(remittance.profit),
          turkeyReceiptAmount: remittance.turkeyReceiptAmount,
          libyaDeliveryAmount: remittance.libyaDeliveryAmount,
          currencyId: remittance.currencyId,
          turkeyAllowanceLyd: remittance.turkeyAllowanceLyd,
          lydCurrencyId: lydCurrency?.id,
          branchId: remittance.branchId,
        }),
      });

      return tx.remittance.findUniqueOrThrow({ where: { id }, include: REMITTANCE_INCLUDE });
    });

    await this.audit.record({
      entityType: 'Remittance',
      entityId: id,
      action: 'WITHDRAW_REMITTANCE',
      actorId: actor.id,
      before: { status: RemittanceStatus.PENDING },
      after: { status: RemittanceStatus.WITHDRAWN },
    });

    return updated;
  }

  /**
   * رفض الحوالة — لا يجوز إلا من PENDING (قيد التعديل)؛ بلا أي ترحيل محاسبي
   * (لم يُرحَّل شيء عند التسجيل أصلًا، فلا حاجة لأي عكس).
   */
  async reject(id: string, dto: RejectRemittanceDto, actor: AuthenticatedUser) {
    const remittance = await this.findOne(id);
    if (remittance.status !== RemittanceStatus.PENDING) {
      throw new ConflictException('لا يمكن رفض حوالة ليست قيد التعديل (PENDING)');
    }

    const updated = await this.prisma.remittance.updateMany({
      where: { id, status: RemittanceStatus.PENDING },
      data: {
        status: RemittanceStatus.REJECTED,
        statusReason: dto.reason,
        statusChangedById: actor.id,
        statusChangedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      throw new ConflictException('تغيّرت حالة الحوالة قبل تسجيل الرفض — يرجى إعادة المحاولة');
    }

    await this.audit.record({
      entityType: 'Remittance',
      entityId: id,
      action: 'REJECT_REMITTANCE',
      actorId: actor.id,
      before: { status: RemittanceStatus.PENDING },
      after: { status: RemittanceStatus.REJECTED, reason: dto.reason },
    });

    return this.findOne(id);
  }

  private resolvePeriod(query: ReportPeriodQuery) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    return { from, to };
  }

  /**
   * ملخص أداء وحدة الحوالات لفترة — الحوالات المسحوبة (WITHDRAWN) فقط تُحتسَب
   * (الهامش المحقَّق فعلًا)؛ مجمَّعة حسب الشبكة فقط (لا اتجاه ولا عملة بعد
   * الآن — كلها بالدولار). بدل تركيا (بالدينار) مجموع منفصل تمامًا.
   */
  async getSummary(query: ReportPeriodQuery) {
    const { from, to } = this.resolvePeriod(query);
    const branchFilter = query.branchId ? { branchId: query.branchId } : {};

    const rows = await this.prisma.remittance.groupBy({
      by: ['provider'],
      where: {
        status: RemittanceStatus.WITHDRAWN,
        createdAt: { gte: from, lte: to },
        ...branchFilter,
      },
      _sum: {
        turkeyReceiptAmount: true,
        libyaDeliveryAmount: true,
        profit: true,
        principalAmount: true,
        turkeyAllowanceLyd: true,
      },
      _count: { _all: true },
    });

    const items = rows.map((row) => ({
      provider: row.provider,
      count: row._count._all,
      totalPrincipal: toMoney(row._sum.principalAmount ?? 0).toFixed(2),
      totalTurkeyReceiptAmount: toMoney(row._sum.turkeyReceiptAmount ?? 0).toFixed(2),
      totalLibyaDeliveryAmount: toMoney(row._sum.libyaDeliveryAmount ?? 0).toFixed(2),
      totalProfitUsd: toMoney(row._sum.profit ?? 0).toFixed(2),
      totalTurkeyAllowanceLyd: toMoney(row._sum.turkeyAllowanceLyd ?? 0).toFixed(2),
    }));

    const totals = items.reduce(
      (acc, item) => ({
        count: acc.count + item.count,
        totalProfitUsd: acc.totalProfitUsd.plus(item.totalProfitUsd),
        totalTurkeyAllowanceLyd: acc.totalTurkeyAllowanceLyd.plus(item.totalTurkeyAllowanceLyd),
      }),
      { count: 0, totalProfitUsd: toMoney(0), totalTurkeyAllowanceLyd: toMoney(0) },
    );

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      items,
      totals: {
        count: totals.count,
        totalProfitUsd: totals.totalProfitUsd.toFixed(2),
        totalTurkeyAllowanceLyd: totals.totalTurkeyAllowanceLyd.toFixed(2),
      },
    };
  }
}
