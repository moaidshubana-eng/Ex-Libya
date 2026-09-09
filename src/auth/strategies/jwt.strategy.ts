import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../types/authenticated-user.type';

interface JwtPayload {
  sub: string;
  email: string;
  role: AuthenticatedUser['role'];
  branchId: string | null;
  mfaEnabled: boolean;
  /** موجودة فقط في رمز تحدّي المصادقة الثنائية القصير الأجل — لا يصدر أبدًا من هنا. */
  mfaChallenge?: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret')!,
    });
  }

  // القيمة المُعادة هنا تُرفَق تلقائيًا بـ request.user من طرف Passport
  validate(payload: JwtPayload): AuthenticatedUser {
    // رمز تحدّي المصادقة الثنائية (mfaChallenge) موقّع بنفس السرّ لكنه ليس رمز
    // وصول: لا يحمل صلاحيات، ويُرفض صراحة هنا حتى لا يُستخدم لأي مسار محمي.
    if (payload.mfaChallenge) {
      throw new UnauthorizedException(
        'رمز تحدّي المصادقة الثنائية لا يصلح للوصول إلى الواجهة البرمجية',
      );
    }
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      branchId: payload.branchId,
      mfaEnabled: payload.mfaEnabled,
    };
  }
}
