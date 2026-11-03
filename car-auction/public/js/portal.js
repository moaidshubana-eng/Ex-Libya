// بوابة العملاء (/portal): دخول العميل برقم هاتفه، سياراته ومراحلها وصورها، كشف حسابه، والتتبّع العام بالكود.
// كل الطلبات إلى /api/portal فقط (جلسة منفصلة عن الموظفين).
import { html, raw, render, $, $$, api, fmt, toast } from './core.js';
import { openLightbox } from './gallery.js';

const main = $('[data-main]');
const nav = $('[data-nav]');
let me = null;

const STAGES = [
  ['تم الشراء', '<path d="M6 7h12l-1 13H7zM9 7a3 3 0 0 1 6 0"/>'],
  ['في مستودع التصدير', '<path d="M3 21V9l9-6 9 6v12M3 21h18M8 21v-7h8v7"/>'],
  ['تم الشحن', '<path d="M3 17l2 4h14l2-4-9-3zM12 3v11M7 8h10l-1 5H8z"/>'],
  ['وصلت ليبيا', '<path d="M12 2v20M12 5a2 2 0 1 0 0-.01M5 12a7 7 0 0 0 14 0M3 12h4M17 12h4"/>'],
  ['جاهزة للاستلام', '<path d="M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z"/>'],
];
// مسارات SVG ثابتة من هذا الملف (لا مدخلات مستخدم)، فـ raw آمنة هنا
const icon = (p) => raw(`<svg viewBox="0 0 24 24" class="ic" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`);
const COLORS = { WHITE: 'أبيض', BLACK: 'أسود', SILVER: 'فضي', GRAY: 'رمادي', BLUE: 'أزرق', RED: 'أحمر', BURGUNDY: 'عنابي', BEIGE: 'بيج', GREEN: 'أخضر' };
const TITLES = { CLEAN: 'نظيفة', SALVAGE: 'سالفج', REBUILT: 'معاد بناؤها', PARTS_ONLY: 'قطع فقط', CERTIFICATE_OF_DESTRUCTION: 'شهادة إتلاف', OTHER: '—' };
const CUSTOMS = { DOCS_PENDING: 'بانتظار المستندات', SUBMITTED: 'قُدِّم البيان', INSPECTION: 'معاينة', ASSESSED: 'تم التقييم', DUTY_PAID: 'سُدد الرسم', RELEASED: 'مُفرج عنها', REJECTED: 'مرفوض' };
const CUR = { USD: '$', LYD: 'د.ل', EUR: '€' };
const money = (v, c) => (v == null ? '—' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${CUR[c] || c}`);
const title = (c) => [c.year, c.make, c.model, c.trim].filter(Boolean).join(' ');

// ======================================================================= عناصر مشتركة
function stepper(c) {
  return html`<ol class="pt-steps ${c.onHold ? 'hold' : ''}">${STAGES.map(([l, p], i) => html`
    <li class="${i < c.stage ? 'done' : i === c.stage ? 'now' : ''}"><span class="pt-dot">${icon(p)}</span><span class="pt-step-l">${l}</span></li>`)}</ol>
    ${c.onHold ? html`<div class="alert" style="margin-top:10px">السيارة معلّقة مؤقتًا — تواصل معنا للتفاصيل.</div>` : ''}`;
}
const kv = (k, v) => (v == null || v === '' ? '' : html`<div><dt>${k}</dt><dd>${v}</dd></div>`);

function photos(c, urlOf) {
  if (!c.images.length) return html`<div class="empty">لا توجد صور بعد</div>`;
  return html`<div class="pt-photos">${c.images.map((id, i) => html`<button type="button" data-photo="${i}" aria-label="صورة ${i + 1}"><img src="${urlOf(id)}" alt="" loading="lazy"></button>`)}</div>`;
}
function bindPhotos(root, c, urlOf) {
  $$('[data-photo]', root).forEach((b) => b.addEventListener('click', () =>
    openLightbox(c.images.map((id) => ({ id })), (im) => urlOf(im.id), Number(b.dataset.photo), title(c))));
}

function carDetails(c, { urlOf, withMoney }) {
  const s = c.shipment;
  return html`
    <div class="card card-b pt-hero-car">
      <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
        <div><h2 style="margin:0">${title(c)}</h2><div class="mono faint">${c.vin}</div></div>
        <span class="pt-status">${c.statusLabel}${c.statusAt ? html` <span class="faint">· ${fmt.date(c.statusAt)}</span>` : ''}</span>
      </div>
      ${stepper(c)}
    </div>
    ${withMoney && c.price ? html`<div class="grid g3" style="margin-top:14px">
      <div class="card card-b pt-kpi"><span>سعر السيارة</span><b>${money(c.price, c.currency)}</b></div>
      <div class="card card-b pt-kpi"><span>المدفوع</span><b class="pos">${money(c.paid, c.currency)}</b></div>
      <div class="card card-b pt-kpi"><span>المتبقي</span><b class="${Number(c.remaining) > 0.0005 ? 'neg' : 'pos'}">${Number(c.remaining) > 0.0005 ? money(c.remaining, c.currency) : 'خالصة ✓'}</b></div></div>` : ''}
    <div class="grid g2" style="margin-top:14px;align-items:start">
      <div class="card"><div class="card-h"><h3 style="margin:0">تفاصيل الحاوية والشحن</h3></div><div class="card-b">
        ${s ? html`<dl class="pt-kv">${kv('ميناء التحميل', s.from)}${kv('ميناء الوصول', s.to)}${kv('رقم الحاوية', s.container && html`<span class="mono">${s.container}</span>`)}
          ${kv('الخط الملاحي', s.carrier)}${kv('السفينة', s.vessel && `${s.vessel}${s.voyage ? ` (${s.voyage})` : ''}`)}${kv('تاريخ الإبحار', s.atd || s.etd ? fmt.date(s.atd || s.etd) : null)}
          ${kv(s.ata ? 'تاريخ الوصول' : 'الوصول المتوقّع', s.ata || s.eta ? fmt.date(s.ata || s.eta) : null)}${kv('الجمارك', CUSTOMS[c.customsStatus])}</dl>`
          : html`<div class="empty">لم تُحمَّل في حاوية بعد</div>`}</div></div>
      <div class="card"><div class="card-h"><h3 style="margin:0">تفاصيل السيارة</h3></div><div class="card-b"><dl class="pt-kv">
        ${kv('رقم الشاصي (VIN)', html`<span class="mono">${c.vin}</span>`)}${kv('اللون', COLORS[c.color] || c.color)}
        ${kv('العداد', c.odometer != null ? fmt.odo(c.odometer, c.odometerUnit) : null)}${kv('الملكية', TITLES[c.titleType])}${kv('الضرر', c.damage)}
        ${kv('المفتاح', c.hasKeys == null ? null : c.hasKeys ? 'موجود' : 'غير موجود')}${kv('المزاد', c.source && `${c.source}${c.lotNumber ? ` · لوت ${c.lotNumber}` : ''}`)}
        ${kv('تاريخ الشراء', c.purchaseDate ? fmt.date(c.purchaseDate) : null)}${kv('رقم المخزون', c.stockNo)}${kv('كود التتبّع', html`<span class="mono">${c.trackCode}</span>`)}</dl></div></div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-h"><h3 style="margin:0">الصور</h3><span class="faint">${c.images.length} صورة</span></div><div class="card-b">${photos(c, urlOf)}</div></div>
    ${c.history.length ? html`<div class="card" style="margin-top:14px"><div class="card-h"><h3 style="margin:0">سجل الحركة</h3></div><div class="card-b">
      <ul class="pt-hist">${[...c.history].reverse().map((h) => html`<li><b>${h.label}</b><span class="faint">${fmt.date(h.at)}</span></li>`)}</ul></div></div>` : ''}`;
}

const trackUrl = (code) => `${location.origin}/portal?track=${code}`;

// ======================================================================= الصفحات
/** خانة البحث: رقم الهيكل (17 خانة) أو كود التتبّع (12 خانة) */
function searchBox(value = '') {
  return html`<form class="card card-b pt-box pt-search" data-search novalidate>
    <h2>تتبّع سيارتك</h2>
    <div class="pt-search-row"><input class="input mono" name="q" maxlength="17" required dir="ltr" autocomplete="off" autocapitalize="characters"
        placeholder="1HGCM82633A004352" value="${value}" style="text-transform:uppercase" aria-label="رقم الهيكل VIN">
      <button class="btn btn-primary">بحث</button></div>
    <div data-err role="alert" class="neg" style="min-height:1.4em"></div>
    <p class="faint" style="margin:0;font-size:13px">اكتب رقم الهيكل (الشاصي) كاملًا كما في ورقة الشراء، أو كود التتبّع اللي وصلك من الشركة.</p>
  </form>`;
}
function bindSearch(root) {
  $('[data-search]', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim().replace(/\s+/g, '');
    const err = $('[data-err]', e.target);
    if (/^[0-9a-f]{12}$/i.test(q)) location.hash = `#/track/${q.toLowerCase()}`;
    else if (/^[A-HJ-NPR-Za-hj-npr-z0-9]{17}$/.test(q)) location.hash = `#/vin/${q.toUpperCase()}`;
    else err.textContent = q.length && q.length !== 17 ? `رقم الهيكل 17 خانة، وأنت كتبت ${q.length}` : 'اكتب رقم الهيكل كاملًا (17 خانة)';
  });
}

