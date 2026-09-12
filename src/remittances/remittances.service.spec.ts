import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
    direction: 'SEND',
    customerType: 'INTERNAL',
    clientId: 'client-1',
    counterpartyName: 'مستفيد ما',
    referenceNumber: 'MTCN123',
    principalAmount: '500.00',
    currencyId: 'cur-usd',
    cost: '15.00',
    saleValue: '25.00',
    profit: '10.00',
    isVoided: false,
    ...options.createdOverrides,
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
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    remittance: {
      create: jest.fn().mockResolvedValue(created),
      findUnique: jest.fn().mockResolvedValue(created),
      update: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ ...created, ...data })),
      findMany: jest.fn().mockResolvedValue([created]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest
      .fn()
      .mockImplementation((arg: any) => (typeof arg === 'function' ? arg({}) : Promise.all(arg))),
  } as unknown as PrismaService;
}

describe('RemittancesService.create', () => {
  it('يسجّل حوالة لعميل داخلي ويحسب الربح تلقائيًا', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    const result = await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        direction: 'SEND' as any,
        customerType: 'INTERNAL' as any,
        clientId: 'client-1',
        counterpartyName: 'مستفيد ما',
        referenceNumber: 'MTCN123',
        principalAmount: '500.00',
        currencyCode: 'USD',
        cost: '15.00',
        saleValue: '25.00',
      },
      actor,
    );

    expect(result.id).toBe('rem-1');
    expect(prisma.remittance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ profit: expect.anything() }),
      }),
    );
    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.profit.toString()).toBe('10');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('يسجّل حوالة لزبون خارجي بلا clientId', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await service.create(
      {
        provider: 'MONEYGRAM' as any,
        direction: 'RECEIVE' as any,
        customerType: 'EXTERNAL' as any,
        externalCustomerName: 'زبون عابر',
        counterpartyName: 'مرسِل من الخارج',
        referenceNumber: 'MG-999',
        principalAmount: '200.00',
        currencyCode: 'USD',
        cost: '5.00',
        saleValue: '10.00',
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
          direction: 'SEND' as any,
          customerType: 'INTERNAL' as any,
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '500.00',
          currencyCode: 'USD',
          cost: '15.00',
          saleValue: '25.00',
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
          direction: 'SEND' as any,
          customerType: 'EXTERNAL' as any,
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '500.00',
          currencyCode: 'USD',
          cost: '15.00',
          saleValue: '25.00',
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
          direction: 'SEND' as any,
          customerType: 'INTERNAL' as any,
          clientId: 'client-1',
          externalCustomerName: 'اسم غير متوقَّع',
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '500.00',
          currencyCode: 'USD',
          cost: '15.00',
          saleValue: '25.00',
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
          direction: 'SEND' as any,
          customerType: 'INTERNAL' as any,
          clientId: 'missing',
          counterpartyName: 'مستفيد ما',
          referenceNumber: 'MTCN123',
          principalAmount: '500.00',
          currencyCode: 'USD',
          cost: '15.00',
          saleValue: '25.00',
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('يحسب ربحًا سالبًا إذا كانت التكلفة أعلى من قيمة البيع (لا يرفض العملية)', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await service.create(
      {
        provider: 'WESTERN_UNION' as any,
        direction: 'SEND' as any,
        customerType: 'INTERNAL' as any,
        clientId: 'client-1',
        counterpartyName: 'مستفيد ما',
        referenceNumber: 'MTCN123',
        principalAmount: '500.00',
        currencyCode: 'USD',
        cost: '30.00',
        saleValue: '20.00',
      },
      actor,
    );

    const callArg = (prisma.remittance.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.profit.toString()).toBe('-10');
  });
});

describe('RemittancesService.void', () => {
  it('يعلّم الحوالة كملغاة ويدوّن ذلك في سجل التدقيق', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    const result = await service.void('rem-1', { reason: 'تسجيل مكرر بالخطأ' }, actor);

    expect(result.isVoided).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VOID_REMITTANCE' }),
    );
  });

  it('يرفض إلغاء حوالة ملغاة بالفعل', async () => {
    const prisma = buildPrismaMock({ createdOverrides: { isVoided: true } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new RemittancesService(prisma, audit);

    await expect(service.void('rem-1', { reason: 'محاولة ثانية' }, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
