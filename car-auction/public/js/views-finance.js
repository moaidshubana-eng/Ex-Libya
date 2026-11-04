// الإيصالات (قبض من العميل / صرف للمورد)، لوحة «لنا وعلينا»، ومصاريف الشركة مع الربح الشهري.
import { html, render, $, $$, api, fmt, state, toast, modal, icon } from './core.js';
import { money } from './views-accounts.js';

const can = (...roles) => roles.includes(state.user.role);
const CUR_NAME = { USD: 'دولار', LYD: 'دينار', EUR: 'يورو' };
const METHOD = { CASH: 'نقدًا', BANK_TRANSFER: 'حوالة مصرفية', CHEQUE: 'صك', CARD: 'بطاقة', OTHER: 'أخرى' };
export const EXPENSE_CATEGORIES = [
  ['RENT', 'إيجار'], ['SALARIES', 'رواتب'], ['UTILITIES', 'كهرباء ومياه واتصالات'], ['FUEL_TRANSPORT', 'وقود ومواصلات'], ['MARKETING', 'دعاية وتسويق'],
  ['GOVERNMENT_FEES', 'رسوم حكومية وتراخيص'], ['OFFICE', 'مستلزمات مكتب'], ['MAINTENANCE', 'صيانة'], ['BANK_FEES', 'عمولات مصرفية'], ['OTHER', 'أخرى'],
];
const opts = (list, cur) => list.map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`);
const lyd = (v) => money(v, 'LYD');

// ======================================================================= الإيصال
export async function receiptView(el, { params, setTitle }) {
  const r = await api(`/account-payments/${params.id}/receipt`);
  const p = r.payment;
  const isCustomer = p.partyType === 'CUSTOMER';
  const title = isCustomer ? 'إيصال قبض' : 'سند صرف';
  setTitle(`${title} ${p.receiptNo}`);
  const balText = (b) => {
    const n = Number(b.balance);
    if (Math.abs(n) < 0.0005) return `${CUR_NAME[b.currency]}: خالص`;
    return `${CUR_NAME[b.currency]}: ` + (isCustomer ? (n > 0 ? `متبقي عليه ${money(n, b.currency)}` : `رصيد له ${money(-n, b.currency)}`)
      : (n > 0 ? `متبقي له ${money(n, b.currency)}` : `مدفوع زيادة ${money(-n, b.currency)}`));
  };
  const row = (k, v) => html`<tr><th>${k}</th><td>${v}</td></tr>`;
  render(el, html`
    <div class="row no-print" style="justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap">
      <a class="btn btn-ghost btn-sm" href="#/accounts/${isCustomer ? 'customer' : 'vendor'}/${r.party.id}">${icon('right')} كشف حساب ${r.party.name}</a>
      <button class="btn btn-primary" data-print>طباعة / PDF</button></div>
    <div class="card card-b receipt">
      ${p.voided ? html`<div class="alert danger" style="margin-bottom:12px"><b>ملغى:</b> ${p.voidReason}</div>` : ''}
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid var(--brand);padding-bottom:12px">
        <div><img src="/brand/ggm-logo-official.png" alt="Golden Gate Motors" style="height:72px"><div class="faint" style="margin-top:4px">منظومة الاستيراد والمزايدة</div></div>
        <div style="text-align:end"><h2 style="margin:0">${title}</h2><div class="mono" style="font-size:18px;font-weight:700">${p.receiptNo}</div>
          <div class="faint">${fmt.date(p.paidAt)}</div></div></div>
      <div class="receipt-amount">
        <span>${isCustomer ? 'استلمنا من' : 'دفعنا إلى'}</span><b>${r.party.name}${r.party.code ? ` (${r.party.code})` : ''}</b>
        <span>مبلغ وقدره</span><b class="num" style="font-size:26px">${money(p.amount, p.currency)}</b>
        ${p.currency !== p.settleCurrency ? html`<span>يُحتسب</span><b class="num">${money(p.settleAmount, p.settleCurrency)} <span class="faint" style="font-weight:400">بسعر صرف ${Number(p.fxRate)} د.ل لل${CUR_NAME[p.currency === 'LYD' ? p.settleCurrency : p.currency]}</span></b>` : ''}
      </div>
      <table class="t receipt-t"><tbody>
        ${row('البيان', r.vehicle ? html`${isCustomer ? 'دفعة عن السيارة' : 'دفعة مقابل السيارة'} <b class="mono">${r.vehicle.stockNo}</b> — ${r.vehicle.title} <span class="mono faint">${r.vehicle.vin}</span>` : 'دفعة على الحساب')}
        ${row('طريقة الدفع', `${METHOD[p.method] || p.method}${p.reference ? ` — مرجع ${p.reference}` : ''}`)}
        ${p.note ? row('ملاحظة', p.note) : ''}
        ${r.vehicleRemaining.map((v) => row('المتبقي على السيارة الآن', Number(v.remaining) > 0.0005 ? money(v.remaining, v.currency) : 'خالصة'))}
        ${row('الرصيد بعد هذه الدفعة', r.balancesAfter.map(balText).join(' · ') || '—')}
      </tbody></table>
      <div class="receipt-sign"><div>المستلم<br><span></span></div><div>${isCustomer ? 'العميل' : 'المورد'}<br><span></span></div></div>
      <div class="faint" style="font-size:12px;margin-top:10px">سُجّل بواسطة ${p.createdBy || '—'} · ${fmt.dt(p.createdAt)}</div>
    </div>`);
  $('[data-print]', el).addEventListener('click', () => window.print());
}

// ======================================================================= لنا وعلينا (لوحة المؤشرات)
export async function overviewSection() {
  if (!can('ADMIN', 'ACCOUNTANT', 'SALES', 'OPERATIONS', 'VIEWER')) return '';
  let o;
  try { o = await api('/accounts/overview'); } catch { return ''; }
  const list = (arr) => (arr.length ? arr.map((x) => html`<div class="num" style="font-size:22px;font-weight:700">${money(x.amount, x.currency)}</div>`) : html`<div class="num" style="font-size:22px;font-weight:700">0</div>`);
  const top = (rows, type) => (rows.length ? html`<table class="t" style="margin-top:8px"><tbody>${rows.map((t) => html`<tr>
      <td><a href="#/accounts/${type}/${t.id}">${t.name}</a></td><td class="n">${t.balances.map((b) => money(b.balance, b.currency)).join(' + ')}</td></tr>`)}</tbody></table>` : html`<div class="faint" style="margin-top:8px">لا توجد مبالغ مستحقة</div>`);
  const box = (title, sub, part, type, color) => html`<div class="card card-b" style="border-top:3px solid ${color}">
    <div class="row" style="justify-content:space-between"><b>${title}</b><a class="btn btn-sm btn-ghost" href="#/accounts?tab=${type}s">كل الحسابات</a></div>
    <div class="faint" style="margin-bottom:4px">${sub(part)}</div>${list(part.owed)}
    ${part.credit.length ? html`<div class="faint" style="margin-top:4px">مقابل أرصدة ${type === 'customer' ? 'لعملاء' : 'مدفوعة مقدمًا'}: ${part.credit.map((c) => money(c.amount, c.currency)).join(' · ')}</div>` : ''}
    <div style="margin-top:10px;font-weight:600">${type === 'customer' ? 'أكبر المدينين' : 'أكبر المستحقين'}</div>${top(part.top, type)}</div>`;
  return html`<div class="grid g2" style="margin-top:16px">
    ${o.customers ? box('لنا عند العملاء', (p) => `${p.parties} عميل عليهم مبالغ`, o.customers, 'customer', 'var(--success)') : ''}
    ${o.vendors ? box('علينا للموردين', (p) => `${p.parties} مورد لهم مبالغ`, o.vendors, 'vendor', 'var(--danger)') : ''}
  </div>`;
}

// ======================================================================= المصاريف والأرباح
export async function financeView(el, { query }) {
  const month = query.month || new Date().toISOString().slice(0, 7);
  const [p, ex] = await Promise.all([api(`/reports/profit?month=${month}`), api(`/expenses?month=${month}`)]);
  const t = p.totals;
  const kpi = (label, v, color, sub = '') => html`<div class="card card-b"><div class="faint">${label}</div><div class="num" style="font-size:24px;font-weight:700;color:${color}">${lyd(v)}</div>${sub ? html`<div class="faint" style="font-size:12px">${sub}</div>` : ''}</div>`;
  const reload = () => financeView(el, { query: { month } });
  render(el, html`
    <div class="print-only" style="margin-bottom:10px"><img class="print-logo" src="/brand/ggm-logo-official.png" alt="Golden Gate Motors"><h2 style="margin:4px 0">الأرباح والمصاريف — ${month}</h2></div>
    <form class="card filters no-print" data-month style="margin-bottom:16px"><label class="field">الشهر<input class="input" type="month" name="month" value="${month}"></label>
      <button class="btn btn-primary">عرض</button>
      ${can('ADMIN', 'ACCOUNTANT') ? html`<button type="button" class="btn btn-accent" data-new>${icon('plus')} مصروف جديد</button>` : ''}
      <button type="button" class="btn" data-print>طباعة / PDF</button></form>
    ${p.warnings.map((w) => html`<div class="alert danger" style="margin-bottom:10px">${w}</div>`)}
    <div class="grid g4">
      ${kpi('إيراد السيارات المباعة', t.revenueLyd, 'var(--text)', `${p.cars.length} سيارة`)}
      ${kpi('تكلفتها الواصلة', t.costLyd, 'var(--text)')}
      ${kpi('مصاريف الشركة', t.expensesLyd, 'var(--danger)')}
      ${kpi('صافي الربح', t.netProfitLyd, Number(t.netProfitLyd) >= 0 ? 'var(--success)' : 'var(--danger)', `الربح الإجمالي ${lyd(t.grossProfitLyd)}`)}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>السيارات المباعة في الشهر</h2><span class="faint">الإيراد − التكلفة الواصلة، بالدينار</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>السيارة</th><th>النوع</th><th>العميل</th><th>التاريخ</th><th class="n">الإيراد</th><th class="n">التكلفة</th><th class="n">الربح</th></tr></thead>
        <tbody>${p.cars.map((c) => html`<tr><td><a href="#/vehicles/${c.vehicleId}"><b class="mono">${c.stockNo}</b></a> ${c.title}</td>
          <td>${c.kind}<div class="faint" style="font-size:12px">${c.ref}</div></td><td>${c.customer}</td><td>${fmt.date(c.soldAt)}</td>
          <td class="n">${c.revenueLyd == null ? '—' : lyd(c.revenueLyd)}</td><td class="n">${lyd(c.costLyd)}</td>
          <td class="n">${c.profitLyd == null ? '—' : html`<b class="${Number(c.profitLyd) >= 0 ? 'pos' : 'neg'}">${lyd(c.profitLyd)}</b>`}</td></tr>`)}</tbody></table>
        ${p.cars.length ? '' : html`<div class="empty">لا توجد سيارات مباعة في هذا الشهر</div>`}</div></div>
    <div class="grid g2" style="margin-top:16px;align-items:start">
      <div class="card"><div class="card-h"><h2>المصاريف حسب البند</h2></div>
        <div class="table-wrap"><table class="t"><tbody>${p.expenses.map((e) => html`<tr><td>${e.label}</td><td class="n">${e.n}</td><td class="n"><b>${lyd(e.total_lyd)}</b></td></tr>`)}
          <tr><th>الإجمالي</th><th></th><th class="n">${lyd(t.expensesLyd)}</th></tr></tbody></table></div></div>
      <div class="card"><div class="card-h"><h2>قيود المصاريف</h2><span class="faint">${ex.items.length} قيد</span></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>التاريخ</th><th>البيان</th><th class="n">المبلغ</th><th class="no-print"></th></tr></thead>
          <tbody>${ex.items.map((e) => html`<tr style="${e.voided_at ? 'opacity:.5;text-decoration:line-through' : ''}"><td>${fmt.date(e.expense_date)}<div class="mono faint" style="font-size:11px">${e.expense_no}</div></td>
            <td>${EXPENSE_CATEGORIES.find(([k]) => k === e.category)?.[1]} — ${e.description}${e.voided_at ? html`<div class="faint">ملغى: ${e.void_reason}</div>` : ''}</td>
            <td class="n">${money(e.amount, e.currency)}${e.currency !== 'LYD' ? html`<div class="faint" style="font-size:12px">${lyd(e.amount_lyd)}</div>` : ''}</td>
            <td class="no-print">${!e.voided_at && can('ADMIN', 'ACCOUNTANT') ? html`<button class="btn btn-sm btn-ghost" data-void="${e.id}">إلغاء</button>` : ''}</td></tr>`)}</tbody></table>
          ${ex.items.length ? '' : html`<div class="empty">لا مصاريف مسجلة في هذا الشهر</div>`}</div></div>
    </div>`);
  $('[data-month]', el).addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/finance?month=${e.target.month.value}`; });
  $('[data-print]', el).addEventListener('click', () => window.print());
  $('[data-new]', el)?.addEventListener('click', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await modal({ title: 'مصروف جديد', submitLabel: 'حفظ المصروف', body: html`
      <div class="grid g2"><label class="field">البند<select class="input" name="category">${opts(EXPENSE_CATEGORIES, 'RENT')}</select></label>
        <label class="field">التاريخ<input class="input" type="date" name="expenseDate" value="${today}" max="${today}"></label></div>
      <label class="field">البيان<input class="input" name="description" required minlength="2" maxlength="300" placeholder="مثلًا: إيجار المعرض لشهر أكتوبر"></label>
      <div class="grid g3"><label class="field">المبلغ<input class="input num" name="amount" required inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?"></label>
        <label class="field">العملة<select class="input" name="currency">${opts([['LYD', 'دينار'], ['USD', 'دولار'], ['EUR', 'يورو']], 'LYD')}</select></label>
        <label class="field">الطريقة<select class="input" name="method">${opts(Object.entries(METHOD), 'CASH')}</select></label></div>
      <label class="field">المرجع<input class="input" name="reference" maxlength="80"></label>
      <p class="faint" style="margin:0">المصروف بالدولار أو اليورو يُحوَّل للدينار بسعر صرف يوم المصروف المسجل في الإعدادات.</p>` });
    if (!r) return;
    const body = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''));
    try { await api('/expenses', { method: 'POST', body }); toast('سُجّل المصروف', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-void]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = await modal({ title: 'إلغاء مصروف', submitLabel: 'إلغاء المصروف', danger: true, body: html`<label class="field">السبب (إلزامي)<input class="input" name="reason" required minlength="3" maxlength="300"></label>` });
    if (!r) return;
    try { await api(`/expenses/${b.dataset.void}/void`, { method: 'POST', body: { reason: r.reason } }); toast('أُلغي المصروف', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  }));
}