function landing() {
  render(main, html`
    <section class="pt-landing">
      <div class="pt-intro"><h1>تابع سيارتك من المزاد في أمريكا<br>حتى استلامها في ليبيا</h1>
        <p>مراحل الشحن، الحاوية وموعد الوصول، وصور السيارة — برقم الهيكل بس.</p></div>
      ${searchBox()}
      <div style="text-align:center"><a class="btn btn-ghost" href="/calc">🧮 حاسبة تكلفة الاستيراد</a></div>
    </section>`);
  bindSearch(main);
  $('[name=q]', main).focus();
}

/** صفحة التتبّع (بالكود أو برقم الهيكل): بلا مبالغ */
async function trackPage(c, again = '') {
  const urlOf = (id) => `/api/portal/track/${c.trackCode}/media/${c.id}/${id}`;
  render(main, html`<div class="no-print" style="margin-bottom:14px">${searchBox(again)}</div>${carDetails(c, { urlOf, withMoney: false })}`);
  bindSearch(main);
  bindPhotos(main, c, urlOf);
}
async function notFound(msg, again) {
  render(main, html`<div class="no-print" style="margin-bottom:14px">${searchBox(again)}</div><div class="card empty">${msg}</div>`);
  bindSearch(main);
}

async function carsPage() {
  const { items } = await api('/portal/cars');
  render(main, html`<div class="pt-title"><h1>سياراتي</h1><span class="faint">${items.length} سيارة</span></div>
    ${items.length ? html`<div class="pt-cars">${items.map((c) => html`<a class="card pt-car" href="#/cars/${c.id}">
      <div class="pt-car-img">${c.images[0] ? html`<img src="/api/portal/media/${c.id}/${c.images[0]}" alt="" loading="lazy">` : html`<span>🚗</span>`}
        <span class="pt-status">${c.statusLabel}</span></div>
      <div class="card-b"><h3 style="margin:0 0 2px">${title(c)}</h3><div class="mono faint" style="font-size:12px">${c.vin}</div>
        <div class="pt-mini">${STAGES.map((_, i) => html`<span class="${i <= c.stage ? 'on' : ''}"></span>`)}</div>
        <div class="row" style="justify-content:space-between;font-size:13px;gap:8px;flex-wrap:wrap">
          <span>${c.shipment?.eta && !c.shipment?.ata ? `الوصول المتوقّع ${fmt.date(c.shipment.eta)}` : STAGES[c.stage]?.[0] || ''}</span>
          ${c.price ? html`<b class="${Number(c.remaining) > 0.0005 ? 'neg' : 'pos'}">${Number(c.remaining) > 0.0005 ? `متبقي ${money(c.remaining, c.currency)}` : 'خالصة ✓'}</b>` : ''}</div></div></a>`)}</div>`
      : html`<div class="card empty">ما فيش سيارات مسجلة باسمك لتوا.</div>`}`);
}

