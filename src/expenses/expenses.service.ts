import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { VoidExpenseDto } from './dto/void-expense.dto';

const EXPENSE_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  currency: { select: { id: true, code: true, name: true } },
  recordedBy: { select: { id: true, fullName: true, role: true } },
  voidedBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.ExpenseInclude;

// مصاريف تشغيل الشركة نفسها (رواتب، إيجار، خدمات...) — منفصلة تمامًا عن
// حركات خزينة العملاء (TreasuryService)؛ لا تُنشئ أو تعدّل أي TreasuryMovement.
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(dto: CreateExpenseDto, actor: AuthenticatedUser) {
    if (dto.branchId) {
      const branch = await this.prisma.branch.findUnique({ where: { id: dto.branchId } });
      if (!branch) throw new NotFoundException('الفرع غير موجود');
    }

    const currency = await this.prisma.currency.findUnique({
      where: { code: dto.currencyCode.toUpperCase() },
    });
    if (!currency || !currency.isActive) {
      throw new NotFoundException(`العملة ${dto.currencyCode} غير مسجّلة أو غير مفعّلة`);
    }

    const expense = await this.prisma.expense.create({
      data: {
        category: dto.category,
        amount: dto.amount,
        currencyId: currency.id,
        branchId: dto.branchId,
        description: dto.description,
        expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : new Date(),
        recordedById: actor.id,
      },
      include: EXPENSE_INCLUDE,
    });

    await this.audit.record({
      entityType: 'Expense',
      entityId: expense.id,
      action: 'CREATE_EXPENSE',
      actorId: actor.id,
      after: {
        category: expense.category,
        amount: expense.amount.toString(),
        currency: currency.code,
        description: expense.description,
        branchId: expense.branchId,
      },
    });

    return expense;
  }

  async findAll(query: ListExpensesQuery) {
    const where: Prisma.ExpenseWhereInput = {
      ...(query.category && { category: query.category }),
      ...(query.branchId && { branchId: query.branchId }),
      ...(!query.includeVoided && { isVoided: false }),
      ...((query.from || query.to) && {
        expenseDate: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.expense.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { expenseDate: 'desc' },
        include: EXPENSE_INCLUDE,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: EXPENSE_INCLUDE,
    });
    if (!expense) throw new NotFoundException('المصروف غير موجود');
    return expense;
  }

  /** لا حذف فعلي — يُعلَّم المصروف كملغى مع سبب موثّق، فيبقى أثره في السجل والتدقيق. */
  async void(id: string, dto: VoidExpenseDto, actor: AuthenticatedUser) {
    const expense = await this.findOne(id);
    if (expense.isVoided) throw new ConflictException('هذا المصروف ملغى بالفعل');

    await this.prisma.expense.update({
      where: { id },
      data: { isVoided: true, voidReason: dto.reason, voidedById: actor.id, voidedAt: new Date() },
    });

    await this.audit.record({
      entityType: 'Expense',
      entityId: id,
      action: 'VOID_EXPENSE',
      actorId: actor.id,
      before: { isVoided: false },
      after: { isVoided: true, reason: dto.reason },
    });

    return this.findOne(id);
  }
}
