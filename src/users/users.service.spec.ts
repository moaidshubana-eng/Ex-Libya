import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, StaffRole } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

const admin: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@exlibya.ly',
  role: StaffRole.ADMIN,
  branchId: null,
  mfaEnabled: false,
};

const targetTeller = {
  id: 'user-2',
  fullName: 'موظف اختبار',
  email: 'teller2@exlibya.ly',
  role: StaffRole.TELLER,
  branchId: null,
  isActive: true,
  mfaEnabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function buildAudit() {
  return { record: jest.fn() } as unknown as AuditService;
}

function buildPrismaMock(
  options: {
    user?: unknown;
    branch?: unknown;
    otherActiveAdminsCount?: number;
    createError?: unknown;
  } = {},
) {
  return {
    branch: {
      findUnique: jest
        .fn()
        .mockResolvedValue('branch' in options ? options.branch : { id: 'branch-1' }),
    },
    user: {
      create: options.createError
        ? jest.fn().mockRejectedValue(options.createError)
        : jest.fn().mockImplementation(({ data }: any) =>
            // يحاكي select: SAFE_USER_SELECT الفعلي — passwordHash لا يُعاد أبدًا
            Promise.resolve({
              id: 'user-new',
              fullName: data.fullName,
              email: data.email,
              role: data.role,
              branchId: data.branchId ?? null,
              isActive: true,
              mfaEnabled: false,
              branch: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }),
          ),
      findUnique: jest.fn().mockResolvedValue('user' in options ? options.user : targetTeller),
      update: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ ...targetTeller, ...data })),
      count: jest.fn().mockResolvedValue(options.otherActiveAdminsCount ?? 1),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn().mockImplementation((arg: any) => Promise.all(arg)),
  } as unknown as PrismaService;
}

describe('UsersService.create', () => {
  it('ينشئ مستخدمًا جديدًا ويسجّل ذلك في سجل التدقيق دون إعادة كلمة المرور', async () => {
    const prisma = buildPrismaMock();
    const audit = buildAudit();
    const service = new UsersService(prisma, audit);

    const user = await service.create(
      {
        fullName: 'موظف اختبار',
        email: 'teller2@exlibya.ly',
        password: 'ChangeMe123!',
        role: StaffRole.TELLER,
      },
      admin,
    );

    expect(user.email).toBe('teller2@exlibya.ly');
    expect((user as any).passwordHash).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_USER' }));
  });

  it('يرفض إنشاء مستخدم ببريد مستخدَم مسبقًا', async () => {
    const uniqueError = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2002', message: 'Unique constraint failed' },
    );
    const prisma = buildPrismaMock({ createError: uniqueError });
    const service = new UsersService(prisma, buildAudit());

    await expect(
      service.create(
        {
          fullName: 'ن',
          email: 'dup@exlibya.ly',
          password: 'ChangeMe123!',
          role: StaffRole.TELLER,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('يرفض ربط مستخدم جديد بفرع غير موجود', async () => {
    const prisma = buildPrismaMock({ branch: null });
    const service = new UsersService(prisma, buildAudit());

    await expect(
      service.create(
        {
          fullName: 'ن',
          email: 'x@exlibya.ly',
          password: 'ChangeMe123!',
          role: StaffRole.TELLER,
          branchId: 'missing-branch',
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('UsersService.updateRole', () => {
  it('يرفض تعديل المستخدم لدوره هو نفسه', async () => {
    const prisma = buildPrismaMock({ user: { ...targetTeller, id: admin.id } });
    const service = new UsersService(prisma, buildAudit());

    await expect(
      service.updateRole(admin.id, { role: StaffRole.ADMIN, reason: 'محاولة ترقية نفسي' }, admin),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('يحدّث الدور والفرع بنجاح ويدوّن ذلك في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    const audit = buildAudit();
    const service = new UsersService(prisma, audit);

    await service.updateRole(
      'user-2',
      { role: StaffRole.TREASURY_MANAGER, branchId: 'branch-1', reason: 'ترقية بعد التجربة' },
      admin,
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE_USER_ROLE' }),
    );
  });

  it('يرفض تنحية آخر مدير نظام (ADMIN) فعّال عن دوره', async () => {
    const lastAdmin = { ...targetTeller, id: 'admin-2', role: StaffRole.ADMIN, isActive: true };
    const prisma = buildPrismaMock({ user: lastAdmin, otherActiveAdminsCount: 0 });
    const service = new UsersService(prisma, buildAudit());

    await expect(
      service.updateRole('admin-2', { role: StaffRole.TELLER, reason: 'تخفيض صلاحيات' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('يسمح بتغيير دور مدير نظام إلى ADMIN أخرى (يبقى ADMIN) دون فحص آخر مدير', async () => {
    const anotherAdmin = { ...targetTeller, id: 'admin-2', role: StaffRole.ADMIN, isActive: true };
    const prisma = buildPrismaMock({ user: anotherAdmin, otherActiveAdminsCount: 0 });
    const service = new UsersService(prisma, buildAudit());

    await expect(
      service.updateRole('admin-2', { role: StaffRole.ADMIN, reason: 'تحديث فرع فقط' }, admin),
    ).resolves.toBeDefined();
  });
});

describe('UsersService.setActive', () => {
  it('يرفض تعطيل المستخدم لحسابه هو نفسه', async () => {
    const prisma = buildPrismaMock({ user: { ...targetTeller, id: admin.id } });
    const service = new UsersService(prisma, buildAudit());

    await expect(service.setActive(admin.id, false, admin)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('يعطّل مستخدمًا بنجاح ويدوّن ذلك في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    const audit = buildAudit();
    const service = new UsersService(prisma, audit);

    await service.setActive('user-2', false, admin);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEACTIVATE_USER' }),
    );
  });

  it('يرفض تعطيل آخر مدير نظام (ADMIN) فعّال', async () => {
    const lastAdmin = { ...targetTeller, id: 'admin-2', role: StaffRole.ADMIN, isActive: true };
    const prisma = buildPrismaMock({ user: lastAdmin, otherActiveAdminsCount: 0 });
    const service = new UsersService(prisma, buildAudit());

    await expect(service.setActive('admin-2', false, admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('يسمح بتفعيل حساب حتى لو كان آخر ADMIN (لا فحص إلا عند التعطيل)', async () => {
    const lastAdmin = { ...targetTeller, id: 'admin-2', role: StaffRole.ADMIN, isActive: false };
    const prisma = buildPrismaMock({ user: lastAdmin, otherActiveAdminsCount: 0 });
    const service = new UsersService(prisma, buildAudit());

    await expect(service.setActive('admin-2', true, admin)).resolves.toBeDefined();
  });
});

describe('UsersService.resetPassword', () => {
  it('يعيد تعيين كلمة المرور ويدوّن السبب في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    const audit = buildAudit();
    const service = new UsersService(prisma, audit);

    const result = await service.resetPassword(
      'user-2',
      { newPassword: 'NewPass123!', reason: 'نسي المستخدم كلمة مروره' },
      admin,
    );

    expect(result).toEqual({ success: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RESET_USER_PASSWORD' }),
    );
  });

  it('يرفض إعادة التعيين لمستخدم غير موجود', async () => {
    const prisma = buildPrismaMock({ user: null });
    const service = new UsersService(prisma, buildAudit());

    await expect(
      service.resetPassword('missing', { newPassword: 'NewPass123!', reason: 'محاولة' }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
