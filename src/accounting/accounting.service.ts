import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { AccountClass, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { toMoney } from '../common/money';
import { ReportPeriodQuery } from '../reports/dto/report-period.query';
import { PrismaService } from '../prisma/prisma.service';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts';
import { BalanceSheetQuery } from './dto/balance-sheet.query';
import { ListJournalEntriesQuery } from './dto/list-journal-entries.query';
import { PostJournalEntryDto } from './dto/post-journal-entry.dto';
import { ReverseJournalEntryDto } from './dto/reverse-journal-entry.dto';
import { postJournalEntry } from './post-journal-entry';

const JOURNAL_ENTRY_INCLUDE = {
  lines: { include: { account: true, currency: true, branch: true } },
  postedBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.JournalEntryInclude;

// المحاسبة العامة (دفتر أستاذ ذو قيد مزدوج) — القوائم المالية (المركز
// المالي والدخل) تُشتَق حصرًا من مجموع سطور هذا الدفتر، فتوازن معادلة
// (الأصول = الخصوم + حقوق الملكية) مضمون بنيويًا لا يحتاج أي تصحيح لاحق،
// طالما كل قيد مُرحَّل متوازن (postJournalEntry يتحقق من ذلك دومًا).
@Injectable()
export class AccountingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.ensureChartOfAccounts();
  }

  /** يزرع شجرة الحسابات الافتراضية إن لم تكن موجودة — عملية idempotent (upsert بالرمز). */
  async ensureChartOfAccounts() {
    for (const seed of CHART_OF_ACCOUNTS) {
      await this.prisma.account.upsert({
        where: { code: seed.code },
        create: seed,
        update: {
          name: seed.name,
          type: seed.type,
          class: seed.class,
          normalBalance: seed.normalBalance,
        },
      });
    }
  }

  listAccounts() {
    return this.prisma.account.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
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

  /** ترحيل قيد يدوي — لكل ما لا تستطيع الوحدات الأخرى ترحيله تلقائيًا بثقة (رأس المال، الأصول الثابتة، القروض، الضريبة، هامش الصفقات...). */
  async postManualEntry(dto: PostJournalEntryDto, actor: AuthenticatedUser) {
    const linesWithCurrencyId = await Promise.all(
      dto.lines.map(async (line) => {
        const currency = await this.getCurrencyOrThrow(line.currencyCode);
        return {
          accountCode: line.accountCode,
          debit: line.debit,
          credit: line.credit,
          currencyId: currency.id,
          branchId: line.branchId,
          memo: line.memo,
        };
      }),
    );

    const entry = await this.prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        description: dto.description,
        entryDate: dto.entryDate ? new Date(dto.entryDate) : undefined,
        sourceType: 'Manual',
        postedById: actor.id,
        lines: linesWithCurrencyId,
      }),
    );

    await this.audit.record({
      entityType: 'JournalEntry',
      entityId: entry.id,
      action: 'POST_MANUAL_JOURNAL_ENTRY',
      actorId: actor.id,
      after: {
        description: entry.description,
        lines: entry.lines.map((l) => ({
          account: l.account.code,
          debit: l.debit.toString(),
          credit: l.credit.toString(),
          currency: l.currency.code,
        })),
      },
    });

    return entry;
  }

  /**
   * يعكس قيدًا سابقًا بقيد جديد يبادل المدين بالدائن في كل سطر — لا يُعدَّل
   * ولا يُحذف القيد الأصلي أبدًا، فيبقى ظاهرًا للتدقيق الكامل جنبًا إلى جنب
   * مع عكسه.
   */
  async reverseEntry(id: string, dto: ReverseJournalEntryDto, actor: AuthenticatedUser) {
    const original = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: JOURNAL_ENTRY_INCLUDE,
    });
    if (!original) throw new NotFoundException('القيد غير موجود');

    const existingReversal = await this.prisma.journalEntry.findFirst({
      where: { reversalOfId: id },
    });
    if (existingReversal) throw new ConflictException('هذا القيد معكوس بالفعل بقيد سابق');

    const entry = await this.prisma.$transaction((tx) =>
      postJournalEntry(tx, {
        description: `عكس قيد: ${original.description} — ${dto.reason}`,
        sourceType: original.sourceType ?? 'Manual',
        sourceId: original.sourceId ?? undefined,
        reversalOfId: original.id,
        postedById: actor.id,
        lines: original.lines.map((l) => ({
          accountCode: l.account.code,
          debit: l.credit, // مبادلة المدين بالدائن
          credit: l.debit,
          currencyId: l.currencyId,
          branchId: l.branchId,
          memo: l.memo ?? undefined,
        })),
      }),
    );

    await this.audit.record({
      entityType: 'JournalEntry',
      entityId: entry.id,
      action: 'REVERSE_JOURNAL_ENTRY',
      actorId: actor.id,
      before: { reversedEntryId: original.id },
      after: { reason: dto.reason },
    });

    return entry;
  }

  async listJournalEntries(query: ListJournalEntriesQuery) {
    const where: Prisma.JournalEntryWhereInput = {
      ...(query.sourceType && { sourceType: query.sourceType }),
      ...(query.accountCode && { lines: { some: { account: { code: query.accountCode } } } }),
      ...((query.from || query.to) && {
        entryDate: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.journalEntry.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { entryDate: 'desc' },
        include: JOURNAL_ENTRY_INCLUDE,
      }),
      this.prisma.journalEntry.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOneEntry(id: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: JOURNAL_ENTRY_INCLUDE,
    });
    if (!entry) throw new NotFoundException('القيد غير موجود');
    return entry;
  }

  /** أحدث سعر صرف منشور لكل عملة (LYD لكل وحدة) — لتوحيد قوائم مالية بعملات متعددة إلى إجمالي إرشادي بالدينار. */
  private async latestRatesMap() {
    const currencies = await this.prisma.currency.findMany();
    const map = new Map<string, { code: string; rate: Prisma.Decimal | null }>();
    for (const currency of currencies) {
      if (currency.code === 'LYD') {
        map.set(currency.id, { code: currency.code, rate: toMoney(1) });
        continue;
      }
      const latest = await this.prisma.exchangeRate.findFirst({
        where: { currencyId: currency.id },
        orderBy: { createdAt: 'desc' },
      });
      map.set(currency.id, { code: currency.code, rate: latest?.rate ?? null });
    }
    return map;
  }

  /**
   * أرصدة كل حساب حتى لحظة معيّنة (asOf)، مجمَّعة بالعملة — الرصيد الطبيعي
   * (مدين - دائن أو العكس حسب normalBalance) محسوب من مجموع كل سطور دفتر
   * الأستاذ حتى تلك اللحظة، لا من أي رصيد مخزَّن مسبقًا في مكان آخر.
   */
  private async accountBalancesAsOf(asOf: Date, branchId?: string) {
    const rows = await this.prisma.journalLine.groupBy({
      by: ['accountId', 'currencyId'],
      where: {
        journalEntry: { entryDate: { lte: asOf } },
        ...(branchId && { branchId }),
      },
      _sum: { debit: true, credit: true },
    });

    const accounts = await this.prisma.account.findMany();
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    return rows.map((row) => {
      const account = accountById.get(row.accountId)!;
      const debit = toMoney(row._sum.debit ?? 0);
      const credit = toMoney(row._sum.credit ?? 0);
      const balance = account.normalBalance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
      return { account, currencyId: row.currencyId, balance };
    });
  }

  /**
   * قائمة المركز المالي (الميزانية) عند لحظة معيّنة — الأصول مقابل الخصوم
   * وحقوق الملكية. حقوق الملكية تضمّ "الأرباح المرحّلة ونتيجة الفترة
   * الحالية" كبند محسوب لحظيًا (صافي الإيرادات ناقص المصاريف منذ إنشاء
   * الدفتر) لا كقيد إقفال دوري يدوي — أسلوب شائع في الأنظمة المحاسبية
   * الحديثة التي تعرض النتيجة حيًّا دون إجراء إقفال رسمي شهري/سنوي.
   */
  async getBalanceSheet(query: BalanceSheetQuery) {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();
    const balances = await this.accountBalancesAsOf(asOf, query.branchId);
    const rates = await this.latestRatesMap();

    const currencies = await this.prisma.currency.findMany({ select: { id: true, code: true } });
    const currencyCode = new Map(currencies.map((c) => [c.id, c.code]));

    const toLine = (b: (typeof balances)[number]) => ({
      code: b.account.code,
      name: b.account.name,
      currency: currencyCode.get(b.currencyId) ?? b.currencyId,
      balance: b.balance.toFixed(2),
    });

    const byClass = (cls: AccountClass) => balances.filter((b) => b.account.class === cls);

    const lydEquivalentTotal = (rows: typeof balances) =>
      rows
        .reduce((sum, b) => {
          const rate = rates.get(b.currencyId)?.rate;
          if (!rate) return sum; // عملة بلا سعر منشور — تُستثنى من الإجمالي الإرشادي، تبقى ظاهرة في التفصيل بعملتها
          return sum.plus(b.balance.times(rate));
        }, toMoney(0))
        .toFixed(2);

    // صافي الإيرادات ناقص المصاريف منذ إنشاء الدفتر (بلا حد أدنى للتاريخ) — يمثّل
    // بند "الأرباح المرحّلة ونتيجة الفترة الحالية" ضمن حقوق الملكية. balances أعلاه
    // يشمل أصلًا كل الحسابات (لا الأصول والخصوم فقط)، فلا حاجة لاستعلام إضافي.
    const netIncomeToDate = balances
      .filter((b) => b.account.class === 'REVENUE' || b.account.class === 'EXPENSE')
      .reduce((sum, b) => {
        const signed = b.account.class === 'REVENUE' ? b.balance : b.balance.negated();
        const rate = rates.get(b.currencyId)?.rate;
        if (!rate) return sum;
        return sum.plus(signed.times(rate));
      }, toMoney(0));

    const currentAssets = byClass('CURRENT_ASSET');
    const fixedAssets = byClass('FIXED_ASSET');
    const currentLiabilities = byClass('CURRENT_LIABILITY');
    const longTermLiabilities = byClass('LONG_TERM_LIABILITY');
    const equity = byClass('EQUITY');

    const totalAssetsLyd = toMoney(lydEquivalentTotal(currentAssets)).plus(
      lydEquivalentTotal(fixedAssets),
    );
    const totalLiabilitiesLyd = toMoney(lydEquivalentTotal(currentLiabilities)).plus(
      lydEquivalentTotal(longTermLiabilities),
    );
    const totalEquityLyd = toMoney(lydEquivalentTotal(equity)).plus(netIncomeToDate);

    return {
      asOf: asOf.toISOString(),
      assets: {
        current: currentAssets.map(toLine),
        fixed: fixedAssets.map(toLine),
        totalLydEquivalent: totalAssetsLyd.toFixed(2),
      },
      liabilities: {
        current: currentLiabilities.map(toLine),
        longTerm: longTermLiabilities.map(toLine),
        totalLydEquivalent: totalLiabilitiesLyd.toFixed(2),
      },
      equity: {
        items: equity.map(toLine),
        retainedEarningsAndCurrentIncomeLyd: netIncomeToDate.toFixed(2),
        totalLydEquivalent: totalEquityLyd.toFixed(2),
      },
      // الفرق بين الطرفين يجب أن يكون صفرًا دومًا (توازن بنيوي، لا حسابي مفروض) — يُعرَض
      // صراحةً كتأكيد قابل للتحقق، لا لأنه قد يختلف عن صفر في نظام قيد مزدوج سليم.
      balanceCheck: {
        totalAssetsLyd: totalAssetsLyd.toFixed(2),
        totalLiabilitiesAndEquityLyd: totalLiabilitiesLyd.plus(totalEquityLyd).toFixed(2),
        difference: totalAssetsLyd.minus(totalLiabilitiesLyd.plus(totalEquityLyd)).toFixed(2),
      },
    };
  }

  /** قائمة الدخل لفترة: الإيرادات والمصاريف مفصَّلة، وصافي الربح قبل/بعد ضريبة الدخل إن رُحِّلت. */
  async getIncomeStatement(query: ReportPeriodQuery) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getFullYear(), to.getMonth(), 1);

    const rows = await this.prisma.journalLine.groupBy({
      by: ['accountId', 'currencyId'],
      where: {
        journalEntry: { entryDate: { gte: from, lte: to } },
        ...(query.branchId && { branchId: query.branchId }),
        account: { class: { in: ['REVENUE', 'EXPENSE'] } },
      },
      _sum: { debit: true, credit: true },
    });

    const accounts = await this.prisma.account.findMany({
      where: { class: { in: ['REVENUE', 'EXPENSE'] } },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const currencies = await this.prisma.currency.findMany({ select: { id: true, code: true } });
    const currencyCode = new Map(currencies.map((c) => [c.id, c.code]));
    const rates = await this.latestRatesMap();

    const lines = rows.map((row) => {
      const account = accountById.get(row.accountId)!;
      const debit = toMoney(row._sum.debit ?? 0);
      const credit = toMoney(row._sum.credit ?? 0);
      const amount = account.normalBalance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
      return {
        code: account.code,
        name: account.name,
        class: account.class,
        currency: currencyCode.get(row.currencyId) ?? row.currencyId,
        currencyId: row.currencyId,
        amount,
      };
    });

    const lydTotal = (rows: typeof lines) =>
      rows.reduce((sum, l) => {
        const rate = rates.get(l.currencyId)?.rate;
        if (!rate) return sum;
        return sum.plus(l.amount.times(rate));
      }, toMoney(0));

    const revenueLines = lines.filter((l) => l.class === 'REVENUE');
    const expenseLines = lines.filter((l) => l.class === 'EXPENSE');
    const incomeTaxLines = expenseLines.filter((l) => l.code === '5200');
    const operatingExpenseLines = expenseLines.filter((l) => l.code !== '5200');

    const totalRevenueLyd = lydTotal(revenueLines);
    const totalOperatingExpenseLyd = lydTotal(operatingExpenseLines);
    const incomeTaxLyd = lydTotal(incomeTaxLines);
    const netIncomeBeforeTaxLyd = totalRevenueLyd.minus(totalOperatingExpenseLyd);
    const netIncomeAfterTaxLyd = netIncomeBeforeTaxLyd.minus(incomeTaxLyd);

    const toLine = (l: (typeof lines)[number]) => ({
      code: l.code,
      name: l.name,
      currency: l.currency,
      amount: l.amount.toFixed(2),
    });

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      revenue: {
        items: revenueLines.map(toLine),
        totalLydEquivalent: totalRevenueLyd.toFixed(2),
      },
      expenses: {
        items: operatingExpenseLines.map(toLine),
        totalLydEquivalent: totalOperatingExpenseLyd.toFixed(2),
      },
      netIncomeBeforeTaxLydEquivalent: netIncomeBeforeTaxLyd.toFixed(2),
      incomeTax: {
        items: incomeTaxLines.map(toLine),
        totalLydEquivalent: incomeTaxLyd.toFixed(2),
      },
      netIncomeAfterTaxLydEquivalent: netIncomeAfterTaxLyd.toFixed(2),
    };
  }
}
