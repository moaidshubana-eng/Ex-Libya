import { ConflictException, NotFoundException } from '@nestjs/common';
import { buildLedgerMockDelegates } from '../accounting/testing/mock-ledger';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ClientsService } from './clients.service';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'treasury.manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
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

function buildPrismaMock(
  options: {
    client?: { id: string; isActive: boolean } | null;
    clientBalance?: { balance: string } | null;
  } = {},
) {
  const client = 'client' in options ? options.client : { id: 'client-1', isActive: true };

  const tx = {
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
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...buildLedgerMockDelegates(),
  };

  return {
    client: { findUnique: jest.fn().mockResolvedValue(client) },
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    clientBalanceMovement: tx.clientBalanceMovement,
    $transaction: jest.fn().mockImplementation((callback: any) => callback(tx)),
    tx,
  } as unknown as PrismaService & { tx: typeof tx };
}

describe('ClientsService.adjustBalance', () => {
  it('يزيد رصيد العميل عند تصحيح بالزيادة ويدوّنه في سجل التدقيق', async () => {
    const prisma = buildPrismaMock({ clientBalance: { balance: '100.00' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ClientsService(prisma, audit);

    const result = await service.adjustBalance(
      'client-1',
      {
        currencyCode: 'USD',
        direction: 'INCREASE',
        amount: '50.00',
        reason: 'تصحيح خطأ إدخال سابق',
      },
      actor,
    );

    expect(result.balanceAfter.toString()).toBe('150');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ADJUST_CLIENT_BALANCE' }),
    );
  });

  it('يسمح للرصيد أن يصبح سالبًا عند تصحيح بالنقصان يتجاوز الرصيد الحالي', async () => {
    const prisma = buildPrismaMock({ clientBalance: { balance: '30.00' } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ClientsService(prisma, audit);

    const result = await service.adjustBalance(
      'client-1',
      {
        currencyCode: 'USD',
        direction: 'DECREASE',
        amount: '80.00',
        reason: 'تسوية إدارية موثّقة',
      },
      actor,
    );

    expect(result.balanceAfter.toString()).toBe('-50');
  });

  it('يرفض التعديل على عميل معطَّل', async () => {
    const prisma = buildPrismaMock({ client: { id: 'client-1', isActive: false } });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ClientsService(prisma, audit);

    await expect(
      service.adjustBalance(
        'client-1',
        { currencyCode: 'USD', direction: 'INCREASE', amount: '10.00', reason: 'محاولة تعديل' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يرفض التعديل على عميل غير موجود', async () => {
    const prisma = buildPrismaMock({ client: null });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ClientsService(prisma, audit);

    await expect(
      service.adjustBalance(
        'missing',
        { currencyCode: 'USD', direction: 'INCREASE', amount: '10.00', reason: 'محاولة تعديل' },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClientsService.listBalanceMovements', () => {
  it('يجلب سجل حركات العميل مرتبًا من الأحدث للأقدم', async () => {
    const prisma = buildPrismaMock();
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new ClientsService(prisma, audit);

    await service.listBalanceMovements('client-1', 'USD');

    expect(prisma.clientBalanceMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client-1', currencyId: 'cur-usd' },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });
});
