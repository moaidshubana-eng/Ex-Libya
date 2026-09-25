import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { buildLedgerMockDelegates } from '../accounting/testing/mock-ledger';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { RemittancesService } from './remittances.service';

function buildWhatsApp() {
  return {
    sendRemittanceWithdrawn: jest.fn().mockResolvedValue(undefined),
    sendRemittanceRejected: jest.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppService;
}

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

const existingClient = {
  id: 'client-1',
  fullName: 'محمد الصالح',
  phone: '+218911234567',
  isActive: true,
};

function buildPrismaMock(
  options: {
    existingClient?: unknown;
    branch?: unknown;
    createdOverrides?: Record<string, unknown>;
  } = {},
) {
  const created = {
    id: 'rem-1',
    provider: 'WESTERN_UNION',
    customerType: 'INTERNAL',
    clientId: 'client-1',
    referenceNumber: 'MTCN123',
    currencyId: 'cur-usd',
    turkeyReceiptAmount: '1950.00',
    libyaDeliveryAmount: '1940.00',
    profit: '10.00',
    turkeyAllowanceLyd: null,
    branchId: 'branch-1',
    status: 'PENDING',
    client: { id: 'client-1', fullName: 'محمد الصالح', phone: '+218911234567' },
    currency: { id: 'cur-usd', code: 'USD', name: 'دولار أمريكي' },
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
      findUnique: jest
        .fn()
        .mockResolvedValue('existingClient' in options ? options.existingClient : existingClient),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'client-new', isActive: true, ...data }),
        ),
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
  it('يعيد استخدام عميل مسجَّل مسبقًا بهاتفه، ويحسب الربح تلقائيًا، بحالة PENDING', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    const result = await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        customerName: 'محمد الصالح',
        customerPhone: '+218911234567',
        referenceNumber: 'MTCN123',
        turkeyReceiptAmount: '1950.00',
        libyaDeliveryAmount: '1940.00',
      },
      actor,
    );

    expect(result.id).toBe('rem-1');
    expect(prisma.client.create).not.toHaveBeenCalled(); // عميل موجود مسبقًا — لا تسجيل جديد
    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.clientId).toBe('client-1');
    expect(callArg.data.profit.toString()).toBe('10');
    expect(callArg.data.status).toBe('PENDING');
    expect(callArg.data.currencyId).toBe('cur-usd'); // العملة دومًا USD
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('يسجّل عميلًا جديدًا تلقائيًا إن لم يكن هاتفه مسجَّلًا مسبقًا', async () => {
    const prisma = buildPrismaMock({ existingClient: null });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await service.create(
      {
        provider: 'MONEYGRAM' as any,
        customerName: 'زبون جديد',
        customerPhone: '+218900000000',
        referenceNumber: 'MG-999',
        turkeyReceiptAmount: '210.00',
        libyaDeliveryAmount: '200.00',
      },
      actor,
    );

    expect(prisma.client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fullName: 'زبون جديد',
          phone: '+218900000000',
          nationalIdOrReg: 'RM-218900000000',
        }),
      }),
    );
    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.clientId).toBe('client-new');
  });

  it('يرفض تسجيل حوالة لعميل معطَّل (وُجد بهاتفه لكنه غير نشط)', async () => {
    const prisma = buildPrismaMock({ existingClient: { ...existingClient, isActive: false } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await expect(
      service.create(
        {
          provider: 'WESTERN_UNION' as any,
          customerName: 'محمد الصالح',
          customerPhone: '+218911234567',
          referenceNumber: 'MTCN123',
          turkeyReceiptAmount: '1950.00',
          libyaDeliveryAmount: '1940.00',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يقبل بدل تركيا اختياريًا بالدينار الليبي، منفصلًا عن الربح بالدولار', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        customerName: 'محمد الصالح',
        customerPhone: '+218911234567',
        referenceNumber: 'MTCN123',
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

  it('يرفض فرعًا غير موجود', async () => {
    const prisma = buildPrismaMock({ branch: null });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await expect(
      service.create(
        {
          provider: 'WESTERN_UNION' as any,
          customerName: 'محمد الصالح',
          customerPhone: '+218911234567',
          referenceNumber: 'MTCN123',
          turkeyReceiptAmount: '1950.00',
          libyaDeliveryAmount: '1940.00',
          branchId: 'missing-branch',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('يحسب ربحًا سالبًا إذا كان سعر التسليم في ليبيا أعلى من سعر الاستلام في تركيا (لا يرفض العملية)', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        customerName: 'محمد الصالح',
        customerPhone: '+218911234567',
        referenceNumber: 'MTCN123',
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
  it('يرحّل صافي الربح فقط (سطران، لا تفصيل إيراد/تكلفة إجماليَين) وينقلها إلى WITHDRAWN', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    const result = await service.withdraw('rem-1', actor);

    expect(result.status).toBe('WITHDRAWN');
    expect(prisma.tx.journalEntry.create).toHaveBeenCalledTimes(1);
    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    expect(lines).toHaveLength(2); // صافي الربح فقط — بلا بدل تركيا هنا
    expect(lines[0].debit.toString()).toBe('10');
    expect(lines[1].credit.toString()).toBe('10');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WITHDRAW_REMITTANCE' }),
    );
  });

  it('يرسل إشعار واتساب بالسحب لعميل الحوالة بعد نجاح المعاملة', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = buildWhatsApp();
    const service = new RemittancesService(prisma, audit, whatsApp);

    await service.withdraw('rem-1', actor);

    expect(whatsApp.sendRemittanceWithdrawn).toHaveBeenCalledWith(
      { id: 'client-1', fullName: 'محمد الصالح', phone: '+218911234567' },
      { id: 'rem-1', referenceNumber: 'MTCN123', libyaDeliveryAmount: '1940.00' },
      'USD',
    );
  });

  it('يضيف سطرين إضافيين بالدينار عند وجود بدل تركيا', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { turkeyAllowanceLyd: '50.00' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await service.withdraw('rem-1', actor);

    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    expect(lines).toHaveLength(4); // سطرا الربح بالدولار + سطرا بدل تركيا بالدينار
    const lydLines = lines.filter((l: any) => l.currencyId === 'cur-lyd');
    expect(lydLines).toHaveLength(2);
  });

  it('يرفض تسجيل السحب لحوالة ليست قيد التعديل (PENDING)', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { status: 'WITHDRAWN' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await expect(service.withdraw('rem-1', actor)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('لا يرحّل أي قيد إطلاقًا عندما يكون الربح صفرًا بالضبط وبلا بدل تركيا (لا سطر بلا مدين أو دائن)', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { profit: '0.00' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    const result = await service.withdraw('rem-1', actor);

    expect(result.status).toBe('WITHDRAWN');
    expect(prisma.tx.journalEntry.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'WITHDRAW_REMITTANCE' }),
    );
  });

  it('يرحّل سطرَي بدل تركيا فقط عندما يكون الربح بالدولار صفرًا لكن بدل تركيا موجود', async () => {
    const prisma = buildPrismaMock({
      createdOverrides: { profit: '0.00', turkeyAllowanceLyd: '50.00' },
    });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await service.withdraw('rem-1', actor);

    expect(prisma.tx.journalEntry.create).toHaveBeenCalledTimes(1);
    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    expect(lines).toHaveLength(2); // سطرا بدل تركيا فقط — لا سطري ربح صفريَّين
    expect(lines.every((l: any) => l.currencyId === 'cur-lyd')).toBe(true);
  });
});

describe('RemittancesService.reject', () => {
  it('يرفض الحوالة ويدوّن السبب دون أي ترحيل محاسبي', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

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

  it('يرسل إشعار واتساب بالرفض والسبب لعميل الحوالة بعد نجاح التحديث', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = buildWhatsApp();
    const service = new RemittancesService(prisma, audit, whatsApp);

    await service.reject('rem-1', { reason: 'تسجيل مكرر بالخطأ' }, actor);

    expect(whatsApp.sendRemittanceRejected).toHaveBeenCalledWith(
      { id: 'client-1', fullName: 'محمد الصالح', phone: '+218911234567' },
      { id: 'rem-1', referenceNumber: 'MTCN123' },
      'تسجيل مكرر بالخطأ',
    );
  });

  it('يرفض رفض حوالة ليست قيد التعديل (PENDING)', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { status: 'REJECTED' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit, buildWhatsApp());

    await expect(service.reject('rem-1', { reason: 'محاولة ثانية' }, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
