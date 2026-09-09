import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildOtpAuthUrl, generateTotpSecret, verifyTotpCode } from './mfa/totp';
import { decryptMfaSecret, encryptMfaSecret } from './mfa/secret-crypto';
import { generateRecoveryCodes } from './mfa/recovery-codes';
import { ConfirmMfaDto } from './dto/confirm-mfa.dto';
import { DisableMfaDto } from './dto/disable-mfa.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyMfaDto } from './dto/verify-mfa.dto';

interface MfaCodeCheckResult {
  valid: boolean;
  /** مُعرَّف عبر تجزئته إن كان الرمز الصحيح المُستخدَم أحد رموز الاسترداد — يُستهلك مرة واحدة. */
  consumedRecoveryCodeHash?: string;
}

@Injectable()
export class AuthService {
  private readonly mfaEncryptionKey: string;
  private readonly mfaIssuer: string;
  private readonly mfaChallengeExpiresIn: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.mfaEncryptionKey = config.get<string>('mfa.encryptionKey')!;
    this.mfaIssuer = config.get<string>('mfa.issuer')!;
    this.mfaChallengeExpiresIn = config.get<string>('mfa.challengeTokenExpiresIn')!;
  }

  private invalidCredentials() {
    // رسالة خطأ موحّدة سواء كان البريد غير موجود أو كلمة المرور خاطئة،
    // لتفادي كشف ما إذا كان البريد الإلكتروني مسجّلًا في النظام.
    return new UnauthorizedException('البريد الإلكتروني أو كلمة المرور غير صحيحة');
  }

  private async issueAccessToken(user: User) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      branchId: user.branchId,
      mfaEnabled: user.mfaEnabled,
    };
    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        branchId: user.branchId,
        mfaEnabled: user.mfaEnabled,
      },
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !user.isActive) throw this.invalidCredentials();

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) throw this.invalidCredentials();

    if (user.mfaEnabled) {
      // لا يُصدَر رمز وصول بعد — رمز تحدّي قصير الأجل فقط، يُستبدَل برمز وصول
      // كامل بعد التحقق من TOTP عبر verifyMfa. لا يحمل صلاحيات API (انظر JwtStrategy).
      const mfaChallengeToken = await this.jwtService.signAsync(
        { sub: user.id, mfaChallenge: true },
        { expiresIn: this.mfaChallengeExpiresIn },
      );
      return { mfaRequired: true as const, mfaChallengeToken };
    }

    return { mfaRequired: false as const, ...(await this.issueAccessToken(user)) };
  }

  async verifyMfa(dto: VerifyMfaDto) {
    let subjectId: string;
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string; mfaChallenge?: boolean }>(
        dto.mfaChallengeToken,
      );
      if (!payload.mfaChallenge) throw new Error('not a challenge token');
      subjectId = payload.sub;
    } catch {
      throw new UnauthorizedException('رمز تحدّي المصادقة الثنائية غير صالح أو منتهي الصلاحية');
    }

    const user = await this.prisma.user.findUnique({ where: { id: subjectId } });
    if (!user || !user.isActive || !user.mfaEnabled) throw this.invalidCredentials();

    const check = await this.checkMfaCode(user, dto.code);
    if (!check.valid) throw new UnauthorizedException('رمز التحقق غير صحيح');

    if (check.consumedRecoveryCodeHash) {
      await this.consumeRecoveryCode(user.id, check.consumedRecoveryCodeHash);
    }

    return this.issueAccessToken(user);
  }

  /** يبدأ إعداد مصادقة ثنائية جديدة: يولّد سرًّا مؤقتًا لا يُفعَّل إلا بعد تأكيده (confirmMfa). */
  async setupMfa(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled) {
      throw new ConflictException(
        'المصادقة الثنائية مفعّلة مسبقًا على هذا الحساب — عطّلها أولًا لإعادة الإعداد',
      );
    }

    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecretEncrypted: encryptMfaSecret(secret, this.mfaEncryptionKey) },
    });

    return {
      secret,
      otpAuthUrl: buildOtpAuthUrl({
        secretBase32: secret,
        accountEmail: user.email,
        issuer: this.mfaIssuer,
      }),
    };
  }

  /** يؤكّد الإعداد بإدخال أول رمز صحيح من التطبيق، ويفعّل المصادقة الثنائية، ويولّد رموز استرداد. */
  async confirmMfa(userId: string, dto: ConfirmMfaDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabled || !user.mfaSecretEncrypted) {
      throw new ConflictException(
        'لا يوجد إعداد مصادقة ثنائية معلَّق بانتظار التأكيد على هذا الحساب',
      );
    }

    const secret = decryptMfaSecret(user.mfaSecretEncrypted, this.mfaEncryptionKey);
    if (!verifyTotpCode(secret, dto.code)) {
      throw new UnauthorizedException('رمز التحقق غير صحيح');
    }

    const recoveryCodes = generateRecoveryCodes();
    const recoveryCodeHashes = await Promise.all(
      recoveryCodes.map((code) => AuthService.hashPassword(code)),
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaRecoveryCodeHashes: recoveryCodeHashes },
    });

    await this.audit.record({
      entityType: 'User',
      entityId: userId,
      action: 'ENABLE_MFA',
      actorId: userId,
    });

    // آخر لحظة تظهر فيها رموز الاسترداد كنص صريح — لا تُخزَّن إلا مُجزَّأة.
    return { recoveryCodes };
  }

  async disableMfa(userId: string, dto: DisableMfaDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabled) {
      throw new ConflictException('المصادقة الثنائية غير مفعّلة أصلًا على هذا الحساب');
    }

    const check = await this.checkMfaCode(user, dto.code);
    if (!check.valid) throw new UnauthorizedException('رمز التحقق غير صحيح');

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaRecoveryCodeHashes: [] },
    });

    await this.audit.record({
      entityType: 'User',
      entityId: userId,
      action: 'DISABLE_MFA',
      actorId: userId,
    });
  }

  private async checkMfaCode(user: User, candidateCode: string): Promise<MfaCodeCheckResult> {
    if (user.mfaSecretEncrypted) {
      const secret = decryptMfaSecret(user.mfaSecretEncrypted, this.mfaEncryptionKey);
      if (verifyTotpCode(secret, candidateCode)) return { valid: true };
    }

    for (const hash of user.mfaRecoveryCodeHashes) {
      if (await argon2.verify(hash, candidateCode)) {
        return { valid: true, consumedRecoveryCodeHash: hash };
      }
    }

    return { valid: false };
  }

  private async consumeRecoveryCode(userId: string, usedHash: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaRecoveryCodeHashes: user.mfaRecoveryCodeHashes.filter((hash) => hash !== usedHash),
      },
    });
  }

  static async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain);
  }
}