async function carPage(id) {
  const c = await api(`/portal/cars/${id}`);
  const urlOf = (img) => `/api/portal/media/${c.id}/${img}`;
  const link = trackUrl(c.trackCode);
  render(main, html`<div class="row no-print" style="margin-bottom:12px;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="#/cars">← سياراتي</a>
      <div class="row" style="gap:6px"><button class="btn btn-sm" data-copy>نسخ رابط التتبّع</button>
        <a class="btn btn-sm btn-accent" target="_blank" rel="noopener noreferrer" href="https://wa.me/?text=${encodeURIComponent(`تتبّع سيارتي ${title(c)}: ${link}`)}">مشاركة واتساب</a></div></div>
    ${carDetails(c, { urlOf, withMoney: true })}`);
  bindPhotos(main, c, urlOf);
  $('[data-copy]', main).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('نُسخ رابط التتبّع', 'ok'); } catch { prompt('انسخ الرابط:', link); }
  });
}

async function statementPage() {
  const s = await api('/portal/statement');
  render(main, html`<div class="pt-title"><h1>كشف الحساب</h1><button class="btn btn-sm no-print" data-print>طباعة / PDF</button></div>
    <div class="print-only" style="margin-bottom:10px"><img class="print-logo" src="/brand/ggm-logo.svg" alt="Golden Gate Motors"><b>${s.name}</b> (${s.code}) — ${fmt.date(new Date())}</div>
    <div class="grid g3">${s.summary.length ? s.summary.map((x) => html`<div class="card card-b pt-kpi"><span>الرصيد بـ${{ USD: 'الدولار', LYD: 'الدينار', EUR: 'اليورو' }[x.currency]}</span>
      <b class="${Number(x.balance) > 0.0005 ? 'neg' : 'pos'}">${Number(x.balance) > 0.0005 ? `عليك ${money(x.balance, x.currency)}` : Number(x.balance) < -0.0005 ? `لك ${money(-x.balance, x.currency)}` : 'خالص ✓'}</b>
      <span class="faint" style="font-size:12px">المستحق ${money(x.charged, x.currency)} · المدفوع ${money(x.paid, x.currency)}</span></div>`) : html`<div class="card card-b empty">لا توجد حركات بعد</div>`}</div>
    ${s.lines.length ? html`<div class="card" style="margin-top:14px"><div class="table-wrap"><table class="t"><thead><tr><th>التاريخ</th><th>البيان</th><th class="n">عليك</th><th class="n">دفعت</th><th class="n">الرصيد</th></tr></thead>
      <tbody>${s.lines.map((l) => html`<tr style="${l.type === 'VOID' ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${fmt.date(l.date)}</td><td>${l.label}</td>
        <td class="n">${Number(l.debit) ? money(l.debit, l.currency) : ''}</td><td class="n pos">${Number(l.credit) ? money(l.credit, l.currency) : ''}</td><td class="n">${money(l.balance, l.currency)}</td></tr>`)}</tbody></table></div></div>` : ''}`);
  $('[data-print]', main).addEventListener('click', () => window.print());
}

