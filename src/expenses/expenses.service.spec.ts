import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ExpensesService } from './expenses.service';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'treasury.manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
  branchId: 'branch-1',
  mfaEnabled: false,
};

const lydCurrency = {
  id: 'cur-lyd',
  code: 'LYD',
  name: 'دينار ليبي',
  isActive: true,
  decimalPlaces: 2,
};

/**
 * $transaction هنا يُستدعى بصيغتين مختلفتين عبر الخدمة: صيغة الدالة (callback) في
 * create/void (تحتاج كائن tx بكل الدوال اللازمة)، وصيغة المصفوفة في findAll —
 * المحاكاة هنا تدعم الاثنتين.
 */
function buildPrismaMock(
  options: {
    expenseOverrides?: Record<string, unknown>;
    position?: { balance: string; maxExposure: string | null; minThreshold: string | null };
  } = {},
) {
  const created = {
    id: 'exp-1',
    amount: '3500.00',
    isVoided: false,
    paidFromTreasury: false,
    treasuryMovementId: null,
    branchId: null,
    currencyId: 'cur-lyd',
    currency: lydCurrency,
    description: 'إيجار مقر فرع طرابلس',
    ...options.expenseOverrides,
  };
  const position = {
    id: 'pos-1',
    balance: '50000.00',
    maxExposure: null,
    minThreshold: null,
    ...options.position,
  };

  const txDelegates = {
    branch: { findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'TRP-01' }) },
    currency: { findUnique: jest.fn().mockResolvedValue(lydCurrency) },
    expense: {
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue({ ...created, isVoided: true }),
    },
    treasuryPosition: {
      findUnique: jest.fn().mockResolvedValue(position),
      update: jest.fn().mockResolvedValue(position),
    },
    treasuryMovement: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'move-1', ...data })),
    },
  };

  return {
    ...txDelegates,
    expense: {
      ...txDelegates.expense,
      findUnique: jest.fn().mockResolvedValue(created),
      findMany: jest.fn().mockResolvedValue([created]),
      count: jest.fn().mockResolvedValue(1),
    },
    $transaction: jest.fn().mockImplementation((arg: any) => {
      if (typeof arg === 'function') return arg(txDelegates);
      return Promise.all(arg);
    }),
    tx: txDelegates,
  } as unknown as PrismaService & { tx: typeof txDelegates };
}

describe('ExpensesService.create', () => {
  it('يسجّل مصروفًا عاديًا (بلا خصم من الخزينة) ويدوّنه في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    const result = await service.create(
      {
        category: 'RENT' as any,
        amount: '3500.00',
        currencyCode: 'LYD',
        description: 'إيجار مقر فرع طرابلس',
      },
      actor,
    );

    expect(result.id).toBe('exp-1');
    expect(prisma.tx.treasuryMovement.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('يخصم المبلغ فورًا من رصيد خزينة الفرع عند paidFromTreasury، ويربط المصروف بالحركة', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    await service.create(
      {
        category: 'RENT' as any,
        amount: '3500.00',
        currencyCode: 'LYD',
        description: 'إيجار نقدًا من الشباك',
        branchId: 'branch-1',
        paidFromTreasury: true,
      },
      actor,
    );

    expect(prisma.tx.treasuryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'WITHDRAWAL' }) }),
    );
    expect(prisma.tx.expense.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidFromTreasury: true, treasuryMovementId: 'move-1' }),
      }),
    );
  });

  it('يرفض paidFromTreasury بلا تحديد فرع', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    await expect(
      service.create(
        {
          category: 'RENT' as any,
          amount: '100.00',
          currencyCode: 'LYD',
          description: 'مصروف بلا فرع محدَّد',
          paidFromTreasury: true,
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض التسجيل على فرع غير موجود', async () => {
    const prisma = buildPrismaMock();
    (prisma.branch.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    await expect(
      service.create(
        {
          category: 'RENT' as any,
          amount: '100.00',
          currencyCode: 'LYD',
          description: 'إيجار غير صحيح',
          branchId: 'missing-branch',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض التسجيل على عملة غير مفعّلة', async () => {
    const prisma = buildPrismaMock();
    (prisma.currency.findUnique as jest.Mock).mockResolvedValueOnce(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    await expect(
      service.create(
        { category: 'RENT' as any, amount: '100.00', currencyCode: 'XXX', description: 'اختبار' },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ExpensesService.void', () => {
  it('يعلّم المصروف كملغى بلا أي حركة خزينة إن لم يُخصَم منها أصلًا', async () => {
    const prisma = buildPrismaMock({ expenseOverrides: { paidFromTreasury: false } });
    (prisma.expense.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'exp-1',
        amount: '3500.00',
        isVoided: false,
        paidFromTreasury: false,
      })
      .mockResolvedValue({
        id: 'exp-1',
        amount: '3500.00',
        isVoided: true,
        paidFromTreasury: false,
      });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    const result = await service.void('exp-1', { reason: 'تسجيل مكرر بالخطأ' }, actor);

    expect(result.isVoided).toBe(true);
    expect(prisma.tx.treasuryMovement.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('يعيد إيداع المبلغ للخزينة عند إلغاء مصروف خُصم منها سابقًا', async () => {
    const prisma = buildPrismaMock();
    (prisma.expense.findUnique as jest.Mock)
      .mockResolvedValueOnce({
        id: 'exp-1',
        amount: '3500.00',
        isVoided: false,
        paidFromTreasury: true,
        branchId: 'branch-1',
        currencyId: 'cur-lyd',
        currency: lydCurrency,
        description: 'إيجار نقدًا',
      })
      .mockResolvedValue({ id: 'exp-1', isVoided: true, paidFromTreasury: true });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    await service.void('exp-1', { reason: 'خطأ في التسجيل' }, actor);

    expect(prisma.tx.treasuryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'DEPOSIT' }) }),
    );
  });

  it('يرفض إلغاء مصروف ملغى بالفعل', async () => {
    const prisma = buildPrismaMock();
    (prisma.expense.findUnique as jest.Mock).mockResolvedValue({ id: 'exp-1', isVoided: true });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    await expect(service.void('exp-1', { reason: 'محاولة ثانية' }, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
