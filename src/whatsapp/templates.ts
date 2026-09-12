/**
 * سجل أسماء القوالب المعتمدة من Meta Business Manager. هذا النظام لا "يُنشئ"
 * قوالب ولا يوافق عليها — الاعتماد يقع بالكامل داخل Meta؛ هذا الملف فقط يربط
 * كل سيناريو داخلي باسم القالب ولغته كما اعتُمدا هناك، حتى لا تتفرّق الأسماء
 * الحرفية عبر الكود. عدد المعاملات (params) لكل قالب يجب أن يطابق تعريفه
 * الفعلي في Meta بالضبط.
 */
export const WHATSAPP_TEMPLATES = {
  RATE_UPDATE: {
    name: 'exlibya_rate_update',
    language: 'ar',
    /** المعاملات بالترتيب: [رمز العملة، السعر] */
    describeParams: (params: [string, string]) => params,
  },
  DEAL_CONFIRMATION: {
    name: 'exlibya_deal_confirmation',
    language: 'ar',
    /** [اسم العميل، الاتجاه بالعربية، الكمية والعملة، السعر المنفَّذ] */
    describeParams: (params: [string, string, string, string]) => params,
  },
  LIMIT_ALERT: {
    name: 'exlibya_limit_alert',
    language: 'ar',
    /** [اسم العميل، نوع الحد بالعربية، نسبة الاستخدام] */
    describeParams: (params: [string, string, string]) => params,
  },
} as const;

export type WhatsAppTemplateKey = keyof typeof WHATSAPP_TEMPLATES;
