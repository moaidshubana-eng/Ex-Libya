import { ConflictException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingService } from './accounting.service';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts';
import { buildLedgerMockDelegates } from './testing/mock-ledger';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'admin@exlibya.ly',
  role: 'ADMIN' as any,
  branchId: null,
  mfaEnabled: false,
};

const lydCurrency = {
  id: 'cur-lyd',
  code: 'LYD',
  name: 'دينار ليبي',
  isActive: true,
  decimalPlaces: 2,
};
const usdCurrency = {
  id: 'cur-usd',
  code: 'USD',
  name: 'دولار أمريكي',
  isActive: true,
  decimalPlaces: 2,
};

// حسابات حقيقية مطابقة لشجرة الحسابات — تُستخدم لاختبارات الميزانية/الدخل التي تحتاج
// class/normalBalance حقيقيَّين لا وهميَّين (خلافًا لـ buildLedgerMockDelegates العام).
const REAL_ACCOUNTS = CHART_OF_ACCOUNTS.map((a) => ({ id: 'acc-' + a.code, ...a }));

function buildPrismaMock() {
  const tx = {
    currency: { findUnique: jest.fn().mockResolvedValue(lydCurrency) },
    ...buildLedgerMockDelegates(),
  };

  return {
    currency: {
      findUnique: jest.fn().mockResolvedValue(lydCurrency),
      findMany: jest.fn().mockResolvedValue([lydCurrency, usdCurrency]),
    },
    account: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(REAL_ACCOUNTS),
    },
    journalEntry: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    journalLine: { groupBy: jest.fn().mockResolvedValue([]) },
    exchangeRate: { findFirst: jest.fn().mockResolvedValue({ rate: '5.00' }) },
    $transaction: jest.fn().mockImplementation((arg: any) => arg(tx)),
    tx,
  } as unknown as PrismaService & { tx: typeof tx };
}

describe('AccountingService.ensureChartOfAccounts', () => {
  it('يزرع كل حسابات الشجرة الافتراضية (upsert بالرمز)', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    await service.ensureChartOfAccounts();

    expect(prisma.account.upsert).toHaveBeenCalledTimes(CHART_OF_ACCOUNTS.length);
  });
});

describe('AccountingService.postManualEntry', () => {
  it('يرحّل قيدًا يدويًا متوازنًا ويدوّنه في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    const entry = await service.postManualEntry(
      {
        description: 'زيادة رأس المال',
        lines: [
          { accountCode: '1015', debit: '10000.00', currencyCode: 'LYD' },
          { accountCode: '3000', credit: '10000.00', currencyCode: 'LYD' },
        ],
      },
      actor,
    );

    expect(entry.id).toBe('je-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'POST_MANUAL_JOURNAL_ENTRY' }),
    );
  });
});

