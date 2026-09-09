import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_MFA_KEY } from '../decorators/require-mfa.decorator';
import { AuthenticatedUser } from '../../auth/types/authenticated-user.type';

/**
 * يفرض تفعيل مصادقة ثنائية (TOTP) على مسارات @RequireMfa() — نشر الأسعار
 * واعتماد الصفقات الكبيرة حاليًا. حالة mfaEnabled مأخوذة من رمز JWT نفسه
 * (لقطة وقت تسجيل الدخول)؛ لا تستدعي قاعدة البيانات في كل طلب.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (!user?.mfaEnabled) {
      throw new ForbiddenException(
        'هذا الإجراء يستوجب تفعيل مصادقة ثنائية (TOTP) على حسابك أولًا — راجع /auth/mfa/setup',
      );
    }
    return true;
  }
}
