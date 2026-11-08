// العُهد النقدية: قائمة العهد بأرصدتها، وكشف كل عهدة (استلام / صرف / إرجاع) قابل للطباعة.
import { html, render, $, $$, api, fmt, state, toast, modal, icon } from './core.js';
import { EXPENSE_CATEGORIES } from './views-finance.js';

const can = (...roles) => roles.includes(state.user.role);
const writer = () => can('ADMIN', 'ACCOUNTANT');
const n3 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const amt = (v) => (v == null ? '' : n3.format(Number(v)));
const day = (d) => (d ? d.split('-').reverse().join('/') : '—'); // YYYY-MM-DD → DD/MM/YYYY بلا تحويل منطقة زمنية
const KIND = { RECEIPT: 'استلام من الخزينة', EXPENSE: 'صرف', RETURN: 'إرجاع للخزينة' };
const opts = (list, cur) => list.map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`);

// ======================================================================= تحميل PDF
// المتصفح نفسه يرسم الكشف صورةً (SVG foreignObject)، فيبقى العربي ووصل الحروف والمسافات كما على الشاشة؛
// ورسم html2canvas للنص العربي يلزق الكلمات ببعض. ثم jsPDF (من /vendor، تُحمَّل عند أول ضغطة؛ CSP لا تسمح بسكربت خارجي)
// يضع الصورة في صفحات A4 مقطوعة بين السطور لا في وسطها.
const PDF_W = 720; // عرض المحتوى بالبكسل = 190 مم (A4 ناقص هامشين 10 مم)
const PDF_SCALE = 2;
const PAGE_H = (PDF_W * 277) / 190; // ارتفاع 277 مم بنفس المقياس
let pdfLib, cssText;
const loadPdfLib = () => (pdfLib ??= new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: '/vendor/html2pdf.bundle.min.js' });
  s.onload = () => resolve(window.html2pdf);
  s.onerror = () => { pdfLib = null; reject(new Error('تعذّر تحميل أداة PDF')); };
  document.head.appendChild(s);
}));
const dataUrl = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

/** يرسم العقدة على لوحة بعرض صفحة A4 بالألوان الفاتحة، ويعيد مواضع القطع الممكنة (نهايات السطور) */
async function snapshot(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('.no-print').forEach((x) => x.remove());
  copy.style.cssText = `width:${PDF_W}px;max-width:none;margin:0;box-shadow:none;border:0;border-radius:0`;
  copy.querySelectorAll('.table-wrap').forEach((x) => { x.style.overflow = 'visible'; });
  // الصورة داخل SVG لا تجلب ملفات خارجية: الشعار يُضمَّن
  for (const im of copy.querySelectorAll('img')) im.src = await dataUrl(await fetch(im.src).then((r) => r.blob()));
  cssText ??= await fetch([...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href).find((h) => h.startsWith(location.origin))).then((r) => r.text());

  const root = document.documentElement;
  const theme = root.dataset.theme;
  root.dataset.theme = 'light';
  const probe = Object.assign(document.createElement('div'), { dir: 'rtl' });
  probe.style.cssText = `position:absolute;top:0;left:0;width:${PDF_W}px;visibility:hidden`;
  probe.appendChild(copy);
  document.body.appendChild(probe);
  const top = copy.getBoundingClientRect().top;
  const height = Math.ceil(copy.getBoundingClientRect().height) + 2;
  const cuts = [...copy.querySelectorAll('thead tr, tbody tr, tfoot tr, .stmt-kpis')].map((x) => Math.ceil(x.getBoundingClientRect().bottom - top));
  probe.remove();
  if (theme) root.dataset.theme = theme; else delete root.dataset.theme;

  const font = '*{font-family:"Segoe UI",Tahoma,Arial,sans-serif !important}';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-theme="light" width="${PDF_W}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" dir="rtl" lang="ar" style="width:${PDF_W}px;background:#fff"><style>${cssText.replace(/<\//g, '<\\/')}${font}</style>`
    + `${new XMLSerializer().serializeToString(copy)}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: PDF_W * PDF_SCALE, height: height * PDF_SCALE });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(PDF_SCALE, PDF_SCALE);
  ctx.drawImage(img, 0, 0);
  return { canvas, height, cuts };
}

/** يقطع اللوحة صفحات عند نهايات السطور */
function paginate({ canvas, height, cuts }) {
  const pages = [];
  for (let start = 0; start < height;) {
    const limit = start + PAGE_H;
    const end = height <= limit ? height : Math.max(...cuts.filter((c) => c > start && c <= limit), Math.floor(limit));
    const page = Object.assign(document.createElement('canvas'), { width: canvas.width, height: Math.ceil((end - start) * PDF_SCALE) });
    page.getContext('2d').drawImage(canvas, 0, start * PDF_SCALE, canvas.width, page.height, 0, 0, canvas.width, page.height);
    pages.push(page);
    start = end;
  }
  return pages;
}

async function downloadPdf(node, filename) {
  const [html2pdf, shot] = await Promise.all([loadPdfLib(), snapshot(node)]);
  const [first, ...rest] = paginate(shot);
  const pdf = await html2pdf().set({ margin: 10, image: { type: 'jpeg', quality: 0.95 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } })
    .from(first, 'canvas').toPdf().get('pdf');
  for (const p of rest) {
    pdf.addPage();
    pdf.addImage(p.toDataURL('image/jpeg', 0.95), 'JPEG', 10, 10, 190, (p.height / PDF_SCALE) * (190 / PDF_W));
  }
  pdf.save(filename);
}

// ======================================================================= القائمة
export async function custodiesView(el) {
  const { items } = await api('/custodies');
  render(el, html`
    <div class="row" style="justify-content:space-between;margin-bottom:14px;gap:8px">
      <div class="faint">مبلغ يستلمه شخص من الخزينة ويصرف منه؛ الصرف يُسجَّل في المصاريف تلقائيًا</div>
      ${writer() ? html`<button class="btn btn-accent" data-new>${icon('plus')} عهدة جديدة</button>` : ''}</div>
    <div class="card"><div class="table-wrap"><table class="t">
      <thead><tr><th>صاحب العهدة</th><th class="n">المستلم</th><th class="n">المصروف</th><th class="n">المرجَع</th><th class="n">الرصيد</th><th>آخر حركة</th></tr></thead>
      <tbody>${items.map((k) => html`<tr>
        <td><a href="#/custody/${k.id}"><b>${k.holder_name}</b></a>${k.note ? html`<div class="faint" style="font-size:12px">${k.note}</div>` : ''}</td>
        <td class="n">${amt(k.received)}</td><td class="n">${amt(k.spent)}</td><td class="n">${amt(k.returned)}</td>
        <td class="n"><b class="${Number(k.balance) < 0 ? 'neg' : ''}">${amt(k.balance)} د.ل</b></td><td>${day(k.last_date)}</td></tr>`)}</tbody></table>
      ${items.length ? '' : html`<div class="empty">لا توجد عهد بعد</div>`}</div></div>`);
  $('[data-new]', el)?.addEventListener('click', async () => {
    const r = await modal({ title: 'عهدة جديدة', submitLabel: 'إنشاء', body: html`
      <label class="field">صاحب العهدة<input class="input" name="holderName" required minlength="2" maxlength="120"></label>
      <label class="field">ملاحظة<input class="input" name="note" maxlength="300"></label>` });
    if (!r) return;
    try {
      const k = await api('/custodies', { method: 'POST', body: Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '')) });
      location.hash = `#/custody/${k.id}`;
    } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================================================================= الكشف
