import { SetMetadata } from '@nestjs/common';

export const REQUIRE_MFA_KEY = 'requireMfa';

/**
 * يعلّم مسارًا كإجراء حسّاس يستوجب تفعيل مصادقة ثنائية للمستخدم قبل تنفيذه —
 * مثل نشر سعر يدويًا أو اعتماد صفقة كبيرة. يُقرأ عبر MfaGuard.
 */
export const RequireMfa = () => SetMetadata(REQUIRE_MFA_KEY, true);
