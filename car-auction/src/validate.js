// تحقق مدخلات صريح وخفيف: كل حقل يُعرَّف بنوعه وقيوده، والحقول غير المعرّفة تُرفض.
import { HttpError } from './security/middleware.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^\d{1,11}(\.\d{1,3})?$/;
const NUMERIC = /^\d+(\.\d+)?$/;

// أسماء الحقول كما يراها المستخدم في رسائل الخطأ (الحقول غير المذكورة تبقى باسمها)
const FIELD_AR = {
  email: 'البريد الإلكتروني', password: 'كلمة المرور', current: 'كلمة المرور الحالية', next: 'كلمة المرور الجديدة', fullName: 'الاسم', phone: 'الهاتف',
  amount: 'المبلغ', totalAmount: 'المبلغ', currency: 'العملة', description: 'البيان', category: 'البند', reason: 'السبب', note: 'الملاحظة', reference: 'المرجع',
  rateToLyd: 'سعر الصرف', fxRateToLyd: 'سعر الصرف', fxRate: 'سعر الصرف', effectiveDate: 'التاريخ', entryDate: 'التاريخ', expenseDate: 'التاريخ', paidAt: 'التاريخ', incurredAt: 'التاريخ',
  holderName: 'صاحب العهدة', name: 'الاسم', role: 'الدور', method: 'طريقة الدفع', vin: 'رقم الهيكل', year: 'سنة الصنع', make: 'الماركة', model: 'الموديل',
  lotNumber: 'رقم اللوت', purchasePriceUsd: 'سعر الشراء', customerPrice: 'السعر المتفق عليه', priceLyd: 'السعر', startingPrice: 'سعر البداية', title: 'العنوان',
  from: 'من تاريخ', to: 'إلى تاريخ', paidBy: 'من دفعها', containerNo: 'رقم الحاوية', odometer: 'العداد',
};
const ar = (name) => FIELD_AR[name.replace(/\[\d+\]$/, '')] || name;

export const t = {
  string: (o = {}) => ({ kind: 'string', ...o }),
  enum: (values, o = {}) => ({ kind: 'enum', values, ...o }),
  decimal: (o = {}) => ({ kind: 'decimal', ...o }),
  int: (o = {}) => ({ kind: 'int', ...o }),
  uuid: (o = {}) => ({ kind: 'uuid', ...o }),
  date: (o = {}) => ({ kind: 'date', ...o }),
  datetime: (o = {}) => ({ kind: 'datetime', ...o }),
  bool: (o = {}) => ({ kind: 'bool', ...o }),
  array: (of, o = {}) => ({ kind: 'array', of, ...o }),
};

function check(name, spec, v) {
  switch (spec.kind) {
    case 'string': {
      if (typeof v !== 'string') return `${name}: يجب أن يكون نصًا`;
      const s = v.trim();
      if (spec.min && s.length < spec.min) return `${name}: قصير جدًا`;
      if (s.length > (spec.max ?? 500)) return `${name}: طويل جدًا`;
      if (spec.pattern && !spec.pattern.test(s)) return `${name}: صيغة غير صحيحة`;
      return { value: s };
    }
    case 'enum':
      return spec.values.includes(v) ? { value: v } : `${name}: قيمة غير مسموحة`;
    case 'decimal': {
      const s = String(v);
      // scale: عدد المنازل العشرية المسموح (3 للمبالغ؛ أسعار الصرف تحتاج أكثر، مثل 5.5200)
      const scale = spec.scale ?? 3;
      if (!NUMERIC.test(s)) return `${name}: اكتب رقمًا بالأرقام الإنجليزية بلا فواصل، مثل 1500 أو 1500.5`;
      const [int, frac = ''] = s.split('.');
      if (int.length > 11) return `${name}: الرقم كبير جدًا`;
      if (frac.length > scale) return `${name}: ${scale} منازل عشرية كحد أقصى`;
      if (scale === 3 && !DECIMAL.test(s)) return `${name}: رقم غير صالح`;
      if (spec.positive && Number(s) <= 0) return `${name}: يجب أن يكون أكبر من صفر`;
      return { value: s };
    }
    case 'int':
      if (!Number.isInteger(v)) return `${name}: يجب أن يكون عددًا صحيحًا`;
      if (spec.min != null && v < spec.min) return `${name}: أقل من المسموح`;
      if (spec.max != null && v > spec.max) return `${name}: أكبر من المسموح`;
      return { value: v };
    case 'uuid':
      return typeof v === 'string' && UUID.test(v) ? { value: v } : `${name}: معرّف غير صالح`;
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? { value: v.slice(0, 10) } : `${name}: تاريخ غير صالح`;
    case 'datetime': {
      const ms = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isNaN(ms) ? `${name}: تاريخ ووقت غير صالح` : { value: new Date(ms).toISOString() };
    }
    case 'bool':
      return typeof v === 'boolean' ? { value: v } : `${name}: يجب أن يكون true/false`;
    case 'array': {
      if (!Array.isArray(v)) return `${name}: يجب أن يكون قائمة`;
      if (spec.max && v.length > spec.max) return `${name}: عناصر كثيرة`;
      const out = [];
      for (const [i, item] of v.entries()) {
        const r = check(`${name}[${i}]`, spec.of, item);
        if (typeof r === 'string') return r;
        out.push(r.value);
      }
      return { value: out };
    }
    default:
      return `${name}: نوع غير معروف`;
  }
}

/** يتحقق من body ويعيد نسخة نظيفة؛ يرمي 422 بقائمة الأخطاء */
export function validate(body, schema) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(422, 'VALIDATION', 'جسم الطلب يجب أن يكون كائن JSON');
  const errors = [];
  const out = {};
  for (const key of Object.keys(body)) if (!(key in schema)) errors.push(`${key}: حقل غير معروف`);
  for (const [key, spec] of Object.entries(schema)) {
    const v = body[key];
    // nullable: القيمة null أو '' تعني «إفراغ الحقل» صراحةً (تختلف عن عدم إرساله)
    if (spec.nullable && key in body && (v === null || v === '')) { out[key] = null; continue; }
    if (v === undefined || v === null || v === '') {
      if (spec.required) errors.push(`${ar(key)}: مطلوب`);
      continue;
    }
    const r = check(ar(key), spec, v);
    if (typeof r === 'string') errors.push(r);
    else out[key] = r.value;
  }
  if (errors.length) throw new HttpError(422, 'VALIDATION', errors.join('، '));
  return out;
}

export function isUuid(v) {
  return typeof v === 'string' && UUID.test(v);
}
