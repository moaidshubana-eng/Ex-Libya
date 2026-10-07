// أدوات مشتركة: قوالب HTML آمنة (هروب تلقائي ضد XSS)، عميل API، تنسيق، إشعارات، نوافذ.

const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: true, s: String(s ?? '') });

function escape(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

function part(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(part).join('');
  if (typeof v === 'object' && v[RAW]) return v.s;
  return escape(v);
}

/** كل قيمة مُدرجة تُهرَّب افتراضيًا؛ html`` المتداخلة تُعامل كآمنة */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return raw(out);
}

export const render = (el, tpl) => { el.innerHTML = tpl.s ?? tpl; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- API
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(res.status, data);
  }
  return data;
}

// ---------------------------------------------------------------- التنسيق
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf3 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
export const fmt = {
  n: (v) => (v == null ? '—' : nf0.format(Number(v))),
  lyd: (v, exact = false) => (v == null ? '—' : `${exact ? nf3.format(Number(v)) : nf0.format(Number(v))} د.ل`),
  money: (v, cur) => (v == null ? '—' : `${nf0.format(Number(v))} ${cur === 'LYD' ? 'د.ل' : cur === 'USD' ? '$' : cur}`),
  date: (v) => (v ? new Date(v).toLocaleDateString('ar-LY-u-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'),
  dt: (v) => (v ? new Date(v).toLocaleString('ar-LY-u-nu-latn', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
  ago: (v) => {
    if (!v) return '—';
    const s = (Date.now() - new Date(v).getTime()) / 1000;
    if (s < 60) return 'الآن';
    if (s < 3600) return `قبل ${Math.floor(s / 60)} د`;
    if (s < 86400) return `قبل ${Math.floor(s / 3600)} س`;
    return `قبل ${Math.floor(s / 86400)} يوم`;
  },
  odo: (v, unit) => (v == null ? '—' : `${nf0.format(v)} ${unit === 'km' ? 'كم' : 'ميل'}`),
};

export const LABELS = {
  title: { CLEAN: 'نظيفة (Clean)', SALVAGE: 'سالفج (Salvage)', REBUILT: 'معاد بناؤها', PARTS_ONLY: 'قطع فقط', CERTIFICATE_OF_DESTRUCTION: 'شهادة إتلاف', OTHER: 'أخرى' },
  shipment: { BOOKED: 'محجوزة', LOADING: 'قيد التحميل', DEPARTED: 'غادرت', IN_TRANSIT: 'في البحر', TRANSSHIPMENT: 'مسافنة', ARRIVED: 'وصلت', DISCHARGED: 'أُفرغت', CLOSED: 'مغلقة', CANCELLED: 'ملغاة' },
  customs: { DOCS_PENDING: 'بانتظار المستندات', SUBMITTED: 'قُدِّم البيان', INSPECTION: 'معاينة', ASSESSED: 'تم التقييم', DUTY_PAID: 'سُدد الرسم', RELEASED: 'مُفرج عنها', REJECTED: 'مرفوض' },
  stage: { PURCHASE: 'الشراء والرسوم', US_LOGISTICS: 'لوجستيات أمريكا', OCEAN: 'الشحن البحري', LIBYA_PORT: 'الميناء الليبي', CUSTOMS: 'الجمارك', LIBYA_INLAND: 'النقل الداخلي', PREPARATION: 'التجهيز', OVERHEAD: 'أخرى' },
  role: { ADMIN: 'مدير النظام', OPERATIONS: 'العمليات', ACCOUNTANT: 'المحاسبة', SALES: 'المبيعات', VIEWER: 'اطلاع', BIDDER: 'مزايد' },
  job: { SUCCEEDED: 'ناجحة', PARTIAL: 'جزئية', FAILED: 'فاشلة', RUNNING: 'جارية', QUEUED: 'بالانتظار' },
  color: { WHITE: 'أبيض', BLACK: 'أسود', SILVER: 'فضي', GRAY: 'رمادي', BLUE: 'أزرق', RED: 'أحمر', BURGUNDY: 'عنابي', BEIGE: 'بيج', GREEN: 'أخضر' },
};
export const STAGE_COLORS = { PURCHASE: '#6366f1', US_LOGISTICS: '#a855f7', OCEAN: '#0284c7', LIBYA_PORT: '#f59e0b', CUSTOMS: '#f97316', LIBYA_INLAND: '#ca8a04', PREPARATION: '#10b981', OVERHEAD: '#94a3b8' };

export const state = { user: null, meta: null, compare: new Set() };

export function statusBadge(code) {
  const s = state.meta?.statuses.find((x) => x.code === code);
  return html`<span class="badge" style="color:${s?.color || '#64748b'}"><span class="dot"></span><span style="color:var(--text)">${s?.label || code}</span></span>`;
}

export const imgUrl = (vehicleId, imageId) => (imageId ? `/api/media/vehicles/${vehicleId}/${imageId}.svg` : '');

// ---------------------------------------------------------------- إشعارات ونوافذ
export function toast(msg, kind = '') {
  const host = $('.toast-host') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toast-host' }));
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: msg });
  el.setAttribute('role', 'status');
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/** نافذة حوار بنموذج؛ تعيد قيم الحقول أو null عند الإلغاء */
export function modal({ title, body, submitLabel = 'حفظ', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    render(d, html`<form method="dialog">
      <div class="m-h"><h3>${title}</h3><button class="btn btn-ghost btn-sm" value="cancel" aria-label="إغلاق">✕</button></div>
      <div class="m-b">${body}</div>
      <div class="m-f"><button class="btn" value="cancel" formnovalidate>إلغاء</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${submitLabel}</button></div>
    </form>`);
    document.body.appendChild(d);
    d.showModal();
    d.addEventListener('close', () => {
      const ok = d.returnValue === 'ok';
      const data = ok ? Object.fromEntries(new FormData(d.querySelector('form'))) : null;
      d.remove();
      resolve(data);
    });
  });
}

export const ICONS = {
  dash: '<path d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z"/>',
  car: '<path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11m-14 0h14a2 2 0 0 1 2 2v4h-2m-14 0H3v-4a2 2 0 0 1 2-2m2 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  gavel: '<path d="M14 3l7 7-3 3-7-7zM9.5 8.5l6 6M4 20l7-7M2 22h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ship: '<path d="M3 17l2 4h14l2-4-9-3zM12 3v11M7 8h10l-1 5H8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  customs: '<path d="M4 4h16v6H4zM6 10v10h12V10M10 14h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  report: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 17v-3M12 17v-6M15 17v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  audit: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  money: '<path d="M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v4M18 10v4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  clock: '<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  xls: '<path d="M6 3h9l4 4v14H6zM9 11l4 6M13 11l-4 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  pdf: '<path d="M6 3h9l4 4v14H6zM9 13h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  zoom: '<path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  left: '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  right: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  compare: '<path d="M8 3v18M16 3v18M3 8h5M16 16h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
export const icon = (name) => raw(`<svg class="ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`);
