// الحسابات المصرفية: قائمة الحسابات بأرصدتها، وكشف كل حساب (إيداع / صرف / سداد مصروف مسجل / سحب) قابل للطباعة.
import { html, render, $, $$, api, state, toast, modal, icon, localToday } from './core.js';
import { EXPENSE_CATEGORIES } from './views-finance.js';
import { attachmentLinks, pickInvoices, uploadInvoices, invoiceField } from './attachments.js';
import { downloadPdf } from './pdf.js';

const writer = () => ['ADMIN', 'ACCOUNTANT'].includes(state.user.role);
const n3 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const amt = (v) => (v == null ? '' : n3.format(Number(v)));
const day = (d) => (d ? d.split('-').reverse().join('/') : '—');
const KIND = { DEPOSIT: 'إيداع', EXPENSE: 'صرف', SETTLE: 'سداد مصروف مسجل', WITHDRAW: 'سحب نقدي' };
const opts = (list, cur) => list.map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`);
const clean = (r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''));

const accountFields = (a = {}) => html`
  <label class="field">اسم الحساب<input class="input" name="name" required minlength="2" maxlength="120" value="${a.name || ''}" placeholder="مثلًا: حساب الشركة المصرفي"></label>
  <div class="grid g2"><label class="field">المصرف<input class="input" name="bankName" maxlength="120" value="${a.bank_name || ''}"></label>
    <label class="field">رقم الحساب<input class="input" name="accountNo" maxlength="60" value="${a.account_no || ''}"></label></div>
  <label class="field">ملاحظة<input class="input" name="note" maxlength="300" value="${a.note || ''}"></label>`;

// ======================================================================= القائمة
export async function banksView(el) {
  const { items } = await api('/bank-accounts');
  render(el, html`
    <div class="row" style="justify-content:space-between;margin-bottom:14px;gap:8px">
      <div class="faint">حسابات الشركة في المصرف؛ الصرف منها يُسجَّل في المصاريف تلقائيًا، والإيداع لا يُحسب إيرادًا</div>
      ${writer() ? html`<button class="btn btn-accent" data-new>${icon('plus')} حساب جديد</button>` : ''}</div>
    <div class="card"><div class="table-wrap"><table class="t">
      <thead><tr><th>الحساب</th><th class="n">الإيداعات</th><th class="n">المصروف</th><th class="n">السحوبات</th><th class="n">الرصيد</th><th>آخر حركة</th></tr></thead>
      <tbody>${items.map((a) => html`<tr>
        <td><a href="#/bank/${a.id}"><b>${a.name}</b></a>${a.bank_name || a.note ? html`<div class="faint" style="font-size:12px">${[a.bank_name, a.note].filter(Boolean).join(' · ')}</div>` : ''}</td>
        <td class="n">${amt(a.deposited)}</td><td class="n">${amt(a.spent)}</td><td class="n">${amt(a.withdrawn)}</td>
        <td class="n"><b class="${Number(a.balance) < 0 ? 'neg' : ''}">${amt(a.balance)} د.ل</b></td><td>${day(a.last_date)}</td></tr>`)}</tbody></table>
      ${items.length ? '' : html`<div class="empty">لا توجد حسابات مصرفية بعد</div>`}</div></div>`);
  $('[data-new]', el)?.addEventListener('click', async () => {
    const r = await modal({ title: 'حساب مصرفي جديد', submitLabel: 'إنشاء', body: accountFields() });
    if (!r) return;
    try { const a = await api('/bank-accounts', { method: 'POST', body: clean(r) }); location.hash = `#/bank/${a.id}`; } catch (e) { toast(e.message, 'err'); }
  });
}

