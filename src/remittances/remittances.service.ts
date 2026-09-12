import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RemittanceCustomerType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { ReportPeriodQuery } from '../reports/dto/report-period.query';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRemittanceDto } from './dto/create-remittance.dto';
import { ListRemittancesQuery } from './dto/list-remittances.query';
import { VoidRemittanceDto } from './dto/void-remittance.dto';

const REMITTANCE_INCLUDE = {
  client: { select: { id: true, fullName: true, phone: true } },
  currency: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, code: true, name: true } },
  recordedBy: { select: { id: true, fullName: true, role: true } },
  voidedBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.RemittanceInclude;

// وحدة حوالات وسترن يونيون وموني جرام — الشركة وكيل تحويل أموال لهاتين الشبكتين.
// مستقلة تمامًا عن حسابات وديعة العملاء وحركات خزينة الفروع؛ الربح لكل حوالة
// (saleValue - cost) يُحسب ويُخزَّن لحظة التسجيل، ولا يتغيّر إلا بإلغاء الحوالة.
@Injectable()
export class RemittancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async getCurrencyOrThrow(currencyCode: string) {
    const currency = await this.prisma.currency.findUnique({
      where: { code: currencyCode.toUpperCase() },
    });
    if (!currency || !currency.isActive) {
      throw new NotFoundException(`العملة ${currencyCode} غير مسجّلة أو غير مفعّلة`);
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

    const currency = await this.getCurrencyOrThrow(dto.currencyCode);
    const profit = toMoney(dto.saleValue).minus(toMoney(dto.cost));

    const remittance = await this.prisma.remittance.create({
      data: {
        provider: dto.provider,
        direction: dto.direction,
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
        cost: dto.cost,
        saleValue: dto.saleValue,
        profit,
        branchId: dto.branchId,
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
        direction: remittance.direction,
        customerType: remittance.customerType,
        referenceNumber: remittance.referenceNumber,
        principalAmount: remittance.principalAmount.toString(),
        currency: currency.code,
        cost: remittance.cost.toString(),
        saleValue: remittance.saleValue.toString(),
        profit: remittance.profit.toString(),
      },
    });

    return remittance;
  }

  async findAll(query: ListRemittancesQuery) {
    const where: Prisma.RemittanceWhereInput = {
      ...(query.provider && { provider: query.provider }),
      ...(query.direction && { direction: query.direction }),
      ...(query.customerType && { customerType: query.customerType }),
      ...(query.branchId && { branchId: query.branchId }),
      ...(query.clientId && { clientId: query.clientId }),
      ...(!query.includeVoided && { isVoided: false }),
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

  /** لا حذف فعلي — يُعلَّم الحوالة كملغاة مع سبب موثّق، فيبقى أثرها في السجل والتقارير. */
  async void(id: string, dto: VoidRemittanceDto, actor: AuthenticatedUser) {
    const remittance = await this.findOne(id);
    if (remittance.isVoided) throw new ConflictException('هذه الحوالة ملغاة بالفعل');

    const updated = await this.prisma.remittance.update({
      where: { id },
      data: { isVoided: true, voidReason: dto.reason, voidedById: actor.id, voidedAt: new Date() },
      include: REMITTANCE_INCLUDE,
    });

    await this.audit.record({
      entityType: 'Remittance',
      entityId: id,
      action: 'VOID_REMITTANCE',
      actorId: actor.id,
      before: { isVoided: false },
      after: { isVoided: true, reason: dto.reason },
    });

    return updated;
  }

  private resolvePeriod(query: ReportPeriodQuery) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    return { from, to };
  }

  /** ملخص أداء وحدة الحوالات لفترة: التكلفة، قيمة البيع، الربح الصافي، والعدد — مجمَّعة حسب الشبكة والاتجاه. */
  async getSummary(query: ReportPeriodQuery) {
    const { from, to } = this.resolvePeriod(query);
    const branchFilter = query.branchId ? { branchId: query.branchId } : {};
    const currencies = await this.prisma.currency.findMany({ select: { id: true, code: true } });
    const currencyCode = new Map(currencies.map((c) => [c.id, c.code]));

    const rows = await this.prisma.remittance.groupBy({
      by: ['provider', 'direction', 'currencyId'],
      where: { isVoided: false, createdAt: { gte: from, lte: to }, ...branchFilter },
      _sum: { cost: true, saleValue: true, profit: true, principalAmount: true },
      _count: { _all: true },
    });

    const items = rows.map((row) => ({
      provider: row.provider,
      direction: row.direction,
      currency: currencyCode.get(row.currencyId) ?? row.currencyId,
      count: row._count._all,
      totalPrincipal: toMoney(row._sum.principalAmount ?? 0).toFixed(2),
      totalCost: toMoney(row._sum.cost ?? 0).toFixed(2),
      totalSaleValue: toMoney(row._sum.saleValue ?? 0).toFixed(2),
      totalProfit: toMoney(row._sum.profit ?? 0).toFixed(2),
    }));

    // إجماليات عامة عبر كل العملات مجمَّعة معًا (لغرض مؤشر أداء سريع فقط — الأرقام
    // الدقيقة حسب العملة موجودة في items أعلاه، فلا تُخلَط عملات مختلفة في تقرير مالي حقيقي).
    const totals = items.reduce(
      (acc, item) => ({
        count: acc.count + item.count,
        totalCost: acc.totalCost.plus(item.totalCost),
        totalSaleValue: acc.totalSaleValue.plus(item.totalSaleValue),
        totalProfit: acc.totalProfit.plus(item.totalProfit),
      }),
      { count: 0, totalCost: toMoney(0), totalSaleValue: toMoney(0), totalProfit: toMoney(0) },
    );

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      items,
      totals: {
        count: totals.count,
        totalCost: totals.totalCost.toFixed(2),
        totalSaleValue: totals.totalSaleValue.toFixed(2),
        totalProfit: totals.totalProfit.toFixed(2),
      },
    };
  }
}
