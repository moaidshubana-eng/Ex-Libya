/**
 * بيانات تجريبية لتشغيل النظام محليًا والتحقق من سلوكه: فرعان، عملات أساسية،
 * مستخدمون بكل الأدوار، مراكز خزينة ممولة، عملاء بحدود واقعية، وأول سعر صرف
 * منشور لكل عملة. تشغيل: npm run prisma:seed
 */
import { PrismaClient, StaffRole } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';

const prisma = new PrismaClient();

async function main() {
  console.log('بدء تعبئة البيانات التجريبية...');

  // ---- العملات ----
  const [lyd, usd, eur, egp, tnd] = await Promise.all([
    prisma.currency.upsert({
      where: { code: 'LYD' },
      update: {},
      create: { code: 'LYD', name: 'دينار ليبي', decimalPlaces: 3 },
    }),
    prisma.currency.upsert({
      where: { code: 'USD' },
      update: {},
      create: { code: 'USD', name: 'دولار أمريكي', decimalPlaces: 2 },
    }),
    prisma.currency.upsert({
      where: { code: 'EUR' },
      update: {},
      create: { code: 'EUR', name: 'يورو', decimalPlaces: 2 },
    }),
    prisma.currency.upsert({
      where: { code: 'EGP' },
      update: {},
      create: { code: 'EGP', name: 'جنيه مصري', decimalPlaces: 2 },
    }),
    prisma.currency.upsert({
      where: { code: 'TND' },
      update: {},
      create: { code: 'TND', name: 'دينار تونسي', decimalPlaces: 3 },
    }),
  ]);
  void lyd;

  // ---- الفروع ----
  const tripoli = await prisma.branch.upsert({
    where: { code: 'TRP-01' },
    update: {},
    create: { code: 'TRP-01', name: 'فرع طرابلس — شارع الجمهورية', city: 'طرابلس' },
  });
  const benghazi = await prisma.branch.upsert({
    where: { code: 'BEN-01' },
    update: {},
    create: { code: 'BEN-01', name: 'فرع بنغازي — شارع جمال عبدالناصر', city: 'بنغازي' },
  });

  // ---- المستخدمون ----
  const defaultPassword = await AuthService.hashPassword('ChangeMe123!');
  const usersData: Array<{ fullName: string; email: string; role: StaffRole; branchId?: string }> = [
    { fullName: 'مدير النظام', email: 'admin@exlibya.ly', role: StaffRole.ADMIN },
    {
      fullName: 'مدير الخزينة — طرابلس',
      email: 'treasury.manager@exlibya.ly',
      role: StaffRole.TREASURY_MANAGER,
      branchId: tripoli.id,
    },
    {
      fullName: 'صرّاف — فرع طرابلس',
      email: 'teller@exlibya.ly',
      role: StaffRole.TELLER,
      branchId: tripoli.id,
    },
    {
      fullName: 'مسؤول الامتثال',
      email: 'compliance@exlibya.ly',
      role: StaffRole.COMPLIANCE_OFFICER,
    },
    {
      fullName: 'خدمة العملاء',
      email: 'support@exlibya.ly',
      role: StaffRole.CUSTOMER_SERVICE,
    },
  ];

  const users: Record<string, { id: string }> = {};
  for (const u of usersData) {
    users[u.email] = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash: defaultPassword },
    });
  }
  const admin = users['admin@exlibya.ly'];

  // ---- مراكز الخزينة (تُفعَّل بسقف تعرّض وحد أدنى، ثم تُموَّل بحركة إيداع أولى) ----
  const positionsToFund: Array<{ branchId: string; currency: typeof usd; maxExposure: string; minThreshold: string; openingBalance: string }> = [
    { branchId: tripoli.id, currency: usd, maxExposure: '500000.00', minThreshold: '20000.00', openingBalance: '184600.00' },
    { branchId: tripoli.id, currency: eur, maxExposure: '250000.00', minThreshold: '10000.00', openingBalance: '62140.00' },
    { branchId: benghazi.id, currency: usd, maxExposure: '300000.00', minThreshold: '15000.00', openingBalance: '96000.00' },
  ];

  for (const p of positionsToFund) {
    const position = await prisma.treasuryPosition.upsert({
      where: { branchId_currencyId: { branchId: p.branchId, currencyId: p.currency.id } },
      update: {},
      create: {
        branchId: p.branchId,
        currencyId: p.currency.id,
        maxExposure: p.maxExposure,
        minThreshold: p.minThreshold,
        balance: 0,
      },
    });

    const alreadyFunded = await prisma.treasuryMovement.findFirst({
      where: { branchId: p.branchId, currencyId: p.currency.id },
    });
    if (!alreadyFunded) {
      await prisma.treasuryMovement.create({
        data: {
          branchId: p.branchId,
          currencyId: p.currency.id,
          type: 'DEPOSIT',
          amount: p.openingBalance,
          balanceAfter: p.openingBalance,
          reason: 'رصيد افتتاحي عند تشغيل النظام',
          performedById: admin.id,
        },
      });
      await prisma.treasuryPosition.update({
        where: { id: position.id },
        data: { balance: p.openingBalance },
      });
    }
  }

  // ---- أول سعر صرف منشور لكل عملة أجنبية (رسمي + موازٍ) ----
  const openingRates: Array<{ currency: typeof usd; officialRate: string; parallelRate: string }> = [
    { currency: usd, officialRate: '4.850000', parallelRate: '7.900000' },
    { currency: eur, officialRate: '5.240000', parallelRate: '8.550000' },
    { currency: egp, officialRate: '0.098000', parallelRate: '0.158000' },
    { currency: tnd, officialRate: '1.580000', parallelRate: '2.550000' },
  ];
  for (const r of openingRates) {
    const exists = await prisma.exchangeRate.findFirst({ where: { currencyId: r.currency.id } });
    if (!exists) {
      await prisma.exchangeRate.create({
        data: {
          currencyId: r.currency.id,
          officialRate: r.officialRate,
          parallelRate: r.parallelRate,
          source: 'MANUAL',
          publishedById: admin.id,
        },
      });
    }
  }

  // ---- عملاء تجريبيون ----
  await prisma.client.upsert({
    where: { nationalIdOrReg: 'CR-2019-004471' },
    update: {},
    create: {
      fullName: 'شركة الوفاء للاستيراد والتصدير',
      clientType: 'company',
      nationalIdOrReg: 'CR-2019-004471',
      phone: '+218911234567',
      address: 'طرابلس — منطقة الظهرة',
      kycStatus: 'VERIFIED',
      riskTier: 'MEDIUM',
      dailyLimitUsd: '120000.00',
      creditLimitUsd: '400000.00',
      whatsappOptIn: true,
    },
  });

  await prisma.client.upsert({
    where: { nationalIdOrReg: '119850123456' },
    update: {},
    create: {
      fullName: 'محمد عبدالسلام الفيتوري',
      clientType: 'individual',
      nationalIdOrReg: '119850123456',
      phone: '+218921112233',
      kycStatus: 'VERIFIED',
      riskTier: 'LOW',
      dailyLimitUsd: '15000.00',
      creditLimitUsd: '30000.00',
      whatsappOptIn: true,
    },
  });

  console.log('اكتملت تعبئة البيانات التجريبية.');
  console.log('بيانات دخول تجريبية لكل الأدوار — كلمة المرور: ChangeMe123!');
  usersData.forEach((u) => console.log(`  ${u.role.padEnd(18)} ${u.email}`));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