// ======================================================================= الكشف
export async function bankView(el, { params, setTitle }) {
  const s = await api(`/bank-accounts/${params.id}`);
  const a = s.account;
  setTitle(`كشف ${a.name}`);
  const reload = () => bankView(el, { params, setTitle });
  const t = s.totals;
  render(el, html`
    <div class="row no-print" style="justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="#/bank">${icon('right')} كل الحسابات المصرفية</a>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${writer() && a.is_active ? html`<button class="btn" data-add="DEPOSIT">إيداع</button>
          <button class="btn btn-accent" data-add="EXPENSE">${icon('plus')} صرف</button>
          <button class="btn" data-settle>سداد مصروف مسجل</button>
          <button class="btn" data-add="WITHDRAW">سحب نقدي</button>
          <button class="btn btn-ghost" data-edit>تعديل البيانات</button>` : ''}
        <button class="btn btn-primary" data-pdf>${icon('pdf')} تحميل PDF</button>
        <button class="btn" data-print>طباعة</button></div></div>
    <div class="card card-b stmt">
      <div class="stmt-head">
        <div><img src="/brand/ggm-logo-official.png" alt="Golden Gate Motors" style="height:68px"></div>
        <div style="text-align:end"><h2 style="margin:0">كشف ${a.name}</h2>
          ${a.bank_name || a.account_no ? html`<div class="faint">${[a.bank_name, a.account_no].filter(Boolean).join(' — ')}</div>` : ''}
          <div class="faint">${s.period.from ? `الفترة من ${day(s.period.from)} إلى ${day(s.period.to)}` : 'لا حركات بعد'}</div>
          <div class="faint">تاريخ الطباعة ${day(localToday())} · المبالغ بالدينار الليبي</div></div></div>
      <div class="stmt-kpis">
        <div><span>إجمالي الإيداعات</span><b class="num">${amt(t.in)}</b></div>
        <div><span>إجمالي الخارج</span><b class="num">${amt(t.out)}</b></div>
        <div class="stmt-bal"><span>الرصيد الحالي</span><b class="num ${Number(t.balance) < 0 ? 'neg' : ''}">${amt(t.balance)}</b></div></div>
      <div class="table-wrap"><table class="t stmt-t">
        <thead><tr><th class="n">#</th><th>التاريخ</th><th>الحركة</th><th class="n">دخول</th><th class="n">خروج</th><th class="n">الرصيد</th><th class="no-print"></th></tr></thead>
        <tbody>${s.entries.map((e) => html`<tr class="${e.voided ? 'stmt-void no-print' : ''}">
          <td class="n">${e.no ?? ''}</td><td>${day(e.date)}</td>
          <td><b>${e.description}</b><div class="faint" style="font-size:12px">${e.expenseId ? `${e.categoryLabel || 'مصروف'} · ${e.expenseNo}${e.paidBy ? ` · دفعها ${e.paidBy} ورُدّت له` : ''}` : KIND[e.kind]}</div>
            ${e.voided ? html`<div class="faint">ملغاة: ${e.voidReason}</div>` : ''}
            ${e.expenseId && !e.voided ? html`<div class="att-row no-print">${attachmentLinks(e.attachments)}${writer() ? html`<button class="btn btn-sm btn-ghost" data-attach="${e.expenseId}">${e.attachments.length ? '+ فاتورة' : '📎 إرفاق فاتورة'}</button>` : ''}
              ${e.attachments.length ? '' : html`<span class="badge-warn">بلا فاتورة</span>`}</div>` : ''}</td>
          <td class="n">${amt(e.in)}</td><td class="n">${amt(e.out)}</td><td class="n"><b>${amt(e.balance)}</b></td>
          <td class="no-print">${!e.voided && writer() ? html`<button class="btn btn-sm btn-ghost" data-void="${e.id}" data-kind="${e.kind}">إلغاء</button>` : ''}</td></tr>`)}</tbody>
        <tfoot><tr><th></th><th></th><th>المجموع</th><th class="n">${amt(t.in)}</th><th class="n">${amt(t.out)}</th><th class="n">${amt(t.balance)}</th><th class="no-print"></th></tr></tfoot></table>
        ${s.entries.length ? '' : html`<div class="empty">لا حركات في هذا الحساب بعد</div>`}</div>
      <div class="receipt-sign"><div>المدير<br><span></span></div><div>المحاسب<br><span></span></div></div>
    </div>`);
  $('[data-print]', el).addEventListener('click', () => window.print());
  $('[data-pdf]', el).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try { await downloadPdf($('.stmt', el), `كشف ${a.name} ${day(localToday()).replaceAll('/', '-')}.pdf`); } catch (e) { toast(`تعذّر إنشاء الملف: ${e.message}`, 'err'); } finally { btn.disabled = false; }
  });
  const send = (body) => api(`/bank-accounts/${a.id}/entries`, { method: 'POST', body });
  $$('[data-add]', el).forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.add, today = localToday();
    const r = await modal({ title: `${KIND[kind]} — ${a.name}`, submitLabel: 'حفظ', body: html`
      <div class="grid g2"><label class="field">التاريخ<input class="input" type="date" name="entryDate" value="${today}" max="${today}" required></label>
        <label class="field">المبلغ (د.ل)<input class="input num" name="amount" required inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?"></label></div>
      ${kind === 'EXPENSE' ? html`<div class="grid g2"><label class="field">البند<select class="input" name="category">${opts(EXPENSE_CATEGORIES, 'OTHER')}</select></label>
        <label class="field">المرجع<input class="input" name="reference" maxlength="80" placeholder="رقم الفاتورة أو الصك"></label></div>` : ''}
      <label class="field">البيان<input class="input" name="description" required minlength="2" maxlength="300" placeholder="${kind === 'DEPOSIT' ? 'مثلًا: إيداع رأس مال من الملاك' : ''}"></label>
      ${kind === 'EXPENSE' ? html`${invoiceField()}<p class="faint" style="margin:0">يُسجَّل أيضًا في مصاريف الشركة. لو المصروف مسجل من قبل استعمل «سداد مصروف مسجل» حتى لا يتكرر.</p>` : ''}
      ${kind === 'WITHDRAW' ? html`<p class="faint" style="margin:0">نقد خرج من المصرف، وليس مصروفًا.</p>` : ''}` });
    if (!r) return;
    const { invoice = [], ...body } = r;
    try {
      const e = await send({ ...clean(body), kind });
      if (e.expense_id) await uploadInvoices(e.expense_id, invoice);
      toast('سُجّلت الحركة', 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  }));
  $('[data-settle]', el)?.addEventListener('click', async () => {
    let items;
    try { ({ items } = await api('/bank-accounts/payable')); } catch (e) { toast(e.message, 'err'); return; }
    if (!items.length) { toast('لا توجد مصاريف مسجلة تنتظر السداد من المصرف', 'err'); return; }
    const today = localToday();
    const label = (x) => `${day(x.expense_date)} · ${x.description} · ${amt(x.amount_lyd)} د.ل${x.paid_by ? ` · دفعها ${x.paid_by}${x.reimbursed_at ? '' : ' (مستحقة له)'}` : ''}`;
    const r = await modal({ title: `سداد مصروف مسجل — ${a.name}`, submitLabel: 'سداد', body: html`
      <label class="field">المصروف<select class="input" name="expenseId" required>${opts(items.map((x) => [x.id, label(x)]), items[0].id)}</select></label>
      <label class="field">تاريخ السداد<input class="input" type="date" name="entryDate" value="${today}" max="${today}" required></label>
      <p class="faint" style="margin:0">ينقص المبلغ من رصيد الحساب دون تسجيل مصروف جديد، وإن كان شخص دفعه من ماله تُسجَّل ردّته.</p>` });
    if (!r) return;
    try { await send({ ...r, kind: 'SETTLE' }); toast('سُجّل السداد', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  });
  $('[data-edit]', el)?.addEventListener('click', async () => {
    const r = await modal({ title: 'بيانات الحساب', submitLabel: 'حفظ', body: accountFields(a) });
    if (!r) return;
    try { await api(`/bank-accounts/${a.id}`, { method: 'PUT', body: clean(r) }); toast('حُفظت البيانات', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-attach]', el).forEach((b) => b.addEventListener('click', async () => { if (await pickInvoices(b.dataset.attach)) reload(); }));
  $$('[data-void]', el).forEach((b) => b.addEventListener('click', async () => {
    const note = { EXPENSE: 'يُلغى مصروفها أيضًا ويرجع المبلغ لرصيد الحساب.', SETTLE: 'يرجع المبلغ لرصيد الحساب ويبقى المصروف مسجلًا.' }[b.dataset.kind] || '';
    const r = await modal({ title: 'إلغاء حركة', submitLabel: 'إلغاء الحركة', danger: true, body: html`<label class="field">السبب (إلزامي)<input class="input" name="reason" required minlength="3" maxlength="300"></label>
      ${note ? html`<p class="faint" style="margin:0">${note}</p>` : ''}` });
    if (!r) return;
    try { await api(`/bank-entries/${b.dataset.void}/void`, { method: 'POST', body: { reason: r.reason } }); toast('أُلغيت الحركة', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  }));
}
