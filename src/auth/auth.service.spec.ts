import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { StaffRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { encryptMfaSecret } from './mfa/secret-crypto';
import { generateTotpCode, generateTotpSecret } from './mfa/totp';

const MFA_KEY = '2f1c9a4e7b6d3f0851a2c4e6b8d0f2a41c3e5a7b9d1f3042c5e7a9b1d3f5062e';

function buildConfig() {
  const values: Record<string, string> = {
    'mfa.encryptionKey': MFA_KEY,
    'mfa.issuer': 'ExLibya',
    'mfa.challengeTokenExpiresIn': '5m',
  };
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function buildJwtService() {
  // JwtService حقيقي بمعزل عن Nest DI — يعطي إصدار/تحقق JWT فعليين لا وهميين
  return new JwtService({ secret: 'test-jwt-secret', signOptions: { expiresIn: '8h' } });
}

interface MutableUser {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  role: StaffRole;
  branchId: string | null;
  isActive: boolean;
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
  mfaRecoveryCodeHashes: string[];
}

async function buildUser(overrides: Partial<MutableUser> = {}): Promise<MutableUser> {
  return {
    id: 'user-1',
    fullName: 'مدير الخزينة',
    email: 'manager@exlibya.ly',
    passwordHash: await argon2.hash('ChangeMe123!'),
    role: StaffRole.TREASURY_MANAGER,
    branchId: null,
    isActive: true,
    mfaEnabled: false,
    mfaSecretEncrypted: null,
    mfaRecoveryCodeHashes: [],
    ...overrides,
  };
}

/** عميل Prisma وهمي يعكس حالة مستخدم متغيّرة عبر الاستدعاءات المتتالية ضمن اختبار واحد. */
function buildPrismaMock(state: MutableUser) {
  return {
    user: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...state })),
      findUniqueOrThrow: jest.fn().mockImplementation(() => Promise.resolve({ ...state })),
      update: jest.fn().mockImplementation(({ data }: any) => {
        Object.assign(state, data);
        return Promise.resolve({ ...state });
      }),
    },
  } as unknown as PrismaService;
}

function buildAudit() {
  return { record: jest.fn() } as unknown as AuditService;
}