export async function custodyView(el, { params, setTitle }) {
  const s = await api(`/custodies/${params.id}`);
  const k = s.custody;
  setTitle(`كشف عهدة ${k.holder_name}`);
  const reload = () => custodyView(el, { params, setTitle });
  const t = s.totals;
  render(el, html`
    <div class="row no-print" style="justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="#/custody">${icon('right')} كل العهد</a>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${writer() && k.is_active ? html`<button class="btn" data-add="RECEIPT">استلام من الخزينة</button>
          <button class="btn btn-accent" data-add="EXPENSE">${icon('plus')} صرف</button>
          <button class="btn" data-add="RETURN">إرجاع للخزينة</button>` : ''}
        <button class="btn btn-primary" data-pdf>${icon('pdf')} تحميل PDF</button>
        <button class="btn" data-print>طباعة</button></div></div>
    <div class="card card-b stmt">
      <div class="stmt-head">
        <div><img src="/brand/ggm-logo-official.png" alt="Golden Gate Motors" style="height:68px"></div>
        <div style="text-align:end"><h2 style="margin:0">كشف عهدة ${k.holder_name}</h2>
          <div class="faint">${s.period.from ? `الفترة من ${day(s.period.from)} إلى ${day(s.period.to)}` : 'لا حركات بعد'}</div>
          <div class="faint">تاريخ الطباعة ${day(new Date().toISOString().slice(0, 10))} · المبالغ بالدينار الليبي</div></div></div>
      <div class="stmt-kpis">
        <div><span>إجمالي المستلم</span><b class="num">${amt(t.in)}</b></div>
        <div><span>إجمالي المصروف والمرجَع</span><b class="num">${amt(t.out)}</b></div>
        <div class="stmt-bal"><span>الرصيد الحالي</span><b class="num ${Number(t.balance) < 0 ? 'neg' : ''}">${amt(t.balance)}</b></div></div>
      <div class="table-wrap"><table class="t stmt-t">
        <thead><tr><th class="n">#</th><th>التاريخ</th><th>الحركة</th><th class="n">دخول</th><th class="n">خروج</th><th class="n">الرصيد</th><th class="no-print"></th></tr></thead>
        <tbody>${s.entries.map((e) => html`<tr class="${e.voided ? 'stmt-void no-print' : ''}">
          <td class="n">${e.no ?? ''}</td><td>${day(e.date)}</td>
          <td><b>${e.description}</b><div class="faint" style="font-size:12px">${e.kind === 'EXPENSE' ? `${e.categoryLabel || 'مصروف'} · ${e.expenseNo}` : KIND[e.kind]}</div>
            ${e.voided ? html`<div class="faint">ملغاة: ${e.voidReason}</div>` : ''}</td>
          <td class="n">${amt(e.in)}</td><td class="n">${amt(e.out)}</td><td class="n"><b>${amt(e.balance)}</b></td>
          <td class="no-print">${!e.voided && writer() ? html`<button class="btn btn-sm btn-ghost" data-void="${e.id}">إلغاء</button>` : ''}</td></tr>`)}</tbody>
        <tfoot><tr><th></th><th></th><th>المجموع</th><th class="n">${amt(t.in)}</th><th class="n">${amt(t.out)}</th><th class="n">${amt(t.balance)}</th><th class="no-print"></th></tr></tfoot></table>
        ${s.entries.length ? '' : html`<div class="empty">لا حركات في هذه العهدة بعد</div>`}</div>
      <div class="receipt-sign"><div>صاحب العهدة<br><span></span></div><div>المحاسب<br><span></span></div></div>
    </div>`);
  $('[data-print]', el).addEventListener('click', () => window.print());
  $('[data-pdf]', el).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try { await downloadPdf($('.stmt', el), `كشف عهدة ${k.holder_name} ${day(new Date().toISOString().slice(0, 10)).replaceAll('/', '-')}.pdf`); } catch (e) { toast(`تعذّر إنشاء الملف: ${e.message}`, 'err'); } finally { btn.disabled = false; }
  });
  $$('[data-add]', el).forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.add;
    const today = new Date().toISOString().slice(0, 10);
    const r = await modal({ title: `${KIND[kind]} — عهدة ${k.holder_name}`, submitLabel: 'حفظ', body: html`
      <div class="grid g2"><label class="field">التاريخ<input class="input" type="date" name="entryDate" value="${today}" max="${today}" required></label>
        <label class="field">المبلغ (د.ل)<input class="input num" name="amount" required inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?"></label></div>
      ${kind === 'EXPENSE' ? html`<label class="field">البند<select class="input" name="category">${opts(EXPENSE_CATEGORIES, 'OTHER')}</select></label>` : ''}
      <label class="field">البيان<input class="input" name="description" required minlength="2" maxlength="300" value="${kind === 'RECEIPT' ? 'استلام العهدة من الخزينة' : kind === 'RETURN' ? 'إرجاع الباقي للخزينة' : ''}"></label>
      ${kind === 'EXPENSE' ? html`<p class="faint" style="margin:0">يُسجَّل أيضًا في مصاريف الشركة فيدخل في الربح الشهري.</p>` : ''}` });
    if (!r) return;
    try { await api(`/custodies/${k.id}/entries`, { method: 'POST', body: { ...r, kind } }); toast('سُجّلت الحركة', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-void]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = await modal({ title: 'إلغاء حركة', submitLabel: 'إلغاء الحركة', danger: true, body: html`<label class="field">السبب (إلزامي)<input class="input" name="reason" required minlength="3" maxlength="300"></label>
      <p class="faint" style="margin:0">إن كانت صرفًا يُلغى مصروفها أيضًا ويرجع المبلغ لرصيد العهدة.</p>` });
    if (!r) return;
    try { await api(`/custody-entries/${b.dataset.void}/void`, { method: 'POST', body: { reason: r.reason } }); toast('أُلغيت الحركة', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  }));
}
