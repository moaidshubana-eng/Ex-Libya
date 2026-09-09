import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';

interface RecordAuditInput {
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * كل عملية حساسة في النظام (إنشاء عميل، تعديل حدود، نشر سعر، حركة خزينة)
 * يجب أن تستدعي AuditService.record بعد نجاحها. السجل تراكمي فقط: لا يوجد
 * في هذه الوحدة أي دالة تعديل أو حذف عمدًا.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput) {
    await this.prisma.auditLog.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actorId,
        before: input.before === undefined ? undefined : (input.before as any),
        after: input.after === undefined ? undefined : (input.after as any),
      },
    });
  }

  async findForEntity(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { id: true, fullName: true, role: true } } },
    });
  }

  /** سجل التدقيق الكامل عبر النظام — لمن يحتاج تتبّع "من فعل ماذا ومتى" بلا معرفة سجل بعينه مسبقًا. */
  async findAll(query: ListAuditLogsQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.entityType && { entityType: query.entityType }),
      ...(query.entityId && { entityId: query.entityId }),
      ...(query.actorId && { actorId: query.actorId }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { id: true, fullName: true, role: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }
}
