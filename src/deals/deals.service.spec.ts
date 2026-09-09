import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DealDirection, DealStatus, RateType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { DealsService } from './deals.service';

const teller: AuthenticatedUser = {
  id: 'teller-1',
  email: 'teller@exlibya.ly',
  role: 'TELLER' as any,
  branchId: 'branch-1',
};
const manager: AuthenticatedUser = {
  id: 'manager-1',
  email: 'manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
  branchId: 'branch-1',
};

const usdCurrency = { id: 'cur-usd', code: 'USD', name: 'دولار أمريكي', isActive: true };
const verifiedClient = {
  id: 'client-1',
  isActive: true,
  kycStatus: 'VERIFIED',
  fullName: 'شركة الوفاء',
  dailyLimitUsd: '100000.00',
  creditLimitUsd: '200000.00',
};
const latestUsdRate = {
  id: 'rate-1',
  officialRate: '4.85',
  parallelRate: '7.90',
};

function buildConfig(thresholdUsd = 30000) {
  return {
    get: jest.fn().mockReturnValue(thresholdUsd),
  } as unknown as ConfigService;
}

function buildAudit() {
  return { record: jest.fn() } as unknown as AuditService;
}

/** يبني عميل Prisma وهميًا كافيًا لتغطية DealsService.create دون قاعدة بيانات حقيقية. */
function buildPrismaMockForCreate(
  overrides: { dailyAggSum?: string | null; openAggSum?: string | null } = {},
) {
  return {
    client: { findUnique: jest.fn().mockResolvedValue(verifiedClient) },
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    exchangeRate: {
      findFirst: jest.fn().mockResolvedValue(latestUsdRate),
    },
    transaction: {
      aggregate: jest
        .fn()
        .mockResolvedValueOnce({ _sum: { amountUsdEquivalent: overrides.dailyAggSum ?? null } })
        .mockResolvedValueOnce({ _sum: { amountUsdEquivalent: overrides.openAggSum ?? null } }),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'deal-1', ...data })),
    },
  } as unknown as PrismaService;
}

describe('DealsService.create', () => {
  it('ينشئ صفقة ضمن الحد دون الحاجة لموافقة مزدوجة (APPROVED مباشرة)', async () => {
    const prisma = buildPrismaMockForCreate();
    const service = new DealsService(prisma, buildAudit(), buildConfig(30000));

    const deal = await service.create(
      {
        clientId: verifiedClient.id,
        currencyCode: 'USD',
        direction: DealDirection.SELL,
        rateType: RateType.OFFICIAL,
        amount: '5000.00',
      },
      teller,
    );

    expect(deal.status).toBe(DealStatus.APPROVED);
    expect(deal.requiresDualApproval).toBe(false);
  });

  it('يضع الصفقة بانتظار الموافقة عند تجاوز حد الموافقة المزدوجة', async () => {
    const prisma = buildPrismaMockForCreate();
    const service = new DealsService(prisma, buildAudit(), buildConfig(1000)); // حد منخفض عمدًا

    const deal = await service.create(
      {
        clientId: verifiedClient.id,
        currencyCode: 'USD',
        direction: DealDirection.SELL,
        rateType: RateType.OFFICIAL,
        amount: '5000.00',
      },
      teller,
    );

    expect(deal.status).toBe(DealStatus.PENDING_APPROVAL);
    expect(deal.requiresDualApproval).toBe(true);
  });

  it('يرفض صفقة تتجاوز الحد اليومي للعميل', async () => {
    const prisma = buildPrismaMockForCreate({ dailyAggSum: '96000.00' });
    const service = new DealsService(prisma, buildAudit(), buildConfig(30000));

    await expect(
      service.create(
        {
          clientId: verifiedClient.id,
          currencyCode: 'USD',
          direction: DealDirection.SELL,
          rateType: RateType.OFFICIAL,
          amount: '5000.00', // 96000 + 5000 = 101000 > الحد اليومي 100000
        },
        teller,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يطلب تحديد الفرع عند عدم ارتباط المستخدم بفرع ثابت', async () => {
    const prisma = buildPrismaMockForCreate();
    const service = new DealsService(prisma, buildAudit(), buildConfig(30000));
    const noBranchUser: AuthenticatedUser = { ...manager, branchId: null };

    await expect(
      service.create(
        {
          clientId: verifiedClient.id,
          currencyCode: 'USD',
          direction: DealDirection.SELL,
          rateType: RateType.OFFICIAL,
          amount: '5000.00',
        },
        noBranchUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DealsService — الموافقة المزدوجة (Maker-Checker)', () => {
  /**
   * updateManyCounts: نتيجة كل استدعاء متتالٍ لـ transaction.updateMany بالترتيب —
   * الاستدعاء الأول دومًا فحص انتهاء المهلة (expireIfLockPassed)، والثاني (إن وقع) كتابة الاعتماد الفعلية.
   */
  function buildPrismaMockForApproval(
    dealOverrides: Record<string, unknown> = {},
    updateManyCounts: number[] = [0],
  ) {
    const deal = {
      id: 'deal-1',
      status: DealStatus.PENDING_APPROVAL,
      requestedById: teller.id,
      lockExpiresAt: new Date(Date.now() + 30_000),
      ...dealOverrides,
    };
    const updateMany = jest.fn();
    updateManyCounts.forEach((count) => updateMany.mockResolvedValueOnce({ count }));
    updateMany.mockResolvedValue({ count: 0 });

    return {
      transaction: { updateMany, findUnique: jest.fn().mockResolvedValue(deal) },
    } as unknown as PrismaService;
  }

  it('يرفض اعتماد صفقة من نفس منشئها', async () => {
    const prisma = buildPrismaMockForApproval({}, [0]); // فحص المهلة: لم تنتهِ
    const service = new DealsService(prisma, buildAudit(), buildConfig());

    await expect(service.approve('deal-1', teller)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('يسمح لضابط آخر باعتماد الصفقة', async () => {
    const prisma = buildPrismaMockForApproval({}, [0, 1]); // المهلة لم تنتهِ، ثم كتابة الاعتماد تنجح
    const audit = buildAudit();
    const service = new DealsService(prisma, audit, buildConfig());

    await service.approve('deal-1', manager);

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPROVE_DEAL' }));
  });

  it('يرفض اعتماد صفقة انتهت مهلة قفل سعرها', async () => {
    const prisma = buildPrismaMockForApproval({ lockExpiresAt: new Date(Date.now() - 1000) }, [1]);
    const service = new DealsService(prisma, buildAudit(), buildConfig());

    await expect(service.approve('deal-1', manager)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض اعتماد صفقة ليست بانتظار موافقة', async () => {
    const prisma = buildPrismaMockForApproval({ status: DealStatus.EXECUTED }, [0]);
    const service = new DealsService(prisma, buildAudit(), buildConfig());

    await expect(service.approve('deal-1', manager)).rejects.toBeInstanceOf(ConflictException);
  });
});