function passwordPage() {
  render(main, html`<form class="card card-b pt-box" style="max-width:460px;margin:0 auto" data-pw novalidate>
    <h2>${me?.mustChange ? 'اختر كلمة سر جديدة' : 'تغيير كلمة السر'}</h2>
    ${me?.mustChange ? html`<p class="faint" style="margin:0">كلمة السر الحالية مؤقتة من الموظف. اختر كلمة سر خاصة بيك (8 خانات على الأقل).</p>` : ''}
    <label class="field">كلمة السر الحالية<input class="input" type="password" name="current" required autocomplete="current-password"></label>
    <label class="field">كلمة السر الجديدة<input class="input" type="password" name="next" required minlength="8" autocomplete="new-password"></label>
    <label class="field">تأكيد كلمة السر الجديدة<input class="input" type="password" name="again" required minlength="8" autocomplete="new-password"></label>
    <button class="btn btn-primary" style="min-height:44px">حفظ</button><div data-err role="alert" class="neg" style="min-height:1.4em"></div></form>`);
  const f = $('[data-pw]', main);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-err]', f);
    if (f.next.value !== f.again.value) { err.textContent = 'كلمتا السر غير متطابقتين'; return; }
    try {
      await api('/portal/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
      me.mustChange = false; toast('تم تغيير كلمة السر', 'ok'); location.hash = '#/cars';
    } catch (ex) { err.textContent = ex.message; }
  });
}

