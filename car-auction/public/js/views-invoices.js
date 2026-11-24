// أرشيف الفواتير: كل مصاريف الشركة في كل الشهور مع صور فواتيرها، بحث بالنص والتاريخ، وإظهار الناقص.
import { html, render, $, $$, api, state, icon } from './core.js';
import { money } from './views-accounts.js';
import { EXPENSE_CATEGORIES } from './views-finance.js';
import { pickInvoices } from './attachments.js';

const can = (...roles) => roles.includes(state.user.role);
const day = (d) => (d ? d.split('-').reverse().join('/') : '—');
const fileUrl = (a) => `/api/expense-attachments/${a.id}`;

export async function invoicesView(el, { query }) {
  const f = { q: query.q || '', from: query.from || '', to: query.to || '', missing: query.missing === '1' };
  const qs = new URLSearchParams(Object.entries({ ...f, missing: f.missing ? '1' : '' }).filter(([, v]) => v)).toString();
  const r = await api(`/expenses/invoices${qs ? `?${qs}` : ''}`);
  const reload = () => invoicesView(el, { query });
  const source = (e) => (e.custody_holder ? `من عهدة ${e.custody_holder}`
    : e.bank_account && !e.paid_by ? `من ${e.bank_account}`
    : e.paid_by ? `دفعها ${e.paid_by} من ماله${e.reimbursed_at ? ' · رُدّت له' : ' · مستحقة له'}` : 'من الشركة');
  render(el, html`
    <form class="card filters" data-filters style="margin-bottom:16px">
      <label class="field" style="flex:2">بحث<input class="input" name="q" value="${f.q}" placeholder="الوصف، رقم المصروف أو الفاتورة، اسم الشخص"></label>
      <label class="field">من<input class="input" type="date" name="from" value="${f.from}"></label>
      <label class="field">إلى<input class="input" type="date" name="to" value="${f.to}"></label>
      <label class="calc-check" style="align-self:end"><input type="checkbox" name="missing" value="1" ${f.missing ? 'checked' : ''}> <span>بلا فاتورة فقط</span></label>
      <button class="btn btn-primary">عرض</button>
      ${qs ? html`<a class="btn btn-ghost" href="#/invoices">مسح</a>` : ''}
    </form>
    <div class="grid g3" style="margin-bottom:16px">
      <div class="card card-b"><div class="faint">كل المصاريف</div><div class="num" style="font-size:24px;font-weight:700">${r.totals.expenses}</div></div>
      <div class="card card-b"><div class="faint">بفاتورة مرفقة</div><div class="num pos" style="font-size:24px;font-weight:700">${r.totals.withInvoice}</div></div>
      <a class="card card-b" href="#/invoices?missing=1" style="text-decoration:none;color:inherit"><div class="faint">بلا فاتورة</div><div class="num ${r.totals.missing ? 'neg' : ''}" style="font-size:24px;font-weight:700">${r.totals.missing}</div></a>
    </div>
    ${r.items.length ? html`<div class="inv-grid">${r.items.map((e) => html`<div class="card inv-card">
      <div class="inv-thumbs">${e.attachments.length ? e.attachments.map((a) => (a.mime === 'application/pdf'
        ? html`<a class="inv-pdf" href="${fileUrl(a)}" target="_blank" rel="noopener">${icon('pdf')}<span>PDF</span></a>`
        : html`<a href="${fileUrl(a)}" target="_blank" rel="noopener"><img src="${fileUrl(a)}" alt="${a.filename}" loading="lazy"></a>`))
        : html`<div class="inv-none">بلا فاتورة</div>`}</div>
      <div class="card-b inv-body">
        <div class="row" style="justify-content:space-between;gap:8px"><b>${e.description}</b><b class="num" style="white-space:nowrap">${money(e.amount, e.currency)}</b></div>
        <div class="faint" style="font-size:12px">${day(e.expense_date)} · <span class="mono">${e.expense_no}</span> · ${EXPENSE_CATEGORIES.find(([k]) => k === e.category)?.[1] || e.category}</div>
        <div style="font-size:12px">${source(e)}${e.reference ? html` · <span class="faint">${e.reference}</span>` : ''}</div>
        ${can('ADMIN', 'ACCOUNTANT') ? html`<button class="btn btn-sm btn-ghost" data-attach="${e.id}" style="margin-top:6px">${e.attachments.length ? '+ فاتورة' : '📎 إرفاق فاتورة'}</button>` : ''}
      </div></div>`)}</div>
      ${r.items.length >= 500 ? html`<p class="faint">يُعرض أحدث 500 مصروف؛ ضيّق البحث بالتاريخ لرؤية الأقدم.</p>` : ''}`
      : html`<div class="card"><div class="empty">لا مصاريف بهذا البحث</div></div>`}`);
  $('[data-filters]', el).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const p = new URLSearchParams([...new FormData(ev.target)].filter(([, v]) => v)).toString();
    location.hash = `#/invoices${p ? `?${p}` : ''}`;
  });
  $$('[data-attach]', el).forEach((b) => b.addEventListener('click', async () => { if (await pickInvoices(b.dataset.attach)) reload(); }));
}
