import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { buildLedgerMockDelegates } from '../accounting/testing/mock-ledger';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { RemittancesService } from './remittances.service';

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
const lydCurrency = { id: 'cur-lyd', code: 'LYD', name: 'دينار ليبي', isActive: true };

const activeClient = { id: 'client-1', fullName: 'محمد الصالح', isActive: true };

function buildPrismaMock(
  options: {
    client?: unknown;
    branch?: unknown;
    createdOverrides?: Record<string, unknown>;
  } = {},
) {
  const created = {
    id: 'rem-1',
    provider: 'WESTERN_UNION',
    customerType: 'INTERNAL',
    clientId: 'client-1',
    counterpartyName: 'مستفيد ما',
    referenceNumber: 'MTCN123',
    principalAmount: '1940.00',
    currencyId: 'cur-usd',
    turkeyReceiptAmount: '1950.00',
    libyaDeliveryAmount: '1940.00',
    profit: '10.00',
    turkeyAllowanceLyd: null,
    branchId: 'branch-1',
    status: 'PENDING',
    ...options.createdOverrides,
  };

  const txDelegates = {
    remittance: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...created, status: 'WITHDRAWN' }),
    },
    ...buildLedgerMockDelegates(),
  };

  return {
    client: {
      findUnique: jest.fn().mockResolvedValue('client' in options ? options.client : activeClient),
    },
    branch: {
      findUnique: jest
        .fn()
        .mockResolvedValue('branch' in options ? options.branch : { id: 'branch-1' }),
    },
    currency: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(where.code === 'LYD' ? lydCurrency : usdCurrency),
        ),
    },
    remittance: {
      create: jest.fn().mockResolvedValue(created),
      findUnique: jest.fn().mockResolvedValue(created),
      findMany: jest.fn().mockResolvedValue([created]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest
      .fn()
      .mockImplementation((arg: any) =>
        typeof arg === 'function' ? arg(txDelegates) : Promise.all(arg),
      ),
    tx: txDelegates,
  } as unknown as PrismaService & { tx: typeof txDelegates };
}

