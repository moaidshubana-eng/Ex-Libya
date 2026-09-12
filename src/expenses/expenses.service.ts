import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MovementType, Prisma } from '@prisma/client';
import { ACCOUNT_CODES, EXPENSE_CATEGORY_ACCOUNT_CODE } from '../accounting/chart-of-accounts';
import { postJournalEntry } from '../accounting/post-journal-entry';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { applyMovement } from '../treasury/apply-movement';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { ListExpensesQuery } from './dto/list-expenses.query';
import { VoidExpenseDto } from './dto/void-expense.dto';

const EXPENSE_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  currency: { select: { id: true, code: true, name: true } },
  recordedBy: { select: { id: true, fullName: true, role: true } },
  voidedBy: { select: { id: true, fullName: true, role: true } },
} satisfies Prisma.ExpenseInclude;

// مصاريف تشغيل الشركة نفسها (رواتب، إيجار، خدمات...). منفصلة عن حركات
// خزينة العملاء افتراضيًا؛ لا تمسّ أي TreasuryMovement إلا إن طُلب صراحةً
// (paidFromTreasury) أن المصروف سُدِّد نقدًا من شبّاك الفرع.
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

    if (dto.paidFromTreasury && !dto.branchId) {
      throw new BadRequestException(
        'لازم تحدّد الفرع لخصم هذا المصروف من رصيد خزينته نقدًا (paidFromTreasury)',
      );
    }

    const expense = await this.prisma.$transaction(async (tx) => {
      // خصم اختياري فوري من رصيد خزينة الفرع — قبل إنشاء صف المصروف، فيرث المصروف
      // معرّف الحركة الناتجة مباشرة (بدل تحديثه في خطوة ثانية منفصلة).
      let treasuryMovementId: string | null = null;
      if (dto.paidFromTreasury) {
        const result = await applyMovement(tx, {
          branchId: dto.branchId!,
          currencyId: currency.id,
          currencyCode: currency.code,
          type: MovementType.WITHDRAWAL,
          amount: dto.amount,
          reason: `مصروف تشغيلي: ${dto.description}`,
          performedById: actor.id,
        });
        treasuryMovementId = result.movement.id;
      }

      const created = await tx.expense.create({
        data: {
          category: dto.category,
          amount: dto.amount,
          currencyId: currency.id,
          branchId: dto.branchId,
          description: dto.description,
          expenseDate: dto.expenseDate ? new Date(dto.expenseDate) : new Date(),
          recordedById: actor.id,
          paidFromTreasury: Boolean(dto.paidFromTreasury),
          treasuryMovementId,
        },
        include: EXPENSE_INCLUDE,
      });

      // ترحيل محاسبي: مدين حساب المصروف (حسب الفئة) دومًا؛ الطرف الدائن يختلف
      // حسب مصدر السداد — نقدًا من خزينة الفرع (تخفيض أصل)، أو ذمة دائنة معلَّقة
      // إن سُدِّد من مصدر خارجي لم يُسجَّل بعد في هذا النظام (تحويل بنكي مثلًا).
      await postJournalEntry(tx, {
        description: `مصروف تشغيلي: ${dto.description}`,
        sourceType: 'Expense',
        sourceId: created.id,
        postedById: actor.id,
        lines: [
          {
            accountCode: EXPENSE_CATEGORY_ACCOUNT_CODE[dto.category],
            debit: dto.amount,
            currencyId: currency.id,
            branchId: dto.branchId,
          },
          {
            accountCode: dto.paidFromTreasury
              ? ACCOUNT_CODES.TILL_CASH
              : ACCOUNT_CODES.EXPENSE_CLEARING_PAYABLE,
            credit: dto.amount,
            currencyId: currency.id,
            branchId: dto.branchId,
          },
        ],
      });

      return created;
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
        paidFromTreasury: expense.paidFromTreasury,
        treasuryMovementId: expense.treasuryMovementId,
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

  /**
   * لا حذف فعلي — يُعلَّم المصروف كملغى مع سبب موثّق. إن كان قد خُصم من الخزينة
   * عند تسجيله (paidFromTreasury)، يُعاد المبلغ إليها تلقائيًا (إيداع عكسي) ضمن
   * نفس المعاملة، فيبقى رصيد الخزينة متوافقًا دومًا مع المصاريف الفعّالة فقط.
   */
  async void(id: string, dto: VoidExpenseDto, actor: AuthenticatedUser) {
    const expense = await this.findOne(id);
    if (expense.isVoided) throw new ConflictException('هذا المصروف ملغى بالفعل');

    await this.prisma.$transaction(async (tx) => {
      if (expense.paidFromTreasury && expense.branchId) {
        await applyMovement(tx, {
          branchId: expense.branchId,
          currencyId: expense.currencyId,
          currencyCode: expense.currency.code,
          type: MovementType.DEPOSIT,
          amount: expense.amount,
          reason: `إلغاء مصروف تشغيلي (استرجاع): ${expense.description}`,
          performedById: actor.id,
        });
      }

      // عكس محاسبي مباشر بنفس المبلغ والحسابين المرحَّلين عند التسجيل، بمبادلة
      // المدين بالدائن — بلا حاجة لجلب القيد الأصلي، فتفاصيل عكسه معروفة من المصروف نفسه.
      await postJournalEntry(tx, {
        description: `إلغاء مصروف تشغيلي: ${expense.description} — ${dto.reason}`,
        sourceType: 'Expense',
        sourceId: expense.id,
        postedById: actor.id,
        lines: [
          {
            accountCode: EXPENSE_CATEGORY_ACCOUNT_CODE[expense.category],
            credit: expense.amount,
            currencyId: expense.currencyId,
            branchId: expense.branchId,
          },
          {
            accountCode: expense.paidFromTreasury
              ? ACCOUNT_CODES.TILL_CASH
              : ACCOUNT_CODES.EXPENSE_CLEARING_PAYABLE,
            debit: expense.amount,
            currencyId: expense.currencyId,
            branchId: expense.branchId,
          },
        ],
      });

      await tx.expense.update({
        where: { id },
        data: {
          isVoided: true,
          voidReason: dto.reason,
          voidedById: actor.id,
          voidedAt: new Date(),
        },
      });
    });

    await this.audit.record({
      entityType: 'Expense',
      entityId: id,
      action: 'VOID_EXPENSE',
      actorId: actor.id,
      before: { isVoided: false },
      after: { isVoided: true, reason: dto.reason, refundedToTreasury: expense.paidFromTreasury },
    });

    return this.findOne(id);
  }
}
