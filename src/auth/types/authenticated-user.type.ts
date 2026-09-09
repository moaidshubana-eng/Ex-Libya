import { StaffRole } from '@prisma/client';

/**
 * الشكل المرفَق بـ request.user بعد التحقق من JWT. mfaEnabled لقطة من لحظة
 * إصدار الرمز — تفعيل أو تعطيل المصادقة الثنائية لاحقًا لا ينعكس إلا بعد
 * تسجيل دخول جديد (اقتضاء طبيعي لكون JWT عديم الحالة).
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
  mfaEnabled: boolean;
}
