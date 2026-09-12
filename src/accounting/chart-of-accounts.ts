import { AccountClass, AccountType, DebitCredit, ExpenseCategory } from '@prisma/client';

/**
 * شجرة الحسابات الافتراضية — تُزرَع مرة واحدة (upsert بالرمز، idempotent) عبر
 * AccountingService.ensureChartOfAccounts() عند إقلاع التطبيق. لا تُعدَّل هذه
 * القائمة يدويًا في قاعدة البيانات؛ أي حساب جديد يُضاف هنا فقط ليُزرَع تلقائيًا.
 */
export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  class: AccountClass;
  normalBalance: DebitCredit;
}

// رموز الحسابات المستخدَمة من الكود مباشرة (الترحيل التلقائي) — أسماء ثابتة
// كي لا تتفرّق الأرقام السحرية عبر الخدمات المختلفة.
export const ACCOUNT_CODES = {
  TILL_CASH: '1010', // النقدية في خزائن الفروع
  BANK_CASH: '1015', // النقدية في الحساب المصرفي الرئيسي
  INTER_BRANCH_CLEARING: '1030', // تسوية تحويلات بين الفروع (حساب عبور)
  REMITTANCE_RECEIVABLE: '1020', // ذمم هامش الحوالات المستحقة
  FIXED_ASSETS_FURNITURE: '1500', // أصول ثابتة — أثاث ومعدات مكتبية
  FIXED_ASSETS_VEHICLES: '1510', // أصول ثابتة — سيارات
  FIXED_ASSETS_PROPERTY: '1520', // أصول ثابتة — عقارات وتحسينات
  ACCUMULATED_DEPRECIATION: '1590', // مجمع إهلاك الأصول الثابتة (مقابل أصل، دائن)
  CLIENT_CUSTODY_PAYABLE: '2010', // وديعة العملاء المستحقة
  EXPENSE_CLEARING_PAYABLE: '2020', // ذمم دائنة — مصاريف مدفوعة من مصادر خارجية
  LONG_TERM_LOANS: '2500', // قروض طويلة الأجل
  PAID_IN_CAPITAL: '3000', // رأس المال المدفوع
  REMITTANCE_MARGIN_REVENUE: '4010', // إيرادات هامش الحوالات
  FX_TRADING_REVENUE: '4020', // إيرادات فروقات أسعار الصرف (تُرحَّل يدويًا حاليًا)
  OTHER_REVENUE: '4090', // إيرادات أخرى
  CASH_OVER_INCOME: '4900', // فروقات جرد الصندوق (موجبة)
  CUSTODY_ADJUSTMENT_INCOME: '4095', // إيراد تسويات أرصدة عملاء (تخفيض التزام بلا صرف نقدي)
  REMITTANCE_NETWORK_COST: '5015', // تكلفة شبكات الحوالات (وسترن يونيون / موني جرام)
  DEPRECIATION_EXPENSE: '5300', // مصروف الإهلاك
  CASH_SHORT_EXPENSE: '5900', // فروقات جرد الصندوق (سالبة)
  CUSTODY_ADJUSTMENT_EXPENSE: '5100', // مصروف تسويات أرصدة عملاء
  INCOME_TAX_EXPENSE: '5200', // ضريبة الدخل (تُرحَّل يدويًا حسب السياسة الضريبية)
  OTHER_EXPENSE: '5990', // مصاريف أخرى
} as const;