// ======================================================================= التوجيه
function drawNav() {
  const a = (href, l, cur) => html`<a href="${href}" class="${location.hash.startsWith(cur || href) ? 'on' : ''}">${l}</a>`;
  render(nav, me
    ? html`${a('#/cars', 'سياراتي')}${a('#/statement', 'كشف الحساب')}<a href="/calc">الحاسبة</a>${a('#/password', 'كلمة السر')}
        <span class="pt-me">${me.name}</span><button class="btn btn-sm" data-logout>خروج</button>`
    : html`<a href="#/">تتبّع سيارة</a><a href="/calc">حاسبة التكلفة</a>`);
  $('[data-logout]', nav)?.addEventListener('click', async () => { await api('/portal/logout', { method: 'POST', body: {} }).catch(() => {}); me = null; location.hash = '#/'; route(); });
}

async function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  drawNav();
  window.scrollTo(0, 0);
  try {
    let m;
    if ((m = h.match(/^\/track\/([0-9a-fA-F]{12})$/))) {
      try { return await trackPage(await api(`/portal/track/${m[1].toLowerCase()}`)); } catch (e) { return notFound(e.message, m[1]); }
    }
    if ((m = h.match(/^\/vin\/([A-Za-z0-9]{17})$/))) {
      try { return await trackPage(await api(`/portal/vin/${m[1].toUpperCase()}`), m[1].toUpperCase()); } catch (e) { return notFound(e.message, m[1].toUpperCase()); }
    }
    if (!me) return landing();
    if (me.mustChange && h !== '/password') { location.hash = '#/password'; return; }
    if (h === '/password') return passwordPage();
    if (h === '/statement') return await statementPage();
    if ((m = h.match(/^\/cars\/([0-9a-f-]{36})$/))) return await carPage(m[1]);
    if (h === '/' || h === '/cars') return await carsPage();
    location.hash = '#/cars';
  } catch (e) {
    if (e.status === 401) { me = null; drawNav(); return landing(); }
    render(main, html`<div class="card empty">${e.message}<div style="margin-top:10px"><a class="btn btn-sm" href="#/">رجوع</a></div></div>`);
  }
}

(async () => {
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* */ }
  // رابط التتبّع ?track=CODE يفتح صفحة التتبّع مباشرة
  const tc = new URLSearchParams(location.search).get('track');
  if (tc) { history.replaceState(null, '', `/portal#/track/${tc.toLowerCase()}`); }
  try { me = (await api('/portal/me')).customer; } catch { me = null; }
  window.addEventListener('hashchange', route);
  route();
})();
