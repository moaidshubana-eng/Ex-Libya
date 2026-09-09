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

function buildPrismaMock(position: {
  id: string;
  balance: string;
  maxExposure: string;
  minThreshold: string;
}) {
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
  };

  return {
    branch: { findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'TRP-01' }) },
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
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
});
