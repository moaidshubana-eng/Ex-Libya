import { StaffRole } from '@prisma/client';

/** الشكل المرفَق بـ request.user بعد التحقق من JWT. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
}
