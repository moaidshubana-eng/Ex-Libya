import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildLedgerMockDelegates } from '../accounting/testing/mock-ledger';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { BanksService } from './banks.service';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
  branchId: null,
  mfaEnabled: false,
};

const usdCurrency = {
  id: 'cur-usd',
  code: 'USD',
  name: 'دولار أمريكي',
  isActive: true,
  decimalPlaces: 2,
};

function buildPrismaMock(position: {
  id: string;
  balance: string;
  maxExposure: string | null;
  minThreshold: string | null;
}) {
  const tx = {
    bankPosition: {
      findUnique: jest.fn().mockResolvedValue(position),
      update: jest.fn().mockResolvedValue(position),
    },
    bankMovement: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'bmove-1', ...data })),
    },
    ...buildLedgerMockDelegates(),
  };

  return {
    bank: { findUnique: jest.fn().mockResolvedValue({ id: 'bank-1', code: 'ALJ-USD' }) },
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    $transaction: jest.fn().mockImplementation((callback: any) => callback(tx)),
    tx,
  } as unknown as PrismaService & { tx: typeof tx };
}

describe('BanksService.recordMovement', () => {
  it('يزيد رصيد المصرف عند حركة إيداع ويعيد balanceAfter الصحيح', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '10000.00',
      maxExposure: '500000.00',
      minThreshold: '1000.00',
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    const result = await service.recordMovement(
      'bank-1',
      { currencyCode: 'USD', type: 'DEPOSIT' as any, amount: '5000.00', reason: 'تحويل وارد' },
      actor,
    );

    expect(result.balanceAfter.toString()).toBe('15000');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RECORD_MOVEMENT' }),
    );
  });

  it('يرفض حركة سحب تتجاوز رصيد المصرف الحالي', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '1000.00',
      maxExposure: '500000.00',
      minThreshold: '0',
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    await expect(
      service.recordMovement(
        'bank-1',
        { currencyCode: 'USD', type: 'WITHDRAWAL' as any, amount: '5000.00', reason: 'سحب بنكي' },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض تسجيل حركة على عملة لم تُفعَّل لهذا الحساب المصرفي', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '1000.00',
      maxExposure: '500000.00',
      minThreshold: '0',
    });
    prisma.tx.bankPosition.findUnique.mockResolvedValueOnce(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    await expect(
      service.recordMovement(
        'bank-1',
        { currencyCode: 'USD', type: 'DEPOSIT' as any, amount: '100.00', reason: 'تحويل وارد' },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('يرحّل قيدًا محاسبيًا متوازنًا بين BANK_CASH والحساب المقابل لكل نوع حركة', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '10000.00',
      maxExposure: null,
      minThreshold: null,
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    await service.recordMovement(
      'bank-1',
      {
        currencyCode: 'USD',
        type: 'TRANSFER_IN' as any,
        amount: '2000.00',
        reason: 'تحويل من خزينة فرع طرابلس',
      },
      actor,
    );

    expect(prisma.tx.journalEntry.create).toHaveBeenCalledTimes(1);
    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    expect(lines).toEqual([
      expect.objectContaining({ accountId: 'acc-1015' }), // BANK_CASH
      expect.objectContaining({ accountId: 'acc-1030' }), // INTER_BRANCH_CLEARING
    ]);
  });

  it('لا يعلّم أي تجاوز حد عند رصيد بلا سقف تعرّض ولا حد أدنى (كلاهما فارغ)', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '10000.00',
      maxExposure: null,
      minThreshold: null,
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    const result = await service.recordMovement(
      'bank-1',
      { currencyCode: 'USD', type: 'DEPOSIT' as any, amount: '5000000.00', reason: 'تغذية ضخمة' },
      actor,
    );

    expect(result.exceedsMaxExposure).toBe(false);
    expect(result.belowMinThreshold).toBe(false);
  });
});

describe('BanksService.createBank', () => {
  it('يرفض إنشاء حساب مصرفي برمز مستخدَم مسبقًا', async () => {
    const uniqueError = Object.assign(
      Object.create(Prisma.PrismaClientKnownRequestError.prototype),
      { code: 'P2002', message: 'Unique constraint failed' },
    );
    const prisma = {
      bank: { create: jest.fn().mockRejectedValue(uniqueError) },
    } as unknown as PrismaService;
    const service = new BanksService(prisma, { record: jest.fn() } as unknown as AuditService);

    await expect(
      service.createBank({ code: 'ALJ-USD', name: 'مصرف الجمهورية' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BanksService.configurePosition', () => {
  function buildPositionPrismaMock(existing: unknown) {
    return {
      bank: { findUnique: jest.fn().mockResolvedValue({ id: 'bank-1', code: 'ALJ-USD' }) },
      currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
      bankPosition: {
        findUnique: jest.fn().mockResolvedValue(existing),
        upsert: jest
          .fn()
          .mockImplementation(({ create, update }: any) =>
            Promise.resolve({ id: 'pos-1', ...(existing ? update : create) }),
          ),
      },
    } as unknown as PrismaService;
  }

  it('يخزّن null صراحةً للحد الأدنى/السقف عند عدم إرسالهما — لا يُبقي القيمة الافتراضية', async () => {
    const prisma = buildPositionPrismaMock(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    const result = await service.configurePosition('bank-1', { currencyCode: 'USD' }, actor);

    expect(result.maxExposure).toBeNull();
    expect(result.minThreshold).toBeNull();
  });
});

describe('BanksService.setBankActive', () => {
  function buildBankPrismaMock(existing: { id: string; isActive: boolean } | null) {
    return {
      bank: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ ...existing, ...data })),
      },
    } as unknown as PrismaService;
  }

  it('يعطّل حسابًا مصرفيًا موجودًا ويدوّن ذلك في سجل التدقيق', async () => {
    const prisma = buildBankPrismaMock({ id: 'bank-1', isActive: true });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    const result = await service.setBankActive('bank-1', false, actor);

    expect(result.isActive).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEACTIVATE_BANK' }),
    );
  });

  it('يرفض تعطيل حساب مصرفي غير موجود', async () => {
    const prisma = buildBankPrismaMock(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new BanksService(prisma, audit);

    await expect(service.setBankActive('missing', false, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
