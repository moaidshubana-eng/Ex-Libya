// دورة حياة السيارة — مرآة لجدول vehicle_status_transitions في قاعدة البيانات.
// قاعدة البيانات هي الحَكَم النهائي (Trigger)، وهذه النسخة تخدم الواجهة
// (إظهار الأزرار المسموحة فقط) والتحقق المبكر قبل فتح المعاملة.

export const STATUSES = [
  { code: 'PURCHASED', label: 'تم الشراء', stage: 'USA', color: '#6366f1' },
  { code: 'AWAITING_PICKUP', label: 'بانتظار السحب', stage: 'USA', color: '#8b5cf6' },
  { code: 'US_INLAND_TRANSIT', label: 'نقل داخلي (أمريكا)', stage: 'USA', color: '#a855f7' },
  { code: 'AT_US_WAREHOUSE', label: 'في مستودع التصدير', stage: 'USA', color: '#d946ef' },
  { code: 'LOADED', label: 'محمّلة في الحاوية', stage: 'OCEAN', color: '#0ea5e9' },
  { code: 'IN_TRANSIT_SEA', label: 'في البحر', stage: 'OCEAN', color: '#0284c7' },
  { code: 'AT_PORT_LIBYA', label: 'في الميناء', stage: 'LIBYA', color: '#f59e0b' },
  { code: 'IN_CUSTOMS', label: 'في الجمارك', stage: 'LIBYA', color: '#f97316' },
  { code: 'CUSTOMS_CLEARED', label: 'مُفرج عنها جمركيًا', stage: 'LIBYA', color: '#eab308' },
  { code: 'LY_INLAND_TRANSIT', label: 'نقل داخلي (ليبيا)', stage: 'LIBYA', color: '#ca8a04' },
  { code: 'IN_STOCK', label: 'متاحة في المعرض', stage: 'SALES', color: '#10b981' },
  { code: 'IN_AUCTION', label: 'في المزايدة', stage: 'SALES', color: '#e11d48' },
  { code: 'ON_HOLD', label: 'معلقة', stage: 'EXCEPTION', color: '#64748b' },
  { code: 'SOLD', label: 'مباعة', stage: 'CLOSED', color: '#059669' },
  { code: 'DELIVERED', label: 'مُسلَّمة', stage: 'CLOSED', color: '#047857' },
  { code: 'CANCELLED', label: 'ملغاة', stage: 'EXCEPTION', color: '#9ca3af' },
];

export const STATUS_CODES = STATUSES.map((s) => s.code);
export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.code, s.label]));

// المسار الرئيسي المعروض في شريط التقدم (Timeline) بالترتيب
export const MAIN_PATH = [
  'PURCHASED', 'AWAITING_PICKUP', 'US_INLAND_TRANSIT', 'AT_US_WAREHOUSE', 'LOADED',
  'IN_TRANSIT_SEA', 'AT_PORT_LIBYA', 'IN_CUSTOMS', 'CUSTOMS_CLEARED', 'LY_INLAND_TRANSIT',
  'IN_STOCK', 'SOLD', 'DELIVERED',
];

export const TRANSITIONS = {
  PURCHASED: ['AWAITING_PICKUP', 'CANCELLED'],
  AWAITING_PICKUP: ['US_INLAND_TRANSIT', 'CANCELLED'],
  US_INLAND_TRANSIT: ['AT_US_WAREHOUSE'],
  AT_US_WAREHOUSE: ['LOADED'],
  LOADED: ['IN_TRANSIT_SEA', 'AT_US_WAREHOUSE'],
  IN_TRANSIT_SEA: ['AT_PORT_LIBYA', 'SOLD'],
  AT_PORT_LIBYA: ['IN_CUSTOMS', 'SOLD'],
  IN_CUSTOMS: ['CUSTOMS_CLEARED', 'SOLD'],
  CUSTOMS_CLEARED: ['LY_INLAND_TRANSIT', 'IN_STOCK', 'SOLD'],
  LY_INLAND_TRANSIT: ['IN_STOCK'],
  IN_STOCK: ['IN_AUCTION', 'SOLD'],
  IN_AUCTION: ['IN_STOCK', 'SOLD'],
  SOLD: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
  ON_HOLD: [], // يُعالَج خاصةً: يعود فقط إلى hold_return_status أو CANCELLED
};

const TERMINAL_FOR_HOLD = new Set(['SOLD', 'DELIVERED', 'CANCELLED', 'ON_HOLD']);

// انتقالات يجريها النظام وحده (المزاد/البيع) ولا تُتاح كزر يدوي عام
const SYSTEM_ONLY = new Set(['IN_AUCTION', 'SOLD']);

/**
 * هل الانتقال من حالة إلى أخرى مسموح؟
 * @param {string} from
 * @param {string} to
 * @param {string|null} holdReturnStatus الحالة المحفوظة قبل التعليق
 */
export function canTransition(from, to, holdReturnStatus = null) {
  if (from === to) return false;
  if (to === 'ON_HOLD') return !TERMINAL_FOR_HOLD.has(from);
  if (from === 'ON_HOLD') return to === holdReturnStatus || to === 'CANCELLED';
  return (TRANSITIONS[from] || []).includes(to);
}

/** الحالات التالية المتاحة كأزرار يدوية للمستخدم في الواجهة */
export function manualNextStatuses(from, holdReturnStatus = null) {
  const out = from === 'ON_HOLD'
    ? [holdReturnStatus, 'CANCELLED'].filter(Boolean)
    : (TRANSITIONS[from] || []).filter((s) => !SYSTEM_ONLY.has(s));
  if (!TERMINAL_FOR_HOLD.has(from)) out.push('ON_HOLD');
  return out;
}

/**
 * أقصر مسار أمامي بين حالتين (BFS) — تستخدمه المزامنة الآلية عندما يقفز
 * المصدر الخارجي عدة مراحل دفعة واحدة (مثلًا من PURCHASED إلى US_INLAND_TRANSIT)
 * فتُسجَّل كل خطوة وسيطة في السجل بدل كسر قواعد الانتقال.
 * يعيد null إن لم يوجد مسار، ولا يمر أبدًا عبر SOLD/IN_AUCTION/CANCELLED.
 */
export function forwardPath(from, to) {
  if (from === to) return [];
  const queue = [[from]];
  const seen = new Set([from]);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    for (const next of TRANSITIONS[last] || []) {
      if (seen.has(next)) continue;
      if (next !== to && (SYSTEM_ONLY.has(next) || next === 'CANCELLED')) continue;
      const p = [...path, next];
      if (next === to) return p.slice(1);
      seen.add(next);
      queue.push(p);
    }
  }
  return null;
}

/** ترتيب الحالة على المسار الرئيسي (للمقارنة: هل التحديث الوارد "أحدث" مما لدينا؟) */
export function pathIndex(status) {
  if (status === 'IN_AUCTION') return MAIN_PATH.indexOf('IN_STOCK');
  return MAIN_PATH.indexOf(status);
}