describe('AccountingService.reverseEntry', () => {
  const originalEntry = {
    id: 'je-orig',
    description: 'قيد أصلي',
    sourceType: 'Manual',
    sourceId: null,
    lines: [
      {
        id: 'l1',
        accountId: 'acc-1015',
        debit: '500.00',
        credit: '0.00',
        currencyId: 'cur-lyd',
        branchId: null,
        memo: null,
        account: { code: '1015' },
      },
      {
        id: 'l2',
        accountId: 'acc-3000',
        debit: '0.00',
        credit: '500.00',
        currencyId: 'cur-lyd',
        branchId: null,
        memo: null,
        account: { code: '3000' },
      },
    ],
  };

  it('يعكس قيدًا موجودًا بمبادلة كل سطر', async () => {
    const prisma = buildPrismaMock();
    (prisma.journalEntry.findUnique as jest.Mock).mockResolvedValue(originalEntry);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    const reversal = await service.reverseEntry('je-orig', { reason: 'خطأ في الحساب' }, actor);

    expect(reversal.id).toBe('je-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REVERSE_JOURNAL_ENTRY' }),
    );
  });

  it('يرفض عكس قيد غير موجود', async () => {
    const prisma = buildPrismaMock();
    (prisma.journalEntry.findUnique as jest.Mock).mockResolvedValue(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    await expect(service.reverseEntry('missing', { reason: 'خطأ' }, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('يرفض عكس قيد معكوس بالفعل', async () => {
    const prisma = buildPrismaMock();
    (prisma.journalEntry.findUnique as jest.Mock).mockResolvedValue(originalEntry);
    (prisma.journalEntry.findFirst as jest.Mock).mockResolvedValue({ id: 'je-existing-reversal' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    await expect(
      service.reverseEntry('je-orig', { reason: 'محاولة ثانية' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AccountingService.getBalanceSheet', () => {
  it('يوازن الأصول مع الخصوم وحقوق الملكية لبيانات قيد مزدوج سليمة', async () => {
    const prisma = buildPrismaMock();
    // قيد واحد متوازن: إيداع رأس مال 10,000 دينار في البنك (أصل) مقابل رأس المال (حقوق ملكية)
    (prisma.journalLine.groupBy as jest.Mock).mockResolvedValue([
      { accountId: 'acc-1015', currencyId: 'cur-lyd', _sum: { debit: '10000.00', credit: '0.00' } },
      { accountId: 'acc-3000', currencyId: 'cur-lyd', _sum: { debit: '0.00', credit: '10000.00' } },
    ]);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    const sheet = await service.getBalanceSheet({});

    expect(sheet.balanceCheck.difference).toBe('0.00');
    expect(sheet.assets.current.find((a) => a.code === '1015')?.balance).toBe('10000.00');
    expect(sheet.equity.items.find((e) => e.code === '3000')?.balance).toBe('10000.00');
  });

  it('يحسب صافي الربح المتراكم كجزء من حقوق الملكية فيبقي التوازن رغم وجود إيرادات ومصاريف', async () => {
    const prisma = buildPrismaMock();
    // نقدية 100 (أصل)، إيراد 150 (دائن)، مصروف 50 (مدين) — صافي الربح 100 يوازن الزيادة في النقدية
    (prisma.journalLine.groupBy as jest.Mock).mockResolvedValue([
      { accountId: 'acc-1010', currencyId: 'cur-lyd', _sum: { debit: '100.00', credit: '0.00' } },
      { accountId: 'acc-4090', currencyId: 'cur-lyd', _sum: { debit: '0.00', credit: '150.00' } },
      { accountId: 'acc-5990', currencyId: 'cur-lyd', _sum: { debit: '50.00', credit: '0.00' } },
    ]);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    const sheet = await service.getBalanceSheet({});

    expect(sheet.equity.retainedEarningsAndCurrentIncomeLyd).toBe('100.00');
    expect(sheet.balanceCheck.difference).toBe('0.00');
  });
});

describe('AccountingService.getIncomeStatement', () => {
  it('يفصل الإيراد والمصروف ويحسب صافي الربح قبل وبعد الضريبة', async () => {
    const prisma = buildPrismaMock();
    (prisma.journalLine.groupBy as jest.Mock).mockResolvedValue([
      { accountId: 'acc-4090', currencyId: 'cur-lyd', _sum: { debit: '0.00', credit: '1000.00' } },
      { accountId: 'acc-5010', currencyId: 'cur-lyd', _sum: { debit: '300.00', credit: '0.00' } },
      { accountId: 'acc-5200', currencyId: 'cur-lyd', _sum: { debit: '70.00', credit: '0.00' } },
    ]);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new AccountingService(prisma, audit);

    const statement = await service.getIncomeStatement({});

    expect(statement.revenue.totalLydEquivalent).toBe('1000.00');
    expect(statement.expenses.totalLydEquivalent).toBe('300.00');
    expect(statement.netIncomeBeforeTaxLydEquivalent).toBe('700.00');
    expect(statement.incomeTax.totalLydEquivalent).toBe('70.00');
    expect(statement.netIncomeAfterTaxLydEquivalent).toBe('630.00');
  });
});
