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
        <button class="btn btn-primary" data-print>طباعة / PDF</button></div></div>
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