describe('RemittancesService.create', () => {
  it('يسجّل حوالة لعميل داخلي ويحسب الربح تلقائيًا (استلام تركيا - تسليم ليبيا)، بحالة PENDING', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    const result = await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        customerType: 'INTERNAL' as any,
        clientId: 'client-1',
        counterpartyName: 'مستفيد ما',
        referenceNumber: 'MTCN123',
        principalAmount: '1940.00',
        turkeyReceiptAmount: '1950.00',
        libyaDeliveryAmount: '1940.00',
      },
      actor,
    );

    expect(result.id).toBe('rem-1');
    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.profit.toString()).toBe('10');
    expect(callArg.data.status).toBe('PENDING');
    expect(callArg.data.currencyId).toBe('cur-usd'); // العملة دومًا USD — لا تُختار يدويًا
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('يقبل بدل تركيا اختياريًا بالدينار الليبي، منفصلًا عن الربح بالدولار', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        customerType: 'INTERNAL' as any,
        clientId: 'client-1',
        counterpartyName: 'مستفيد ما',
        referenceNumber: 'MTCN123',
        principalAmount: '1940.00',
        turkeyReceiptAmount: '1950.00',
        libyaDeliveryAmount: '1940.00',
        turkeyAllowanceLyd: '50.00',
      },
      actor,
    );

    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.turkeyAllowanceLyd).toBe('50.00');
    expect(callArg.data.profit.toString()).toBe('10'); // لا يتأثر بدل تركيا بالربح بالدولار إطلاقًا
  });

  it('يسجّل حوالة لزبون خارجي بلا clientId', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await service.create(
      {
        provider: 'MONEYGRAM' as any,
        customerType: 'EXTERNAL' as any,
        externalCustomerName: 'زبون عابر',
        counterpartyName: 'مرسِل من الخارج',
        referenceNumber: 'MG-999',
        principalAmount: '200.00',
        turkeyReceiptAmount: '210.00',
        libyaDeliveryAmount: '200.00',
      },
      actor,
    );

    expect(prisma.client.findUnique).not.toHaveBeenCalled();
    expect(prisma.remittance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: null, externalCustomerName: 'زبون عابر' }),
      }),
    );
  });

  it('يرفض عميلًا داخليًا بلا clientId', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(
      service.create(
        {
          provider: 'WESTERN_UNION' as any,
          customerType: 'INTERNAL' as any,
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '1940.00',
          turkeyReceiptAmount: '1950.00',
          libyaDeliveryAmount: '1940.00',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض زبونًا خارجيًا بلا اسم', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(
      service.create(
        {
          provider: 'WESTERN_UNION' as any,
          customerType: 'EXTERNAL' as any,
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '1940.00',
          turkeyReceiptAmount: '1950.00',
          libyaDeliveryAmount: '1940.00',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض مزج clientId مع externalCustomerName معًا', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(
      service.create(
        {
          provider: 'WESTERN_UNION' as any,
          customerType: 'INTERNAL' as any,
          clientId: 'client-1',
          externalCustomerName: 'اسم غير متوقَّع',
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '1940.00',
          turkeyReceiptAmount: '1950.00',
          libyaDeliveryAmount: '1940.00',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض عميلًا داخليًا غير موجود', async () => {
    const prisma = buildPrismaMock({ client: null });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(
      service.create(
        {
          provider: 'WESTERN_UNION' as any,
          customerType: 'INTERNAL' as any,
          clientId: 'missing',
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '1940.00',
          turkeyReceiptAmount: '1950.00',
          libyaDeliveryAmount: '1940.00',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('يحسب ربحًا سالبًا إذا كان سعر التسليم في ليبيا أعلى من سعر الاستلام في تركيا (لا يرفض العملية)', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        customerType: 'INTERNAL' as any,
        clientId: 'client-1',
        counterpartyName: 'مستفيد ما',
        referenceNumber: 'MTCN123',
        principalAmount: '1940.00',
        turkeyReceiptAmount: '1930.00',
        libyaDeliveryAmount: '1940.00',
      },
      actor,
    );

    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.profit.toString()).toBe('-10');
  });
});

describe('RemittancesService.withdraw', () => {
  it('يرحّل هامش الحوالة محاسبيًا وينقلها إلى WITHDRAWN', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    const result = await service.withdraw('rem-1', actor);

    expect(result.status).toBe('WITHDRAWN');
    expect(prisma.tx.journalEntry.create).toHaveBeenCalledTimes(1);
    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    expect(lines).toHaveLength(3); // بلا بدل تركيا هنا — 3 أسطر فقط
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WITHDRAW_REMITTANCE' }),
    );
  });

  it('يضيف سطرين إضافيين بالدينار عند وجود بدل تركيا', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { turkeyAllowanceLyd: '50.00' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await service.withdraw('rem-1', actor);

    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    expect(lines).toHaveLength(5); // 3 أساسية بالدولار + سطران ببدل تركيا بالدينار
    const lydLines = lines.filter((l: any) => l.currencyId === 'cur-lyd');
    expect(lydLines).toHaveLength(2);
  });

  it('يرفض تسجيل السحب لحوالة ليست قيد التعديل (PENDING)', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { status: 'WITHDRAWN' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(service.withdraw('rem-1', actor)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('RemittancesService.reject', () => {
  it('يرفض الحوالة ويدوّن السبب دون أي ترحيل محاسبي', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    const result = await service.reject('rem-1', { reason: 'تسجيل مكرر بالخطأ' }, actor);

    expect(result.status).toBe('PENDING'); // findOne يعيد نسخة created الأصلية من الموك بعد التحديث المباشر
    expect(prisma.remittance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', statusReason: 'تسجيل مكرر بالخطأ' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REJECT_REMITTANCE' }),
    );
  });

  it('يرفض رفض حوالة ليست قيد التعديل (PENDING)', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { status: 'REJECTED' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(service.reject('rem-1', { reason: 'محاولة ثانية' }, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
