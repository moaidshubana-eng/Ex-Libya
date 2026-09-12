import { BadRequestException, NotFoundException } from '@nestjs/common';
import { flipDebitCredit, postJournalEntry } from './post-journal-entry';

function buildTx(accounts: Record<string, { isActive?: boolean } | undefined> = {}) {
  return {
    account: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: { code: string } }) => {
        if (!(where.code in accounts)) return Promise.resolve(null);
        const a = accounts[where.code] ?? {};
        return Promise.resolve({
          id: 'acc-' + where.code,
          code: where.code,
          name: where.code,
          isActive: a.isActive ?? true,
        });
      }),
    },
    journalEntry: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        const lines = (data.lines?.create ?? []).map((l: any, i: number) => ({
          id: `jl-${i}`,
          ...l,
        }));
        return Promise.resolve({ id: 'je-1', ...data, lines });
      }),
    },
  };
}

const basePosted = 'user-1';

describe('postJournalEntry', () => {
  it('يرحّل قيدًا متوازنًا بعملة واحدة بنجاح', async () => {
    const tx = buildTx({ '1010': {}, '3000': {} });

    const entry = await postJournalEntry(tx as any, {
      description: 'إيداع رأس مال',
      postedById: basePosted,
      lines: [
        { accountCode: '1010', debit: '1000.00', currencyId: 'cur-lyd' },
        { accountCode: '3000', credit: '1000.00', currencyId: 'cur-lyd' },
      ],
    });

    expect(entry.lines).toHaveLength(2);
    expect(tx.journalEntry.create).toHaveBeenCalledTimes(1);
  });

  it('يرفض قيدًا بأقل من سطرين', async () => {
    const tx = buildTx({ '1010': {} });
    await expect(
      postJournalEntry(tx as any, {
        description: 'قيد ناقص',
        postedById: basePosted,
        lines: [{ accountCode: '1010', debit: '100.00', currencyId: 'cur-lyd' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض سطرًا يحمل مدينًا ودائنًا معًا', async () => {
    const tx = buildTx({ '1010': {}, '3000': {} });
    await expect(
      postJournalEntry(tx as any, {
        description: 'قيد خاطئ',
        postedById: basePosted,
        lines: [
          { accountCode: '1010', debit: '100.00', credit: '100.00', currencyId: 'cur-lyd' },
          { accountCode: '3000', credit: '100.00', currencyId: 'cur-lyd' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض سطرًا صفريًا (بلا مدين ولا دائن)', async () => {
    const tx = buildTx({ '1010': {}, '3000': {} });
    await expect(
      postJournalEntry(tx as any, {
        description: 'قيد صفري',
        postedById: basePosted,
        lines: [
          { accountCode: '1010', currencyId: 'cur-lyd' },
          { accountCode: '3000', credit: '100.00', currencyId: 'cur-lyd' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض قيدًا غير متوازن ضمن نفس العملة', async () => {
    const tx = buildTx({ '1010': {}, '3000': {} });
    await expect(
      postJournalEntry(tx as any, {
        description: 'قيد غير متوازن',
        postedById: basePosted,
        lines: [
          { accountCode: '1010', debit: '100.00', currencyId: 'cur-lyd' },
          { accountCode: '3000', credit: '90.00', currencyId: 'cur-lyd' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض قيدًا يتوازن إجمالًا لكن ليس لكل عملة على حدة', async () => {
    const tx = buildTx({ '1010': {}, '3000': {} });
    // 100 USD مدين مقابل 100 LYD دائن — يتساوى الرقمان لكن هذا لا يعني شيئًا محاسبيًا
    await expect(
      postJournalEntry(tx as any, {
        description: 'قيد يخلط عملتين خطأً',
        postedById: basePosted,
        lines: [
          { accountCode: '1010', debit: '100.00', currencyId: 'cur-usd' },
          { accountCode: '3000', credit: '100.00', currencyId: 'cur-lyd' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يرفض حسابًا غير موجود في شجرة الحسابات', async () => {
    const tx = buildTx({ '3000': {} });
    await expect(
      postJournalEntry(tx as any, {
        description: 'حساب مفقود',
        postedById: basePosted,
        lines: [
          { accountCode: '9999', debit: '100.00', currencyId: 'cur-lyd' },
          { accountCode: '3000', credit: '100.00', currencyId: 'cur-lyd' },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('يرفض حسابًا معطَّلًا', async () => {
    const tx = buildTx({ '1010': { isActive: false }, '3000': {} });
    await expect(
      postJournalEntry(tx as any, {
        description: 'حساب معطَّل',
        postedById: basePosted,
        lines: [
          { accountCode: '1010', debit: '100.00', currencyId: 'cur-lyd' },
          { accountCode: '3000', credit: '100.00', currencyId: 'cur-lyd' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('يقبل قيدًا متعدد العملات طالما توازنت كل عملة على حدة', async () => {
    const tx = buildTx({ '1010': {}, '3000': {} });
    const entry = await postJournalEntry(tx as any, {
      description: 'قيد متعدد العملات متوازن لكل عملة',
      postedById: basePosted,
      lines: [
        { accountCode: '1010', debit: '100.00', currencyId: 'cur-usd' },
        { accountCode: '3000', credit: '100.00', currencyId: 'cur-usd' },
        { accountCode: '1010', debit: '50.00', currencyId: 'cur-lyd' },
        { accountCode: '3000', credit: '50.00', currencyId: 'cur-lyd' },
      ],
    });
    expect(entry.lines).toHaveLength(4);
  });
});

describe('flipDebitCredit', () => {
  it('يبادل المدين بالدائن في كل سطر', () => {
    const flipped = flipDebitCredit([
      { accountCode: '1010', debit: '100.00', currencyId: 'cur-lyd' },
      { accountCode: '3000', credit: '100.00', currencyId: 'cur-lyd' },
    ]);
    expect(flipped[0]).toEqual(expect.objectContaining({ debit: undefined, credit: '100.00' }));
    expect(flipped[1]).toEqual(expect.objectContaining({ debit: '100.00', credit: undefined }));
  });
});
