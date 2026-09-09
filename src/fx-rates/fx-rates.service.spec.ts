import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { FxRatesService } from './fx-rates.service';

const actor: AuthenticatedUser = {
  id: 'user-1',
  email: 'manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
  branchId: null,
  mfaEnabled: true,
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

function buildConfig(overrides: Record<string, number> = {}) {
  const values: Record<string, number> = {
    'fx.maxDeviationPercent': 8,
    'whatsapp.broadcastDeviationPercent': 2,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function buildWhatsApp() {
  return {
    broadcastRateUpdate: jest
      .fn()
      .mockResolvedValue({ currency: 'USD', recipients: 0, sent: 0, failed: 0 }),
  } as unknown as WhatsAppService;
}

describe('FxRatesService.publish', () => {
  it('ينشر أول سعر لعملة دون الحاجة لسبب تجاوز، ودون بثّ واتساب (لا مرجع للمقارنة)', async () => {
    const prisma = buildPrismaMock(null);
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = buildWhatsApp();
    const service = new FxRatesService(prisma, audit, whatsApp, buildConfig());

    const result = await service.publish(
      'USD',
      { officialRate: '4.85', parallelRate: '7.90' },
      actor,
    );

    expect(result.source).toBe('MANUAL');
    expect(result.isOverride).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'PUBLISH_RATE' }));
    expect(whatsApp.broadcastRateUpdate).not.toHaveBeenCalled();
  });

  it('يرفض تغيّرًا يتجاوز حد الانحراف دون سبب تجاوز', async () => {
    const prisma = buildPrismaMock({ officialRate: '4.85', parallelRate: '7.90' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = buildWhatsApp();
    const service = new FxRatesService(prisma, audit, whatsApp, buildConfig());

    await expect(
      service.publish('USD', { officialRate: '6.50', parallelRate: '7.90' }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(audit.record).not.toHaveBeenCalled();
    expect(whatsApp.broadcastRateUpdate).not.toHaveBeenCalled();
  });

  it('يقبل تجاوز الحد عند إرفاق سبب موثّق، ويسجّله كتجاوز يدوي، ويبثّه عبر واتساب', async () => {
    const prisma = buildPrismaMock({ officialRate: '4.85', parallelRate: '7.90' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = buildWhatsApp();
    const service = new FxRatesService(prisma, audit, whatsApp, buildConfig());

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
    expect(whatsApp.broadcastRateUpdate).toHaveBeenCalledWith('USD', actor.id);
  });

  it('لا يبثّ عبر واتساب عند تغيّر طفيف أقل من عتبة البثّ', async () => {
    const prisma = buildPrismaMock({ officialRate: '4.85', parallelRate: '7.90' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = buildWhatsApp();
    // عتبة بثّ مرتفعة عمدًا (10%) بينما التغيّر هنا طفيف (~1%)
    const service = new FxRatesService(
      prisma,
      audit,
      whatsApp,
      buildConfig({ 'whatsapp.broadcastDeviationPercent': 10 }),
    );

    await service.publish('USD', { officialRate: '4.90', parallelRate: '7.95' }, actor);

    expect(whatsApp.broadcastRateUpdate).not.toHaveBeenCalled();
  });

  it('فشل بثّ واتساب لا يفسد نشر السعر نفسه', async () => {
    const prisma = buildPrismaMock({ officialRate: '4.85', parallelRate: '7.90' });
    const audit = { record: jest.fn() } as unknown as AuditService;
    const whatsApp = {
      broadcastRateUpdate: jest.fn().mockRejectedValue(new Error('عطل مؤقت في مزوّد واتساب')),
    } as unknown as WhatsAppService;
    const service = new FxRatesService(prisma, audit, whatsApp, buildConfig());

    const result = await service.publish(
      'USD',
      { officialRate: '6.50', parallelRate: '7.90', overrideReason: 'تصحيح عاجل' },
      actor,
    );

    expect(result.id).toBe('rate-1'); // نُشر السعر بنجاح رغم فشل البثّ
  });
});