// تُطابق فئات المصاريف (ExpenseCategory) بحسابات دفتر الأستاذ — كل فئة حساب مصروف مستقل
// كي تظهر مفصَّلة في قائمة الدخل، لا مجمَّعة في بند واحد.
export const EXPENSE_CATEGORY_ACCOUNT_CODE: Record<ExpenseCategory, string> = {
  SALARIES: '5010',
  RENT: '5020',
  UTILITIES: '5030',
  MAINTENANCE: '5040',
  OFFICE_SUPPLIES: '5050',
  MARKETING: '5060',
  PROFESSIONAL_FEES: '5070',
  TAXES_GOVERNMENT: '5080',
  TRAVEL: '5090',
  OTHER: ACCOUNT_CODES.OTHER_EXPENSE,
};

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // ---- الأصول المتداولة ----
  {
    code: ACCOUNT_CODES.TILL_CASH,
    name: 'النقدية في خزائن الفروع',
    type: 'ASSET',
    class: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.BANK_CASH,
    name: 'النقدية في الحساب المصرفي الرئيسي',
    type: 'ASSET',
    class: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.INTER_BRANCH_CLEARING,
    name: 'تسوية تحويلات بين الفروع (عهدة عبور)',
    type: 'ASSET',
    class: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.REMITTANCE_RECEIVABLE,
    name: 'ذمم هامش الحوالات المستحقة',
    type: 'ASSET',
    class: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
  },

  // ---- الأصول الثابتة ----
  {
    code: ACCOUNT_CODES.FIXED_ASSETS_FURNITURE,
    name: 'أصول ثابتة — أثاث ومعدات مكتبية',
    type: 'ASSET',
    class: 'FIXED_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.FIXED_ASSETS_VEHICLES,
    name: 'أصول ثابتة — سيارات',
    type: 'ASSET',
    class: 'FIXED_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.FIXED_ASSETS_PROPERTY,
    name: 'أصول ثابتة — عقارات وتحسينات',
    type: 'ASSET',
    class: 'FIXED_ASSET',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.ACCUMULATED_DEPRECIATION,
    name: 'مجمع إهلاك الأصول الثابتة',
    type: 'ASSET',
    class: 'FIXED_ASSET',
    normalBalance: 'CREDIT',
  },

  // ---- الخصوم المتداولة ----
  {
    code: ACCOUNT_CODES.CLIENT_CUSTODY_PAYABLE,
    name: 'وديعة العملاء المستحقة',
    type: 'LIABILITY',
    class: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
  },
  {
    code: ACCOUNT_CODES.EXPENSE_CLEARING_PAYABLE,
    name: 'ذمم دائنة — مصاريف مدفوعة من مصادر خارجية',
    type: 'LIABILITY',
    class: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
  },

  // ---- الخصوم طويلة الأجل ----
  {
    code: ACCOUNT_CODES.LONG_TERM_LOANS,
    name: 'قروض طويلة الأجل',
    type: 'LIABILITY',
    class: 'LONG_TERM_LIABILITY',
    normalBalance: 'CREDIT',
  },

  // ---- حقوق الملكية ----
  {
    code: ACCOUNT_CODES.PAID_IN_CAPITAL,
    name: 'رأس المال المدفوع',
    type: 'EQUITY',
    class: 'EQUITY',
    normalBalance: 'CREDIT',
  },

  // ---- الإيرادات ----
  {
    code: ACCOUNT_CODES.REMITTANCE_MARGIN_REVENUE,
    name: 'إيرادات هامش الحوالات',
    type: 'REVENUE',
    class: 'REVENUE',
    normalBalance: 'CREDIT',
  },
  {
    code: ACCOUNT_CODES.FX_TRADING_REVENUE,
    name: 'إيرادات فروقات أسعار الصرف',
    type: 'REVENUE',
    class: 'REVENUE',
    normalBalance: 'CREDIT',
  },
  {
    code: ACCOUNT_CODES.OTHER_REVENUE,
    name: 'إيرادات أخرى',
    type: 'REVENUE',
    class: 'REVENUE',
    normalBalance: 'CREDIT',
  },
  {
    code: ACCOUNT_CODES.CASH_OVER_INCOME,
    name: 'فروقات جرد الصندوق (موجبة)',
    type: 'REVENUE',
    class: 'REVENUE',
    normalBalance: 'CREDIT',
  },
  {
    code: ACCOUNT_CODES.CUSTODY_ADJUSTMENT_INCOME,
    name: 'إيراد تسويات أرصدة العملاء',
    type: 'REVENUE',
    class: 'REVENUE',
    normalBalance: 'CREDIT',
  },

  // ---- المصاريف (فئة لكل بند من ExpenseCategory) ----
  { code: '5010', name: 'رواتب وأجور', type: 'EXPENSE', class: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '5020', name: 'إيجارات', type: 'EXPENSE', class: 'EXPENSE', normalBalance: 'DEBIT' },
  {
    code: '5030',
    name: 'خدمات (كهرباء/ماء/اتصالات)',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: '5040',
    name: 'صيانة ومستلزمات تشغيل',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: '5050',
    name: 'مستلزمات مكتبية',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  { code: '5060', name: 'تسويق وإعلان', type: 'EXPENSE', class: 'EXPENSE', normalBalance: 'DEBIT' },
  { code: '5070', name: 'أتعاب مهنية', type: 'EXPENSE', class: 'EXPENSE', normalBalance: 'DEBIT' },
  {
    code: '5080',
    name: 'رسوم ومستحقات حكومية',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  { code: '5090', name: 'سفر وتنقلات', type: 'EXPENSE', class: 'EXPENSE', normalBalance: 'DEBIT' },
  {
    code: ACCOUNT_CODES.REMITTANCE_NETWORK_COST,
    name: 'تكلفة شبكات الحوالات (وسترن يونيون / موني جرام)',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.DEPRECIATION_EXPENSE,
    name: 'مصروف الإهلاك',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.CUSTODY_ADJUSTMENT_EXPENSE,
    name: 'مصروف تسويات أرصدة العملاء',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.INCOME_TAX_EXPENSE,
    name: 'ضريبة الدخل',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.CASH_SHORT_EXPENSE,
    name: 'فروقات جرد الصندوق (سالبة)',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
  {
    code: ACCOUNT_CODES.OTHER_EXPENSE,
    name: 'مصاريف أخرى',
    type: 'EXPENSE',
    class: 'EXPENSE',
    normalBalance: 'DEBIT',
  },
];
