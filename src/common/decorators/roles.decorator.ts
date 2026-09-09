import { SetMetadata } from '@nestjs/common';
import { StaffRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** يقيّد مسارًا بمجموعة أدوار موظفين محددة؛ يُقرأ عبر RolesGuard. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);
