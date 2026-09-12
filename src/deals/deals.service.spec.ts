import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DealDirection, DealStatus } from '@prisma/client';
import { buildLedgerMockDelegates } from '../accounting/testing/mock-ledger';
import { ACCOUNT_CODES } from '../accounting/chart-of-accounts';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { DealsService } from './deals.service';

const teller: AuthenticatedUser = {
  id: 'teller-1',
  email: 'teller@exlibya.ly',
  role: 'TELLER' as any,
  branchId: 'branch-1',
  mfaEnabled: false,
};
const manager: AuthenticatedUser = {
  id: 'manager-1',
  email: 'manager@exlibya.ly',
  role: 'TREASURY_MANAGER' as any,
  branchId: 'branch-1',
  mfaEnabled: true,
};

const usdCurrency = { id: 'cur-usd', code: 'USD', name: 'دولار أمريكي', isActive: true };
const lydCurrency = { id: 'cur-lyd', code: 'LYD', name: 'دينار ليبي', isActive: true };
const verifiedClient = {
  id: 'client-1',
  isActive: true,
  kycStatus: 'VERIFIED',
  fullName: 'شركة الوفاء',
  phone: '+218911234567',
  dailyLimitUsd: '100000.00',
  creditLimitUsd: '200000.00',
};
const latestUsdRate = {
  id: 'rate-1',
  rate: '7.90',
};

function buildAudit() {
  return { record: jest.fn() } as unknown as AuditService;
}

function buildWhatsApp() {
  return {
    sendLimitAlert: jest.fn().mockResolvedValue(undefined),
    sendDealConfirmation: jest.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppService;
}

/** يبني عميل Prisma وهميًا كافيًا لتغطية DealsService.create دون قاعدة بيانات حقيقية. */
function buildPrismaMockForCreate() {
  return {
    client: { findUnique: jest.fn().mockResolvedValue(verifiedClient) },
    currency: { findUnique: jest.fn().mockResolvedValue(usdCurrency) },
    exchangeRate: {
      findFirst: jest.fn().mockResolvedValue(latestUsdRate),
    },
    transaction: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'deal-1', ...data })),
    },
  } as unknown as PrismaService;
}

