import { Injectable } from '@nestjs/common';
import { DealStatus, Prisma } from '@prisma/client';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { isIncreasingMovement } from '../treasury/movement-direction';
import { ReportPeriodQuery } from './dto/report-period.query';

// تحليلات وتقارير للقراءة فقط — لا تُعدّل أي بيانات، تُجمّع (aggregate) ما
// سجّلته الوحدات الأخرى (الصفقات، المصاريف، حركات الخزينة، العملاء).
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private resolvePeriod(query: ReportPeriodQuery) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    return { from, to };
  }

  private async currencyCodeMap() {
    const currencies = await this.prisma.currency.findMany({ select: { id: true, code: true } });
    return new Map(currencies.map((c) => [c.id, c.code]));
  }

  /** ملخص مالي شامل لفترة: حجم الصفقات المنفَّذة، المصاريف، صافي حركة الخزينة، عملاء جدد. */
  async getFinancialSummary(query: ReportPeriodQuery) {
    const { from, to } = this.resolvePeriod(query);
    const branchFilter = query.branchId ? { branchId: query.branchId } : {};
    const currencyCode = await this.currencyCodeMap();

    const [dealsAgg, expensesAgg, movementsAgg, newClientsCount, pendingDealsCount] =
      await Promise.all([
        this.prisma.transaction.groupBy({
          by: ['direction', 'currencyId'],
          where: {
            status: DealStatus.EXECUTED,
            executedAt: { gte: from, lte: to },
            ...branchFilter,
          },
          _sum: { amount: true, lydEquivalent: true },
          _count: { _all: true },
        }),
        this.prisma.expense.groupBy({
          by: ['currencyId'],
          where: { isVoided: false, expenseDate: { gte: from, lte: to }, ...branchFilter },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        this.prisma.treasuryMovement.groupBy({
          by: ['type', 'currencyId'],
          where: { createdAt: { gte: from, lte: to }, ...branchFilter },
          _sum: { amount: true },
        }),
        this.prisma.client.count({ where: { createdAt: { gte: from, lte: to } } }),
        this.prisma.transaction.count({
          where: { status: DealStatus.PENDING_APPROVAL, ...branchFilter },
        }),
      ]);

    const deals = {
      count: dealsAgg.reduce((sum, row) => sum + row._count._all, 0),
      totalLydEquivalent: dealsAgg
        .reduce((sum, row) => sum.plus(row._sum.lydEquivalent ?? 0), toMoney(0))
        .toFixed(2),
      byDirection: dealsAgg.map((row) => ({
        direction: row.direction,
        currency: currencyCode.get(row.currencyId) ?? row.currencyId,
        amount: toMoney(row._sum.amount ?? 0).toFixed(2),
        lydEquivalent: toMoney(row._sum.lydEquivalent ?? 0).toFixed(2),
        count: row._count._all,
      })),
    };

    const expensesByCurrency = new Map<string, { total: Prisma.Decimal; count: number }>();
    for (const row of expensesAgg) {
      const code = currencyCode.get(row.currencyId) ?? row.currencyId;
      expensesByCurrency.set(code, {
        total: toMoney(row._sum.amount ?? 0),
        count: row._count._all,
      });
    }

    // صافي حركة الخزينة = مجموع الحركات الموجبة (إيداع/تحويل وارد/تسوية زيادة/شراء) ناقص
    // مجموع الحركات السالبة (سحب/تحويل صادر/تسوية نقصان/بيع)، محسوب لكل عملة على حدة.
    const treasuryNetByCurrency = new Map<string, Prisma.Decimal>();
    for (const row of movementsAgg) {
      const code = currencyCode.get(row.currencyId) ?? row.currencyId;
      const magnitude = toMoney(row._sum.amount ?? 0);
      const signed = isIncreasingMovement(row.type) ? magnitude : magnitude.negated();
      treasuryNetByCurrency.set(code, (treasuryNetByCurrency.get(code) ?? toMoney(0)).plus(signed));
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      deals,
      expenses: {
        total: [...expensesByCurrency.entries()].map(([currency, v]) => ({
          currency,
          total: v.total.toFixed(2),
          count: v.count,
        })),
      },
      treasuryNetMovement: [...treasuryNetByCurrency.entries()].map(([currency, net]) => ({
        currency,
        net: net.toFixed(2),
      })),
      newClients: newClientsCount,
      pendingDealsAwaitingApproval: pendingDealsCount,
    };
  }

  /** توزيع المصاريف حسب الفئة لفترة معيّنة — مادة جاهزة لرسم بياني دائري. */
  async getExpensesByCategory(query: ReportPeriodQuery) {
    const { from, to } = this.resolvePeriod(query);
    const branchFilter = query.branchId ? { branchId: query.branchId } : {};
    const currencyCode = await this.currencyCodeMap();

    const rows = await this.prisma.expense.groupBy({
      by: ['category', 'currencyId'],
      where: { isVoided: false, expenseDate: { gte: from, lte: to }, ...branchFilter },
      _sum: { amount: true },
      _count: { _all: true },
    });

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      items: rows.map((row) => ({
        category: row.category,
        currency: currencyCode.get(row.currencyId) ?? row.currencyId,
        total: toMoney(row._sum.amount ?? 0).toFixed(2),
        count: row._count._all,
      })),
    };
  }

  /** اتجاه حجم الصفقات المنفَّذة يوميًا خلال فترة — مادة جاهزة لرسم بياني خطي. */
  async getDealsTrend(query: ReportPeriodQuery) {
    const { from, to } = this.resolvePeriod(query);
    const branchId = query.branchId ?? null;

    const rows = await this.prisma.$queryRaw<
      { day: Date; currency_code: string; deals_count: bigint; total_lyd: Prisma.Decimal }[]
    >(Prisma.sql`
      SELECT date_trunc('day', t."executedAt") AS day,
             c."code" AS currency_code,
             COUNT(*)::bigint AS deals_count,
             SUM(t."lydEquivalent") AS total_lyd
      FROM "transactions" t
      JOIN "currencies" c ON c."id" = t."currencyId"
      WHERE t."status" = 'EXECUTED'
        AND t."executedAt" BETWEEN ${from} AND ${to}
        ${branchId ? Prisma.sql`AND t."branchId" = ${branchId}` : Prisma.empty}
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      points: rows.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        currency: row.currency_code,
        dealsCount: Number(row.deals_count),
        totalLydEquivalent: toMoney(row.total_lyd ?? 0).toFixed(2),
      })),
    };
  }

  /** إجمالي أرصدة الخزينة الموحّد عبر كل الفروع لكل عملة — لقطة الوضع الحالي (بلا فترة). */
  async getTreasuryConsolidated(branchId?: string) {
    const currencyCode = await this.currencyCodeMap();

    const rows = await this.prisma.treasuryPosition.groupBy({
      by: ['currencyId'],
      where: branchId ? { branchId } : undefined,
      _sum: { balance: true },
    });

    return rows.map((row) => ({
      currency: currencyCode.get(row.currencyId) ?? row.currencyId,
      totalBalance: toMoney(row._sum.balance ?? 0).toFixed(2),
    }));
  }
}
