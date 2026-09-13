import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StaffRole } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { ResetUserPasswordDto } from './dto/reset-user-password.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

// لا يُعاد passwordHash ولا حقول المصادقة الثنائية الحسّاسة (mfaSecretEncrypted،
// mfaRecoveryCodeHashes) في أي استجابة من هذه الوحدة إطلاقًا — select صريح دومًا.
const SAFE_USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  branchId: true,
  isActive: true,
  mfaEnabled: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.UserSelect;

// وحدة إدارة المستخدمين — مقصورة بالكامل على ADMIN (انظر UsersController). كل
// عملية حسّاسة (إنشاء، تغيير دور، تعطيل، إعادة تعيين كلمة مرور) تُسجَّل في
// سجل التدقيق. حراسة صريحة ضد قفل النظام: لا يجوز لمستخدم تعديل حالته أو دوره
// بنفسه، ولا تعطيل/تنحية آخر ADMIN فعّال في النظام.
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async getBranchOrThrow(branchId: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw new NotFoundException('الفرع غير موجود');
    return branch;
  }

  /** يرفض العملية إن كان المستخدم الهدف آخر ADMIN فعّال — تجنّبًا لقفل النظام بلا أي مدير. */
  private async assertNotLastActiveAdmin(target: {
    id: string;
    role: StaffRole;
    isActive: boolean;
  }) {
    if (target.role !== StaffRole.ADMIN || !target.isActive) return;
    const otherActiveAdmins = await this.prisma.user.count({
      where: { role: StaffRole.ADMIN, isActive: true, id: { not: target.id } },
    });
    if (otherActiveAdmins === 0) {
      throw new ConflictException(
        'هذا الحساب آخر مدير نظام (ADMIN) فعّال — لا يمكن تعطيله أو تغيير دوره حتى تعيّن مديرًا آخر أولًا',
      );
    }
  }

  async create(dto: CreateUserDto, actor: AuthenticatedUser) {
    if (dto.branchId) await this.getBranchOrThrow(dto.branchId);

    const passwordHash = await AuthService.hashPassword(dto.password);
    try {
      const user = await this.prisma.user.create({
        data: {
          fullName: dto.fullName,
          email: dto.email,
          passwordHash,
          role: dto.role,
          branchId: dto.branchId,
        },
        select: SAFE_USER_SELECT,
      });

      await this.audit.record({
        entityType: 'User',
        entityId: user.id,
        action: 'CREATE_USER',
        actorId: actor.id,
        after: {
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          branchId: user.branchId,
        },
      });

      return user;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new ConflictException('يوجد مستخدم مسجَّل مسبقًا بنفس البريد الإلكتروني');
      }
      throw error;
    }
  }

  async findAll(query: ListUsersQuery, isActive?: boolean) {
    const where: Prisma.UserWhereInput = {
      ...(query.role && { role: query.role }),
      ...(isActive !== undefined && { isActive }),
      ...(query.search && {
        OR: [
          { fullName: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: SAFE_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_USER_SELECT });
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    return user;
  }

  async updateRole(id: string, dto: UpdateUserRoleDto, actor: AuthenticatedUser) {
    if (id === actor.id) {
      throw new ForbiddenException('لا يجوز لك تعديل دورك الوظيفي بنفسك — اطلب من مدير نظام آخر');
    }
    const before = await this.findOne(id);
    if (dto.branchId) await this.getBranchOrThrow(dto.branchId);
    if (dto.role !== StaffRole.ADMIN) {
      await this.assertNotLastActiveAdmin(before);
    }

    const after = await this.prisma.user.update({
      where: { id },
      data: { role: dto.role, branchId: dto.branchId ?? null },
      select: SAFE_USER_SELECT,
    });

    await this.audit.record({
      entityType: 'User',
      entityId: id,
      action: 'UPDATE_USER_ROLE',
      actorId: actor.id,
      before: { role: before.role, branchId: before.branchId },
      after: { role: after.role, branchId: after.branchId, reason: dto.reason },
    });

    return after;
  }

  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    if (id === actor.id) {
      throw new ForbiddenException('لا يجوز لك تعطيل حسابك أنت بنفسك — اطلب من مدير نظام آخر');
    }
    const before = await this.findOne(id);
    if (!isActive) {
      await this.assertNotLastActiveAdmin(before);
    }

    const after = await this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: SAFE_USER_SELECT,
    });

    await this.audit.record({
      entityType: 'User',
      entityId: id,
      action: isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
      actorId: actor.id,
      before: { isActive: before.isActive },
      after: { isActive: after.isActive },
    });

    return after;
  }

  async resetPassword(id: string, dto: ResetUserPasswordDto, actor: AuthenticatedUser) {
    await this.findOne(id);
    const passwordHash = await AuthService.hashPassword(dto.newPassword);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });

    await this.audit.record({
      entityType: 'User',
      entityId: id,
      action: 'RESET_USER_PASSWORD',
      actorId: actor.id,
      after: { reason: dto.reason },
    });

    return { success: true };
  }
}
