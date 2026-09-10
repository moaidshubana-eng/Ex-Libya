import { ConflictException, NotFoundException } from '@nestjs/common';
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

function buildPrismaMock() {
  const created = { id: 'exp-1', amount: '3500.00', isVoided: false };
  return {
    branch: { findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'TRP-01' }) },
    currency: { findUnique: jest.fn().mockResolvedValue(lydCurrency) },
    expense: {
      create: jest.fn().mockResolvedValue(created),
      findUnique: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockResolvedValue({ ...created, isVoided: true }),
      findMany: jest.fn().mockResolvedValue([created]),
      count: jest.fn().mockResolvedValue(1),
    },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  } as unknown as PrismaService;
}

describe('ExpensesService.create', () => {
  it('يسجّل مصروفًا جديدًا ويدوّنه في سجل التدقيق', async () => {
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
    expect(audit.record).toHaveBeenCalledTimes(1);
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
  it('يعلّم المصروف كملغى ويدوّن السبب في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    // أول استدعاء لـ findOne (فحص الحالة قبل الإلغاء) يعيد المصروف غير الملغى؛ الاستدعاء
    // التالي (findOne بعد التحديث) يعيد النسخة الملغاة — يحاكي القراءة الفعلية بعد UPDATE.
    (prisma.expense.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'exp-1', amount: '3500.00', isVoided: false })
      .mockResolvedValue({ id: 'exp-1', amount: '3500.00', isVoided: true });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ExpensesService(prisma, audit);

    const result = await service.void('exp-1', { reason: 'تسجيل مكرر بالخطأ' }, actor);

    expect(result.isVoided).toBe(true);
    expect(audit.record).toHaveBeenCalledTimes(1);
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
