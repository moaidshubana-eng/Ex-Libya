import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { FxRatesService } from './fx-rates.service';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
  branchId: null,
};

const usdCurrency = { id: 'cur-usd', code: 'USD', name: 'دولار أمريكي', isActive: true };

function buildPrismaMock(latestRate: { officialRate: string; parallelRate: string } | null) {
  return {
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    exchangeRate: {
      findFirst: jest.fn().mockResolvedValue(latestRate),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'rate-1', ...data })),
    },
  } as unknown as PrismaService;
}

function buildConfig() {
  return { get: jest.fn().mockReturnValue(8) } as unknown as ConfigService;
}

describe('FxRatesService.publish', () => {
  it('ينشر أول سعر لعملة دون الحاجة لسبب تجاوز', async () => {
    const prisma = buildPrismaMock(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new FxRatesService(prisma, audit, buildConfig());

    const result = await service.publish(
      'USD',
      { officialRate: '4.85', parallelRate: '7.90' },
      actor,
    );

    expect(result.source).toBe('MANUAL');
    expect(result.isOverride).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'PUBLISH_RATE' }));
  });

  it('يرفض تغيّرًا يتجاوز حد الانحراف دون سبب تجاوز', async () => {
    const prisma = buildPrismaMock({ officialRate: '4.85', parallelRate: '7.90' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new FxRatesService(prisma, audit, buildConfig());

    await expect(
      service.publish('USD', { officialRate: '6.50', parallelRate: '7.90' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('يقبل تجاوز الحد عند إرفاق سبب موثّق، ويسجّله كتجاوز يدوي', async () => {
    const prisma = buildPrismaMock({ officialRate: '4.85', parallelRate: '7.90' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const service = new FxRatesService(prisma, audit, buildConfig());

    const result = await service.publish(
      'USD',
      { officialRate: '6.50', parallelRate: '7.90', overrideReason: 'تصحيح عاجل إثر تعميم رسمي' },
      actor,
    );

    expect(result.isOverride).toBe(true);
    expect(result.source).toBe('OVERRIDE');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PUBLISH_RATE_OVERRIDE' }),
    );
  });
});