describe('AuthService.login', () => {
  it('يعيد رمز وصول مباشرة لحساب بلا مصادقة ثنائية', async () => {
    const user = await buildUser({ mfaEnabled: false });
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    const result = await service.login({ email: user.email, password: 'ChangeMe123!' });

    expect(result.mfaRequired).toBe(false);
    expect((result as any).accessToken).toBeDefined();
  });

  it('يعيد رمز تحدّي بدل رمز وصول لحساب مفعّل عليه المصادقة الثنائية', async () => {
    const user = await buildUser({ mfaEnabled: true, mfaSecretEncrypted: 'irrelevant' });
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    const result = await service.login({ email: user.email, password: 'ChangeMe123!' });

    expect(result.mfaRequired).toBe(true);
    expect((result as any).mfaChallengeToken).toBeDefined();
    expect((result as any).accessToken).toBeUndefined();
  });

  it('يرفض كلمة مرور خاطئة', async () => {
    const user = await buildUser();
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    await expect(
      service.login({ email: user.email, password: 'WrongPassword1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService — إعداد وتأكيد المصادقة الثنائية', () => {
  it('setupMfa يرفض إن كانت المصادقة الثنائية مفعّلة مسبقًا', async () => {
    const user = await buildUser({ mfaEnabled: true });
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    await expect(service.setupMfa(user.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('دورة كاملة: setupMfa ثم confirmMfa بنجاح تفعّل المصادقة وتولّد رموز استرداد', async () => {
    const user = await buildUser({ mfaEnabled: false });
    const prisma = buildPrismaMock(user);
    const audit = buildAudit();
    const service = new AuthService(prisma, buildJwtService(), audit, buildConfig());

    const { secret } = await service.setupMfa(user.id);
    const code = generateTotpCode(secret);
    const { recoveryCodes } = await service.confirmMfa(user.id, { code });

    expect(user.mfaEnabled).toBe(true); // الحالة الوهمية تحدّثت فعليًا عبر prisma.user.update
    expect(recoveryCodes).toHaveLength(8);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ENABLE_MFA' }));
  });

  it('confirmMfa يرفض رمزًا خاطئًا', async () => {
    const user = await buildUser({ mfaEnabled: false });
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    await service.setupMfa(user.id);
    await expect(service.confirmMfa(user.id, { code: '000000' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AuthService.verifyMfa (الخطوة الثانية من تسجيل الدخول)', () => {
  async function setupEnabledUser() {
    const secret = generateTotpSecret();
    const recoveryCode = 'ABCDE-FGHJK';
    const user = await buildUser({
      mfaEnabled: true,
      mfaSecretEncrypted: encryptMfaSecret(secret, MFA_KEY),
      mfaRecoveryCodeHashes: [await argon2.hash(recoveryCode)],
    });
    return { user, secret, recoveryCode };
  }

  it('يصدر رمز وصول عند إدخال رمز TOTP صحيح', async () => {
    const { user, secret } = await setupEnabledUser();
    const jwtService = buildJwtService();
    const service = new AuthService(buildPrismaMock(user), jwtService, buildAudit(), buildConfig());

    const login = await service.login({ email: user.email, password: 'ChangeMe123!' });
    const result = await service.verifyMfa({
      mfaChallengeToken: (login as any).mfaChallengeToken,
      code: generateTotpCode(secret),
    });

    expect(result.accessToken).toBeDefined();
  });

  it('يقبل رمز استرداد صحيحًا مرة واحدة، ثم يرفضه في المرة الثانية', async () => {
    const { user, recoveryCode } = await setupEnabledUser();
    const jwtService = buildJwtService();
    const service = new AuthService(buildPrismaMock(user), jwtService, buildAudit(), buildConfig());

    const login = await service.login({ email: user.email, password: 'ChangeMe123!' });
    const challenge = (login as any).mfaChallengeToken;

    const first = await service.verifyMfa({ mfaChallengeToken: challenge, code: recoveryCode });
    expect(first.accessToken).toBeDefined();
    expect(user.mfaRecoveryCodeHashes).toHaveLength(0); // استُهلك رمز الاسترداد

    await expect(
      service.verifyMfa({ mfaChallengeToken: challenge, code: recoveryCode }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('يرفض رمزًا خاطئًا', async () => {
    const { user } = await setupEnabledUser();
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    const login = await service.login({ email: user.email, password: 'ChangeMe123!' });
    await expect(
      service.verifyMfa({ mfaChallengeToken: (login as any).mfaChallengeToken, code: '000000' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('يرفض رمز تحدّي غير صالح', async () => {
    const { user } = await setupEnabledUser();
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    await expect(
      service.verifyMfa({ mfaChallengeToken: 'not-a-real-token', code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('يرفض رمز وصول عادي (غير رمز تحدّي) كرمز تحدّي — لا يمكن تجاوز المصادقة الثنائية برمز وصول مسرّب', async () => {
    const { user } = await setupEnabledUser();
    const jwtService = buildJwtService();
    const service = new AuthService(buildPrismaMock(user), jwtService, buildAudit(), buildConfig());

    const normalAccessToken = await jwtService.signAsync({ sub: user.id, email: user.email });
    await expect(
      service.verifyMfa({ mfaChallengeToken: normalAccessToken, code: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService.disableMfa', () => {
  it('يرفض إن كانت المصادقة الثنائية غير مفعّلة أصلًا', async () => {
    const user = await buildUser({ mfaEnabled: false });
    const service = new AuthService(
      buildPrismaMock(user),
      buildJwtService(),
      buildAudit(),
      buildConfig(),
    );

    await expect(service.disableMfa(user.id, { code: '123456' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('يعطّل المصادقة الثنائية ويمسح السرّ ورموز الاسترداد عند إدخال رمز صحيح', async () => {
    const secret = generateTotpSecret();
    const user = await buildUser({
      mfaEnabled: true,
      mfaSecretEncrypted: encryptMfaSecret(secret, MFA_KEY),
    });
    const audit = buildAudit();
    const service = new AuthService(buildPrismaMock(user), buildJwtService(), audit, buildConfig());

    await service.disableMfa(user.id, { code: generateTotpCode(secret) });

    expect(user.mfaEnabled).toBe(false);
    expect(user.mfaSecretEncrypted).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISABLE_MFA' }));
  });
});