describe('DealsService.create', () => {
  it('ينشئ الصفقة معتمدة مباشرة (APPROVED) بلا أي فحص حدود أو موافقة مزدوجة، مهما كبر مبلغها', async () => {
    const prisma = buildPrismaMockForCreate();
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    // مبلغ ضخم يتجاوز أي حد كان معتمدًا سابقًا (100000 دولار للعميل) — لا يُرفض الآن مطلقًا
    const deal = await service.create(
      {
        clientId: verifiedClient.id,
        currencyCode: 'USD',
        direction: DealDirection.SELL,
        amount: '500000.00',
        parallelMarketRate: '7.95',
      },
      teller,
    );

    expect(deal.status).toBe(DealStatus.APPROVED);
  });

  it('يحسب سعر السوق الموازي وهامش الربح/الخسارة ويخزّنهما مع الصفقة عند الإنشاء', async () => {
    const prisma = buildPrismaMockForCreate();
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    // بيع 1000 دولار بسعر مقفل 7.90 (آخر سعر منشور) بينما السوق الموازي 7.80 → ربح 100 دينار
    const deal = await service.create(
      {
        clientId: verifiedClient.id,
        currencyCode: 'USD',
        direction: DealDirection.SELL,
        amount: '1000.00',
        parallelMarketRate: '7.80',
      },
      teller,
    );

    expect(deal.parallelMarketRate).toBe('7.80');
    expect(deal.profitLyd.toFixed(2)).toBe('100.00');
    const callArg = (prisma.transaction.create as jest.Mock).mock.calls[0][0];
    expect(callArg.data.parallelMarketRate).toBe('7.80');
    expect(callArg.data.profitLyd.toFixed(2)).toBe('100.00');
    expect(callArg.data.status).toBe(DealStatus.APPROVED);
  });

  it('يطلب تحديد الفرع عند عدم ارتباط المستخدم بفرع ثابت', async () => {
    const prisma = buildPrismaMockForCreate();
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());
    const noBranchUser: AuthenticatedUser = { ...manager, branchId: null };

    await expect(
      service.create(
        {
          clientId: verifiedClient.id,
          currencyCode: 'USD',
          direction: DealDirection.SELL,
          amount: '5000.00',
          parallelMarketRate: '7.90',
        },
        noBranchUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض صفقة لعميل لم تكتمل مراجعة التحقق (KYC) الخاصة به', async () => {
    const prisma = buildPrismaMockForCreate();
    (prisma.client.findUnique as jest.Mock).mockResolvedValueOnce({
      ...verifiedClient,
      kycStatus: 'PENDING',
    });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await expect(
      service.create(
        {
          clientId: verifiedClient.id,
          currencyCode: 'USD',
          direction: DealDirection.SELL,
          amount: '5000.00',
          parallelMarketRate: '7.90',
        },
        teller,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('DealsService — الموافقة المزدوجة (مسار قديم لتسوية صفقات سابقة فقط)', () => {
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
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await expect(service.approve('deal-1', teller)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('يسمح لضابط آخر باعتماد الصفقة', async () => {
    const prisma = buildPrismaMockForApproval({}, [0, 1]); // المهلة لم تنتهِ، ثم كتابة الاعتماد تنجح
    const audit = buildAudit();
    const service = new DealsService(prisma, audit, buildWhatsApp());

    await service.approve('deal-1', manager);

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'APPROVE_DEAL' }));
  });

  it('يرفض اعتماد صفقة انتهت مهلة قفل سعرها', async () => {
    const prisma = buildPrismaMockForApproval({ lockExpiresAt: new Date(Date.now() - 1000) }, [1]);
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await expect(service.approve('deal-1', manager)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض اعتماد صفقة ليست بانتظار موافقة', async () => {
    const prisma = buildPrismaMockForApproval({ status: DealStatus.EXECUTED }, [0]);
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await expect(service.approve('deal-1', manager)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DealsService.execute — ترحيل هامش الصفقة إلى قائمة الدخل', () => {
  function buildPrismaMockForExecute(
    options: {
      profitLyd?: string;
      direction?: DealDirection;
      lydCurrencyOverride?: unknown;
      lydBalance?: string;
    } = {},
  ) {
    const deal = {
      id: 'deal-1',
      status: DealStatus.APPROVED,
      requestedById: teller.id,
      clientId: 'client-1',
      branchId: 'branch-1',
      currencyId: 'cur-usd',
      currency: { id: 'cur-usd', code: 'USD' },
      client: { id: 'client-1', fullName: 'شركة الوفاء' },
      direction: options.direction ?? DealDirection.SELL,
      amount: '1000.00',
      lockedRate: '8.00',
      lydEquivalent: '8000.00', // amount × lockedRate
      profitLyd: options.profitLyd ?? '100.00',
      lockExpiresAt: new Date(Date.now() + 30_000),
    };

    // مركزا خزينة منفصلان: عملة الصفقة الأجنبية (USD) والدينار الليبي — بحسب
    // currencyId المطلوب في كل استدعاء لـ applyMovement (طرفا الصفقة منفصلان).
    const positionsByCurrencyId: Record<
      string,
      { id: string; balance: string; maxExposure: null; minThreshold: null }
    > = {
      'cur-usd': { id: 'pos-usd', balance: '50000.00', maxExposure: null, minThreshold: null },
      'cur-lyd': {
        id: 'pos-lyd',
        balance: options.lydBalance ?? '500000.00',
        maxExposure: null,
        minThreshold: null,
      },
    };

    const tx = {
      transaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }), // نجاح المطالبة (claim) داخل المعاملة
      },
      treasuryPosition: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(positionsByCurrencyId[where.branchId_currencyId.currencyId] ?? null),
          ),
        update: jest.fn().mockResolvedValue({}),
      },
      treasuryMovement: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: 'move-' + data.type, ...data }),
          ),
      },
      ...buildLedgerMockDelegates(),
    };

    return {
      currency: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            'lydCurrencyOverride' in options ? options.lydCurrencyOverride : lydCurrency,
          ),
      },
      transaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // فحص المهلة خارج المعاملة: لم تنتهِ
        findUnique: jest.fn().mockResolvedValue(deal),
      },
      $transaction: jest.fn().mockImplementation((callback: any) => callback(tx)),
      tx,
    } as unknown as PrismaService & { tx: typeof tx };
  }

  it('يرحّل ربح الصفقة: مدين ذمم الهامش ودائن إيراد الصرف', async () => {
    const prisma = buildPrismaMockForExecute({ profitLyd: '100.00' });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await service.execute('deal-1', manager);

    expect(prisma.tx.journalEntry.create).toHaveBeenCalledTimes(1);
    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    const marginLine = lines.find(
      (l: any) => l.accountId === 'acc-' + ACCOUNT_CODES.FX_TRADING_MARGIN_RECEIVABLE,
    );
    const revenueLine = lines.find(
      (l: any) => l.accountId === 'acc-' + ACCOUNT_CODES.FX_TRADING_REVENUE,
    );
    expect(marginLine.debit.toString()).toBe('100');
    expect(marginLine.credit.toString()).toBe('0');
    expect(revenueLine.credit.toString()).toBe('100');
    expect(revenueLine.debit.toString()).toBe('0');
  });

  it('يرحّل خسارة الصفقة معكوسة: دائن ذمم الهامش ومدين إيراد الصرف', async () => {
    const prisma = buildPrismaMockForExecute({ profitLyd: '-50.00', direction: DealDirection.BUY });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await service.execute('deal-1', manager);

    const lines = (prisma.tx.journalEntry.create as jest.Mock).mock.calls[0][0].data.lines.create;
    const marginLine = lines.find(
      (l: any) => l.accountId === 'acc-' + ACCOUNT_CODES.FX_TRADING_MARGIN_RECEIVABLE,
    );
    const revenueLine = lines.find(
      (l: any) => l.accountId === 'acc-' + ACCOUNT_CODES.FX_TRADING_REVENUE,
    );
    expect(marginLine.credit.toString()).toBe('50');
    expect(revenueLine.debit.toString()).toBe('50');
  });

  it('لا يرحّل أي قيد عندما يكون هامش الصفقة صفرًا، لكن حركتا الخزينة (العملة والدينار) تبقيان قائمتين', async () => {
    const prisma = buildPrismaMockForExecute({ profitLyd: '0.00' });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await service.execute('deal-1', manager);

    expect(prisma.tx.journalEntry.create).not.toHaveBeenCalled();
    expect(prisma.tx.treasuryMovement.create).toHaveBeenCalledTimes(2); // طرف العملة الأجنبية + طرف الدينار
  });

  it('صفقة بيع (SELL): تُنشئ حركة زيادة على خزينة الدينار (تحصيل نقدي من العميل) بقيمة lydEquivalent', async () => {
    const prisma = buildPrismaMockForExecute({ direction: DealDirection.SELL });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await service.execute('deal-1', manager);

    const calls = (prisma.tx.treasuryMovement.create as jest.Mock).mock.calls;
    const lydMovement = calls.find((c: any) => c[0].data.currencyId === 'cur-lyd')[0].data;
    expect(lydMovement.type).toBe('TRADE_SELL_SETTLEMENT');
    expect(lydMovement.amount).toBe('8000.00'); // lydEquivalent
    expect(lydMovement.branchId).toBe('branch-1');
    expect(lydMovement.dealId).toBe('deal-1');
    // التحقق من اتجاه الزيادة عبر تحديث الرصيد: 500000 (الافتتاحي) + 8000 = 508000
    const lydUpdateCall = (prisma.tx.treasuryPosition.update as jest.Mock).mock.calls.find(
      (c: any) => c[0].where.id === 'pos-lyd',
    );
    expect(lydUpdateCall[0].data.balance.toString()).toBe('508000');
  });

  it('صفقة شراء (BUY): تُنشئ حركة نقصان على خزينة الدينار (دفع نقدي للعميل) بقيمة lydEquivalent', async () => {
    const prisma = buildPrismaMockForExecute({ direction: DealDirection.BUY });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await service.execute('deal-1', manager);

    const calls = (prisma.tx.treasuryMovement.create as jest.Mock).mock.calls;
    const lydMovement = calls.find((c: any) => c[0].data.currencyId === 'cur-lyd')[0].data;
    expect(lydMovement.type).toBe('TRADE_BUY_SETTLEMENT');
    expect(lydMovement.amount).toBe('8000.00');
    // التحقق من اتجاه النقصان: 500000 (الافتتاحي) - 8000 = 492000
    const lydUpdateCall = (prisma.tx.treasuryPosition.update as jest.Mock).mock.calls.find(
      (c: any) => c[0].where.id === 'pos-lyd',
    );
    expect(lydUpdateCall[0].data.balance.toString()).toBe('492000');
  });

  it('يرفض تنفيذ صفقة شراء إن كان رصيد خزينة الدينار أقل من قيمة التسوية المطلوبة', async () => {
    const prisma = buildPrismaMockForExecute({
      direction: DealDirection.BUY,
      lydBalance: '100.00',
    });
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await expect(service.execute('deal-1', manager)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض التنفيذ إن لم تكن عملة الدينار الليبي مسجّلة في النظام', async () => {
    const prisma = buildPrismaMockForExecute({ lydCurrencyOverride: null } as any);
    const service = new DealsService(prisma, buildAudit(), buildWhatsApp());

    await expect(service.execute('deal-1', manager)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
