/**
 * محاكاة دنيا لعميل Prisma (tx) لدفتر الأستاذ — تُستخدم في اختبارات وحدات
 * أخرى (المصاريف، الخزينة، الحوالات، العملاء) التي رحّلت الآن قيودًا محاسبية
 * ضمن نفس معاملتها. account.findUnique تُرجع حسابًا نشطًا وهميًا لأي رمز
 * يُستعلَم عنه (لا تتحقق من شجرة الحسابات الحقيقية)، وjournalEntry.create
 * تُرجع القيد بسطوره كما أُرسلت، لإتاحة التحقق من محتوى الترحيل عند الحاجة.
 */
export function buildLedgerMockDelegates() {
  return {
    account: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { code: string } }) =>
        Promise.resolve({
          id: 'acc-' + where.code,
          code: where.code,
          name: 'حساب ' + where.code,
          isActive: true,
          normalBalance:
            where.code.startsWith('2') || where.code.startsWith('3') || where.code.startsWith('4')
              ? 'CREDIT'
              : 'DEBIT',
        }),
      ),
    },
    journalEntry: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        const lines = (data.lines?.create ?? []).map((l: any, i: number) => ({
          id: `jl-${i}`,
          ...l,
          account: { code: l.accountId.replace(/^acc-/, '') },
          currency: { code: l.currencyId },
          branch: l.branchId ? { id: l.branchId } : null,
        }));
        return Promise.resolve({ id: 'je-1', ...data, lines });
      }),
    },
  };
}
