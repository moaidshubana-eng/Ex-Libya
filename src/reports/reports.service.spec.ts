import { MovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';

function buildPrismaMock() {
  return {
    currency: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'cur-usd', code: 'USD' },
        { id: 'cur-lyd', code: 'LYD' },
      ]),
    },
    transaction: {
      groupBy: jest.fn().mockResolvedValue([
        {
          direction: 'BUY',
          currencyId: 'cur-usd',
          _sum: { amount: '1000.00', lydEquivalent: '4900.00' },
          _count: { _all: 2 },
        },
      ]),
      count: jest.fn().mockResolvedValue(3),
    },
    expense: {
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { currencyId: 'cur-lyd', _sum: { amount: '2000.00' }, _count: { _all: 1 } },
        ]),
    },
    treasuryMovement: {
      groupBy: jest.fn().mockResolvedValue([
        { type: MovementType.DEPOSIT, currencyId: 'cur-usd', _sum: { amount: '5000.00' } },
        { type: MovementType.WITHDRAWAL, currencyId: 'cur-usd', _sum: { amount: '1200.00' } },
      ]),
    },
    client: { count: jest.fn().mockResolvedValue(4) },
  } as unknown as PrismaService;
}

describe('ReportsService.getFinancialSummary', () => {
  it('يحسب صافي حركة الخزينة بشكل صحيح (إيداع موجب وسحب سالب) ويجمع كل المؤشرات', async () => {
    const prisma = buildPrismaMock();
    const service = new ReportsService(prisma);

    const result = await service.getFinancialSummary({});

    expect(result.treasuryNetMovement).toEqual([{ currency: 'USD', net: '3800.00' }]);
    expect(result.newClients).toBe(4);
    expect(result.pendingDealsAwaitingApproval).toBe(3);
    expect(result.deals.count).toBe(2);
    expect(result.deals.totalLydEquivalent).toBe('4900.00');
    expect(result.expenses.total).toEqual([{ currency: 'LYD', total: '2000.00', count: 1 }]);
  });
});

describe('ReportsService.getExpensesByCategory', () => {
  it('يعيد توزيع المصاريف حسب الفئة والعملة', async () => {
    const prisma = buildPrismaMock();
    (prisma.expense.groupBy as jest.Mock).mockResolvedValueOnce([
      { category: 'RENT', currencyId: 'cur-lyd', _sum: { amount: '3500.00' }, _count: { _all: 1 } },
      {
        category: 'SALARIES',
        currencyId: 'cur-lyd',
        _sum: { amount: '12000.00' },
        _count: { _all: 5 },
      },
    ]);
    const service = new ReportsService(prisma);

    const result = await service.getExpensesByCategory({});

    expect(result.items).toEqual([
      { category: 'RENT', currency: 'LYD', total: '3500.00', count: 1 },
      { category: 'SALARIES', currency: 'LYD', total: '12000.00', count: 5 },
    ]);
  });
});
