import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { TreasuryService } from './treasury.service';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'teller@exlibya.ly',
  role: 'TELLER' as any,
  branchId: 'branch-1',
  mfaEnabled: false,
};

const usdCurrency = {
  id: 'cur-usd',
  code: 'USD',
  name: 'دولار أمريكي',
  isActive: true,
  decimalPlaces: 2,
};

const activeClient = { id: 'client-1', fullName: 'محمد الصالح', isActive: true };

function buildPrismaMock(
  position: {
    id: string;
    balance: string;
    maxExposure: string | null;
    minThreshold: string | null;
  },
  options: { client?: unknown; clientBalance?: { balance: string } | null } = {},
) {
  const tx = {
    treasuryPosition: {
      findUnique: jest.fn().mockResolvedValue(position),
      update: jest.fn().mockResolvedValue(position),
    },
    treasuryMovement: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'move-1', ...data })),
    },
    clientBalance: {
      findUnique: jest.fn().mockResolvedValue(options.clientBalance ?? null),
      upsert: jest
        .fn()
        .mockImplementation(({ create, update }: any) =>
          Promise.resolve(options.clientBalance ? update : create),
        ),
    },
    clientBalanceMovement: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'cbm-1', ...data })),
    },
  };

  return {
    branch: { findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'TRP-01' }) },
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    client: {
      findUnique: jest.fn().mockResolvedValue('client' in options ? options.client : activeClient),
    },
    $transaction: jest.fn().mockImplementation((callback: any) => callback(tx)),
    tx,
  } as unknown as PrismaService & { tx: typeof tx };
}

describe('TreasuryService.recordMovement', () => {
  it('يزيد الرصيد عند حركة إيداع ويعيد balanceAfter الصحيح', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '10000.00',
      maxExposure: '500000.00',
      minThreshold: '1000.00',
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    const result = await service.recordMovement(
      'branch-1',
      { currencyCode: 'USD', type: 'DEPOSIT' as any, amount: '5000.00', reason: 'تغذية' },
      actor,
    );

    expect(result.balanceAfter.toString()).toBe('15000');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('يرفض حركة سحب تتجاوز الرصيد الحالي', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '1000.00',
      maxExposure: '500000.00',
      minThreshold: '0',
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    await expect(
      service.recordMovement(
        'branch-1',
        { currencyCode: 'USD', type: 'WITHDRAWAL' as any, amount: '5000.00', reason: 'سحب' },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض تسجيل حركة على عملة لم تُفعَّل لهذا الفرع', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '1000.00',
      maxExposure: '500000.00',
      minThreshold: '0',
    });
    prisma.tx.treasuryPosition.findUnique.mockResolvedValueOnce(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    await expect(
      service.recordMovement(
        'branch-1',
        { currencyCode: 'USD', type: 'DEPOSIT' as any, amount: '100.00', reason: 'تغذية' },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('لا يعلّم أي تجاوز حد عند رصيد بلا سقف تعرّض ولا حد أدنى (كلاهما فارغ)', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '10000.00',
      maxExposure: null,
      minThreshold: null,
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    const result = await service.recordMovement(
      'branch-1',
      { currencyCode: 'USD', type: 'DEPOSIT' as any, amount: '5000000.00', reason: 'تغذية ضخمة' },
      actor,
    );

    expect(result.exceedsMaxExposure).toBe(false);
    expect(result.belowMinThreshold).toBe(false);
  });

  it('يزيد رصيد وديعة العميل تلقائيًا عند إيداع خزينة مرتبط بـ clientId', async () => {
    const prisma = buildPrismaMock(
      { id: 'pos-1', balance: '10000.00', maxExposure: null, minThreshold: null },
      { clientBalance: { balance: '200.00' } },
    );
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    const result = await service.recordMovement(
      'branch-1',
      {
        currencyCode: 'USD',
        type: 'DEPOSIT' as any,
        amount: '500.00',
        reason: 'إيداع عميل بالشباك',
        clientId: 'client-1',
      },
      actor,
    );

    expect(prisma.tx.clientBalance.upsert).toHaveBeenCalled();
    expect(result.clientBalanceMovement).toEqual(
      expect.objectContaining({ type: 'DEPOSIT', balanceAfter: expect.anything() }),
    );
    expect(result.clientBalanceMovement!.balanceAfter.toString()).toBe('700');
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('ينقص رصيد وديعة العميل (وقد يصبح سالبًا) عند سحب خزينة مرتبط بـ clientId', async () => {
    const prisma = buildPrismaMock(
      { id: 'pos-1', balance: '10000.00', maxExposure: null, minThreshold: null },
      { clientBalance: { balance: '100.00' } },
    );
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    const result = await service.recordMovement(
      'branch-1',
      {
        currencyCode: 'USD',
        type: 'WITHDRAWAL' as any,
        amount: '400.00',
        reason: 'سحب عميل بالشباك',
        clientId: 'client-1',
      },
      actor,
    );

    expect(result.clientBalanceMovement!.balanceAfter.toString()).toBe('-300');
  });

  it('يرفض ربط clientId بحركة ليست إيداعًا أو سحبًا', async () => {
    const prisma = buildPrismaMock({
      id: 'pos-1',
      balance: '10000.00',
      maxExposure: null,
      minThreshold: null,
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    await expect(
      service.recordMovement(
        'branch-1',
        {
          currencyCode: 'USD',
          type: 'ADJUSTMENT_INCREASE' as any,
          amount: '100.00',
          reason: 'تسوية جرد',
          clientId: 'client-1',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض ربط clientId بعميل غير موجود', async () => {
    const prisma = buildPrismaMock(
      { id: 'pos-1', balance: '10000.00', maxExposure: null, minThreshold: null },
      { client: null },
    );
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    await expect(
      service.recordMovement(
        'branch-1',
        {
          currencyCode: 'USD',
          type: 'DEPOSIT' as any,
          amount: '100.00',
          reason: 'إيداع عميل',
          clientId: 'missing-client',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TreasuryService.configurePosition', () => {
  function buildPositionPrismaMock(existing: unknown) {
    return {
      branch: { findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'TRP-01' }) },
      currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
      treasuryPosition: {
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
    const service = new TreasuryService(prisma, audit);

    const result = await service.configurePosition('branch-1', { currencyCode: 'USD' }, actor);

    expect(result.maxExposure).toBeNull();
    expect(result.minThreshold).toBeNull();
  });
});

describe('TreasuryService.setBranchActive', () => {
  function buildBranchPrismaMock(existing: { id: string; isActive: boolean } | null) {
    return {
      branch: {
        findUnique: jest.fn().mockResolvedValue(existing),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ ...existing, ...data })),
      },
    } as unknown as PrismaService;
  }

  it('يعطّل فرعًا موجودًا ويدوّن ذلك في سجل التدقيق', async () => {
    const prisma = buildBranchPrismaMock({ id: 'branch-1', isActive: true });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    const result = await service.setBranchActive('branch-1', false, actor);

    expect(result.isActive).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEACTIVATE_BRANCH' }),
    );
  });

  it('يرفض تعطيل فرع غير موجود', async () => {
    const prisma = buildBranchPrismaMock(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new TreasuryService(prisma, audit);

    await expect(service.setBranchActive('missing', false, actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
