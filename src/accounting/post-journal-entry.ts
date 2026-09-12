import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toMoney } from '../common/money';

/** الحد الأدنى من عمليات Prisma التي يحتاجها ترحيل قيد — يقبل عميل Prisma العادي أو عميل معاملة (tx). */
export interface JournalTxClient {
  account: Pick<Prisma.AccountDelegate, 'findUnique'>;
  journalEntry: Pick<Prisma.JournalEntryDelegate, 'create'>;
}

export interface JournalLineInput {
  accountCode: string;
  debit?: Prisma.Decimal.Value;
  credit?: Prisma.Decimal.Value;
  currencyId: string;
  branchId?: string | null;
  memo?: string;
}

/** يبادل المدين بالدائن في كل سطر — أداة عامة لبناء عكس أي مجموعة سطور قيد. */
export function flipDebitCredit(lines: JournalLineInput[]): JournalLineInput[] {
  return lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit }));
}

export interface PostJournalEntryInput {
  description: string;
  entryDate?: Date;
  sourceType?: string;
  sourceId?: string;
  reversalOfId?: string;
  postedById: string;
  lines: JournalLineInput[];
}

/**
 * القلب المشترك لترحيل أي قيد يومية — يتحقق من توازن كل عملة على حدة (لا
 * يكفي أن يتساوى إجمالي المدين والدائن إجمالًا عبر عملات مختلفة؛ ذلك لا يعني
 * شيئًا محاسبيًا)، يتأكد من وجود كل حساب ونشاطه، ثم يُنشئ القيد وسطوره ضمن
 * معاملة واحدة (tx) يوفّرها المستدعي. لا يُستخدم لصفقات تبديل عملة بعملة
 * أخرى (TRADE_BUY/TRADE_SELL) — تلك تتطلب نموذج ترجمة عملات لا يدعمه هذا
 * الدفتر بعد (انظر ملاحظة الفجوة في README).
 */
export async function postJournalEntry(tx: JournalTxClient, input: PostJournalEntryInput) {
  if (input.lines.length < 2) {
    throw new BadRequestException('القيد يتطلب سطرين على الأقل');
  }

  const byCurrency = new Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>();
  const resolvedLines: {
    accountId: string;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    currencyId: string;
    branchId?: string | null;
    memo?: string;
  }[] = [];

  for (const line of input.lines) {
    const debit = toMoney(line.debit ?? 0);
    const credit = toMoney(line.credit ?? 0);

    if (debit.isNegative() || credit.isNegative()) {
      throw new BadRequestException('لا يُقبل مبلغ سالب في أي سطر قيد');
    }
    if (debit.isZero() && credit.isZero()) {
      throw new BadRequestException('كل سطر قيد يجب أن يحمل قيمة مدينة أو دائنة (لا كلاهما صفر)');
    }
    if (!debit.isZero() && !credit.isZero()) {
      throw new BadRequestException('لا يُقبل أن يحمل السطر الواحد قيمة مدينة ودائنة معًا');
    }

    const account = await tx.account.findUnique({ where: { code: line.accountCode } });
    if (!account)
      throw new NotFoundException(`الحساب ${line.accountCode} غير موجود في شجرة الحسابات`);
    if (!account.isActive) {
      throw new BadRequestException(`الحساب ${line.accountCode} (${account.name}) غير مفعّل`);
    }

    const totals = byCurrency.get(line.currencyId) ?? { debit: toMoney(0), credit: toMoney(0) };
    totals.debit = totals.debit.plus(debit);
    totals.credit = totals.credit.plus(credit);
    byCurrency.set(line.currencyId, totals);

    resolvedLines.push({
      accountId: account.id,
      debit,
      credit,
      currencyId: line.currencyId,
      branchId: line.branchId,
      memo: line.memo,
    });
  }

  for (const [currencyId, totals] of byCurrency) {
    if (!totals.debit.equals(totals.credit)) {
      throw new BadRequestException(
        `القيد غير متوازن للعملة ${currencyId}: مدين ${totals.debit.toFixed(2)} ≠ دائن ${totals.credit.toFixed(2)}`,
      );
    }
  }

  const entry = await tx.journalEntry.create({
    data: {
      description: input.description,
      entryDate: input.entryDate ?? new Date(),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reversalOfId: input.reversalOfId,
      postedById: input.postedById,
      lines: { create: resolvedLines },
    },
    include: { lines: { include: { account: true, currency: true, branch: true } } },
  });

  return entry;
}
