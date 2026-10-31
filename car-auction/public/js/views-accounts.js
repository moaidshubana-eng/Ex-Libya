// حسابات العملاء والموردين: قائمة الأرصدة، كشف الحساب، تسجيل الدفعات، وربط السيارة بالعميل والمورد.
// الأرصدة لكل عملة على حدة. الخادم هو الذي يحسب ويفرض الصلاحيات؛ الواجهة تعرض فقط.
import { html, render, $, $$, api, fmt, state, toast, modal, icon } from './core.js';

const can = (...roles) => roles.includes(state.user.role);
const SYM = { USD: '$', LYD: 'د.ل', EUR: '€' };
const CUR_NAME = { USD: 'دولار', LYD: 'دينار', EUR: 'يورو' };
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const money = (v, c) => `${nf.format(Number(v))} ${SYM[c] || c}`;
const METHODS = [['CASH', 'نقدًا'], ['BANK_TRANSFER', 'حوالة مصرفية'], ['CHEQUE', 'صك'], ['CARD', 'بطاقة'], ['OTHER', 'أخرى']];
const opts = (list, cur) => list.map(([v, l]) => html`<option value="${v}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${l}</option>`);
const curOpts = (cur) => opts([['USD', 'دولار $'], ['LYD', 'دينار د.ل'], ['EUR', 'يورو €']], cur);

export const CUSTOMER_READERS = ['ADMIN', 'ACCOUNTANT', 'SALES', 'VIEWER'];
export const VENDOR_READERS = ['ADMIN', 'ACCOUNTANT', 'OPERATIONS', 'VIEWER'];
const canPay = (type) => (type === 'customer' ? can('ADMIN', 'ACCOUNTANT', 'SALES') : can('ADMIN', 'ACCOUNTANT'));

/** وصف الرصيد حسب الطرف: للعميل «عليه/له»، وللمورد «له علينا/دفعنا زيادة» */
function balanceText(type, b, c) {
  const n = Number(b);
  if (Math.abs(n) < 0.0005) return html`<span class="pos">خالص</span>`;
  if (type === 'customer') return n > 0 ? html`<b class="neg">عليه ${money(n, c)}</b>` : html`<b class="pos">له ${money(-n, c)}</b>`;
  return n > 0 ? html`<b class="neg">له علينا ${money(n, c)}</b>` : html`<b class="pos">دفعنا زيادة ${money(-n, c)}</b>`;
}
const balances = (type, list) => (list.length ? html`<div class="stack" style="gap:2px">${list.map((b) => html`<span>${balanceText(type, b.balance, b.currency)}</span>`)}</div>` : html`<span class="faint">لا حركة</span>`);

// ======================================================================= قائمة الحسابات
export async function accountsView(el, { query }) {
  const tabs = [...(can(...CUSTOMER_READERS) ? [['customers', 'العملاء']] : []), ...(can(...VENDOR_READERS) ? [['vendors', 'الموردون']] : [])];
  const tab = tabs.find(([k]) => k === query.tab)?.[0] || tabs[0][0];
  const q = query.q || '';
  const { items } = await api(`/accounts/${tab}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const type = tab === 'customers' ? 'customer' : 'vendor';
  const owing = items.filter((i) => i.balances.some((b) => Number(b.balance) > 0.0005));
  render(el, html`<div class="card">
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`)}</div>
    <form class="filters" data-search><label class="field grow">بحث<input class="input" name="q" value="${q}" placeholder="${type === 'customer' ? 'اسم العميل أو رقمه' : 'اسم المورد'}"></label>
      <button class="btn btn-primary">بحث</button>
      <span class="faint" style="align-self:center">${type === 'customer' ? `${owing.length} عميل عليهم مبالغ` : `${owing.length} مورد لهم مبالغ علينا`}</span></form>
    <div class="table-wrap"><table class="t"><thead><tr>${type === 'customer' ? html`<th>الرقم</th>` : ''}<th>${type === 'customer' ? 'العميل' : 'المورد'}</th><th class="n">السيارات</th><th>الرصيد</th><th></th></tr></thead>
      <tbody>${items.map((i) => html`<tr>
        ${type === 'customer' ? html`<td class="mono">${i.code}</td>` : ''}
        <td><a href="#/accounts/${type}/${i.id}"><b>${i.name}</b></a>${i.city ? html` <span class="faint">· ${i.city}</span>` : ''}</td>
        <td class="n">${i.vehicles}</td><td>${balances(type, i.balances)}</td>
        <td><a class="btn btn-sm" href="#/accounts/${type}/${i.id}">كشف الحساب</a></td></tr>`)}</tbody></table>
      ${items.length ? '' : html`<div class="empty">لا توجد نتائج</div>`}</div></div>`);
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => { location.hash = `#/accounts?tab=${b.dataset.tab}`; }));
  $('[data-search]', el).addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/accounts?tab=${tab}${e.target.q.value ? `&q=${encodeURIComponent(e.target.q.value)}` : ''}`;
  });
}

// ======================================================================= كشف الحساب
export async function statementView(el, { params, setTitle }) {
  const type = params.type === 'vendor' ? 'vendor' : 'customer';
  const a = await api(`/accounts/${type}s/${params.id}`);
  const p = a.party;
  setTitle(`كشف حساب ${type === 'customer' ? 'العميل' : 'المورد'}: ${p.name}`, type === 'customer' ? p.code : '');
  const today = new Date().toLocaleDateString('ar-LY-u-nu-latn', { year: 'numeric', month: 'long', day: 'numeric' });
  const label = type === 'customer'
    ? { charged: 'إجمالي المستحق عليه', paid: 'إجمالي ما دفعه', col: 'السعر المتفق عليه' }
    : { charged: 'إجمالي المستحق له', paid: 'إجمالي ما سددناه', col: 'المستحق للمورد' };
  const reload = () => statementView(el, { params, setTitle });

  render(el, html`
    <div class="print-only" style="margin-bottom:12px"><img class="print-logo" src="/brand/ggm-logo.svg" alt="Golden Gate Motors">
      <h2 style="margin:6px 0 0">كشف حساب ${type === 'customer' ? 'العميل' : 'المورد'}: ${p.name}${p.code ? ` (${p.code})` : ''}</h2><div>بتاريخ ${today}</div></div>
    <div class="row no-print" style="justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
      <a class="btn btn-ghost btn-sm" href="#/accounts?tab=${type}s">${icon('right')} كل الحسابات</a>
      <div class="row" style="gap:8px">
        ${canPay(type) ? html`<button class="btn btn-primary" data-pay>${icon('plus')} ${type === 'customer' ? 'تسجيل دفعة من العميل' : 'تسجيل دفعة للمورد'}</button>` : ''}
        <button class="btn" data-print>طباعة / PDF</button></div></div>

    <div class="grid g3">${a.summary.length ? a.summary.map((s) => html`<div class="card card-b stack" style="gap:6px">
      <div class="row" style="justify-content:space-between"><b>بالـ${CUR_NAME[s.currency]}</b><span class="badge">${s.currency}</span></div>
      <div class="row" style="justify-content:space-between"><span class="muted">${label.charged}</span><b class="num">${money(s.charged, s.currency)}</b></div>
      <div class="row" style="justify-content:space-between"><span class="muted">${label.paid}</span><b class="num">${money(s.paid, s.currency)}</b></div>
      <div class="row" style="justify-content:space-between;border-top:1px dashed var(--border);padding-top:6px"><span class="muted">الرصيد</span>${balanceText(type, s.balance, s.currency)}</div>
    </div>`) : html`<div class="card empty">لا توجد حركات بعد</div>`}</div>
    ${a.unallocated.length ? html`<div class="alert" style="margin-top:12px">دفعات زائدة غير مخصصة لأي سيارة: ${a.unallocated.map((u) => money(u.amount, u.currency)).join(' · ')}</div>` : ''}

    <div class="card" style="margin-top:16px"><div class="card-h"><h2>السيارات</h2><span class="faint">المتبقي على كل سيارة: الدفعات المربوطة بها أولًا، ثم الدفعات العامة على الأقدم</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>السيارة</th><th>الحالة</th><th class="n">${label.col}</th><th class="n">المدفوع</th><th class="n">المتبقي</th></tr></thead>
        <tbody>${a.vehicles.map((v) => html`<tr><td><a href="#/vehicles/${v.vehicleId}"><b class="mono">${v.stockNo}</b></a> ${v.title}</td>
          <td>${state.meta.statuses.find((s) => s.code === v.status)?.label || v.status}</td>
          <td class="n">${money(v.charged, v.currency)}</td><td class="n">${money(v.paid, v.currency)}</td>
          <td class="n">${Number(v.remaining) > 0.0005 ? html`<b class="neg">${money(v.remaining, v.currency)}</b>` : html`<span class="pos">خالصة</span>`}</td></tr>`)}</tbody></table>
        ${a.vehicles.length ? '' : html`<div class="empty">لا توجد سيارات في هذا الحساب</div>`}</div></div>

    <div class="card" style="margin-top:16px"><div class="card-h"><h2>الحركات</h2><span class="faint">الرصيد المتراكم لكل عملة على حدة</span></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>التاريخ</th><th>البيان</th><th>العملة</th><th class="n">${type === 'customer' ? 'عليه' : 'له'}</th><th class="n">${type === 'customer' ? 'دفع' : 'سددنا'}</th><th class="n">الرصيد</th><th class="no-print"></th></tr></thead>
        <tbody>${a.lines.map((l) => html`<tr style="${l.type === 'VOID' ? 'opacity:.55;text-decoration:line-through' : ''}">
          <td>${fmt.date(l.date)}</td>
          <td>${l.vehicleId && l.type === 'CHARGE' ? html`<a href="#/vehicles/${l.vehicleId}">${l.label}</a>` : l.label}${l.method ? html` <span class="faint">· ${METHODS.find(([m]) => m === l.method)?.[1] || ''}</span>` : ''}</td>
          <td>${l.currency}</td>
          <td class="n">${Number(l.debit) ? money(l.debit, l.currency) : ''}</td>
          <td class="n">${Number(l.credit) ? money(l.credit, l.currency) : ''}</td>
          <td class="n">${money(l.balance, l.currency)}</td>
          <td class="no-print">${l.paymentId && l.type === 'PAYMENT' && can('ADMIN', 'ACCOUNTANT') ? html`<button class="btn btn-sm btn-ghost" data-void="${l.paymentId}">إلغاء</button>` : ''}</td></tr>`)}</tbody></table>
        ${a.lines.length ? '' : html`<div class="empty">لا توجد حركات</div>`}</div></div>`);

  $('[data-print]', el).addEventListener('click', () => window.print());
  $('[data-pay]', el)?.addEventListener('click', async () => { if (await paymentDialog(type, p.id, { account: a })) reload(); });
  $$('[data-void]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = await modal({ title: 'إلغاء دفعة', submitLabel: 'إلغاء الدفعة', danger: true, body: html`<p style="margin:0 0 8px">لا تُحذف الدفعة؛ تبقى في الكشف مشطوبة مع السبب.</p>
      <label class="field">السبب (إلزامي)<input class="input" name="reason" required minlength="3" maxlength="300"></label>` });
    if (!r) return;
    try { await api(`/account-payments/${b.dataset.void}/void`, { method: 'POST', body: { reason: r.reason } }); toast('أُلغيت الدفعة', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  }));
}

// ======================================================================= تسجيل دفعة
/**
 * دفعة بعملة ما تُخصم من رصيد عملة ما. إن اختلفتا يظهر سعر الصرف (دينار لكل دولار/يورو)،
 * مُعبّأ بآخر سعر مسجل، وقابل للتعديل للسعر المتفق عليه.
 */
export async function paymentDialog(type, partyId, { account, vehicleId } = {}) {
  const acc = account || await api(`/accounts/${type}s/${partyId}`);
  const owing = acc.summary.filter((s) => Number(s.balance) > 0.0005);
  const defCur = acc.vehicles.find((v) => v.vehicleId === vehicleId)?.currency || owing[0]?.currency || 'LYD';
  const rate = (c) => state.meta.rates.find((r) => r.currency === c)?.rate_to_lyd || '';
  const today = new Date().toISOString().slice(0, 10);
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'modal';
    render(d, html`<form method="dialog" novalidate>
      <div class="m-h"><h3>${type === 'customer' ? 'دفعة من العميل' : 'دفعة للمورد'}: ${acc.party.name}</h3><button class="btn btn-ghost btn-sm" value="cancel" formnovalidate aria-label="إغلاق">✕</button></div>
      <div class="m-b stack">
        ${acc.summary.length ? html`<div class="faint">الرصيد الحالي: ${acc.summary.map((s) => `${CUR_NAME[s.currency]} ${money(s.balance, s.currency)}`).join(' · ')}</div>` : ''}
        <div class="grid g2"><label class="field">المبلغ${type === 'customer' ? ' المستلم' : ' المدفوع'}<input class="input num" name="amount" required inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" autofocus></label>
          <label class="field">العملة<select class="input" name="currency">${curOpts(defCur)}</select></label></div>
        <div class="grid g2"><label class="field">يُخصم من رصيد<select class="input" name="settleCurrency">${curOpts(defCur)}</select></label>
          <label class="field" data-fxwrap hidden>سعر الصرف (دينار لكل <span data-fxcur></span>)<input class="input num" name="fxRate" inputmode="decimal" pattern="\\d+(\\.\\d{1,6})?"></label></div>
        <div class="alert" data-preview hidden style="font-size:14px"></div>
        <label class="field">السيارة (اختياري)<select class="input" name="vehicleId"><option value="">على الحساب عمومًا</option>
          ${acc.vehicles.map((v) => html`<option value="${v.vehicleId}" ${v.vehicleId === vehicleId ? 'selected' : ''}>${v.stockNo} — ${v.title} (متبقي ${money(v.remaining, v.currency)})</option>`)}</select></label>
        <div class="grid g3"><label class="field">الطريقة<select class="input" name="method">${opts(METHODS, 'CASH')}</select></label>
          <label class="field">المرجع<input class="input" name="reference" maxlength="80" placeholder="رقم الحوالة/الصك"></label>
          <label class="field">التاريخ<input class="input" type="date" name="paidAt" value="${today}" max="${today}"></label></div>
        <label class="field">ملاحظة<input class="input" name="note" maxlength="300"></label>
        <div data-err role="alert" style="color:var(--danger);min-height:1.2em"></div>
      </div>
      <div class="m-f"><button class="btn" value="cancel" formnovalidate>إلغاء</button><button class="btn btn-primary" value="ok" data-save>حفظ الدفعة</button></div>
    </form>`);
    document.body.appendChild(d);
    const f = $('form', d);
    const sync = () => {
      const cur = f.currency.value, set = f.settleCurrency.value, differ = cur !== set;
      const foreign = cur === 'LYD' ? set : cur;
      $('[data-fxwrap]', d).hidden = !differ;
      $('[data-fxcur]', d).textContent = CUR_NAME[foreign] || foreign;
      if (differ && !f.fxRate.dataset.touched) f.fxRate.value = rate(foreign);
      const amt = Number(f.amount.value), fx = Number(f.fxRate.value);
      const pv = $('[data-preview]', d);
      const bad = differ && cur !== 'LYD' && set !== 'LYD';
      pv.hidden = !(differ && (amt || bad));
      pv.textContent = bad ? 'التحويل يكون بين الدينار وعملة أجنبية فقط'
        : amt && fx ? `يُخصم من رصيد ال${CUR_NAME[set]}: ${money(cur === 'LYD' ? amt / fx : amt * fx, set)}` : '';
    };
    f.fxRate.addEventListener('input', () => { f.fxRate.dataset.touched = '1'; sync(); });
    f.vehicleId.addEventListener('change', () => {
      const v = acc.vehicles.find((x) => x.vehicleId === f.vehicleId.value);
      if (v) { f.settleCurrency.value = v.currency; sync(); }
    });
    ['amount', 'currency', 'settleCurrency'].forEach((n) => f[n].addEventListener('input', sync));
    sync();
    let saved = false;
    $('[data-save]', d).addEventListener('click', async (e) => {
      e.preventDefault();
      if (!f.reportValidity()) return;
      const r = Object.fromEntries(new FormData(f));
      const body = Object.fromEntries(Object.entries(r).filter(([k, v]) => v !== '' && !(k === 'fxRate' && r.currency === r.settleCurrency)));
      try {
        $('[data-save]', d).disabled = true;
        await api(`/accounts/${type}s/${partyId}/payments`, { method: 'POST', body });
        saved = true;
        toast('سُجّلت الدفعة', 'ok');
        d.close();
      } catch (err) { $('[data-err]', d).textContent = err.message; $('[data-save]', d).disabled = false; }
    });
    d.addEventListener('close', () => { d.remove(); resolve(saved); });
    d.showModal();
  });
}

// ======================================================================= العميل والمورد على السيارة
let customersCache = null;
export async function loadCustomers(force = false) {
  if (!customersCache || force) customersCache = (await api('/customers')).items;
  return customersCache;
}

/** حقول العميل والسعر والمورد (في إضافة السيارة وفي تعديل الصفقة) */
export function dealFields(customers, cur = {}) {
  return html`<div class="grid g2">
      <label class="field">العميل الذي نشتريها له<select class="input" name="customerId"><option value="">— للمعرض / بدون عميل —</option>
        ${customers.filter((c) => !['REJECTED', 'SUSPENDED'].includes(c.kyc_status) || c.id === cur.customerId).map((c) => html`<option value="${c.id}" ${c.id === cur.customerId ? 'selected' : ''}>${c.full_name} (${c.code})</option>`)}</select></label>
      <label class="field">المورد الذي نشتريها منه<select class="input" name="vendorId"><option value="">—</option>
        ${state.meta.vendors.map((v) => html`<option value="${v.id}" ${v.id === cur.vendorId ? 'selected' : ''}>${v.name}</option>`)}</select></label></div>
    <div class="grid g2"><label class="field">السعر المتفق عليه مع العميل<input class="input num" name="customerPrice" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${cur.price ? Number(cur.price) : ''}"></label>
      <label class="field">عملة السعر<select class="input" name="customerCurrency">${curOpts(cur.currency || 'USD')}</select></label></div>`;
}

export function dealCard(v, deal) {
  if (!deal) return '';
  const showC = can(...CUSTOMER_READERS), showV = can(...VENDOR_READERS);
  const line = (l, type) => html`<div class="row" style="justify-content:space-between"><span class="muted">${type === 'customer' ? 'المطلوب' : 'المستحق'}</span><b class="num">${money(l.charged, l.currency)}</b></div>
    <div class="row" style="justify-content:space-between"><span class="muted">${type === 'customer' ? 'دفع' : 'سددنا'}</span><span class="num">${money(l.paid, l.currency)}</span></div>
    <div class="row" style="justify-content:space-between"><span class="muted">المتبقي</span>${Number(l.remaining) > 0.0005 ? html`<b class="neg num">${money(l.remaining, l.currency)}</b>` : html`<span class="pos">خالص</span>`}</div>`;
  return html`<div class="card card-b stack" style="gap:8px">
    <div class="row" style="justify-content:space-between"><b>${icon('money')} العميل والمورد</b>
      ${can('ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES') ? html`<button class="btn btn-sm btn-ghost" data-deal>تعديل</button>` : ''}</div>
    <div class="stack" style="gap:4px">
      <div class="row" style="justify-content:space-between"><span class="muted">العميل</span>${deal.customer
        ? (showC ? html`<a href="#/accounts/customer/${deal.customer.id}"><b>${deal.customer.name}</b></a>` : html`<b>${deal.customer.name}</b>`) : html`<span class="faint">للمعرض (بدون عميل)</span>`}</div>
      ${deal.customer && showC ? (deal.customer.lines || []).map((l) => line(l, 'customer')) : ''}
      ${deal.customer && showC && can('ADMIN', 'ACCOUNTANT', 'SALES') ? html`<button class="btn btn-sm" data-pay-customer>${icon('plus')} دفعة من العميل</button>` : ''}
    </div>
    <div class="stack" style="gap:4px;border-top:1px dashed var(--border);padding-top:8px">
      <div class="row" style="justify-content:space-between"><span class="muted">المورد</span>${deal.vendor
        ? (showV ? html`<a href="#/accounts/vendor/${deal.vendor.id}"><b>${deal.vendor.name}</b></a>` : html`<b>${deal.vendor.name}</b>`) : html`<span class="faint">غير محدد</span>`}</div>
      ${deal.vendor && showV ? (deal.vendor.lines || []).map((l) => line(l, 'vendor')) : ''}
      ${deal.vendor && showV && can('ADMIN', 'ACCOUNTANT') ? html`<button class="btn btn-sm" data-pay-vendor>${icon('plus')} دفعة للمورد</button>` : ''}
    </div></div>`;
}

export function mountDeal(el, v, deal, reload) {
  $('[data-deal]', el)?.addEventListener('click', async () => {
    let customers = [];
    try { customers = await loadCustomers(true); } catch { /* دور بلا صلاحية قراءة العملاء */ }
    const r = await modal({ title: `العميل والمورد — ${v.stock_no}`, submitLabel: 'حفظ', body: html`
      ${dealFields(customers, { customerId: deal?.customer?.id && v.customer_id ? deal.customer.id : '', vendorId: deal?.vendor?.id, price: deal?.customer?.price, currency: deal?.customer?.currency })}
      <p class="faint" style="margin:0">السيارة المشتراة لعميل لا تُدرج في مزاد ولا تُباع لغيره، وتُعلَّم «مباعة» عند تسليمها. تكاليف الشراء (السعر والرسوم) تُنسب للمورد تلقائيًا.</p>` });
    if (!r) return;
    const body = { customerId: r.customerId || null, vendorId: r.vendorId || null, customerPrice: r.customerId ? (r.customerPrice || null) : null, ...(r.customerId ? { customerCurrency: r.customerCurrency } : {}) };
    try { await api(`/vehicles/${v.id}/deal`, { method: 'PUT', body }); toast('تم الحفظ', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  });
  $('[data-pay-customer]', el)?.addEventListener('click', async () => { if (await paymentDialog('customer', deal.customer.id, { vehicleId: v.id })) reload(); });
  $('[data-pay-vendor]', el)?.addEventListener('click', async () => { if (await paymentDialog('vendor', deal.vendor.id, { vehicleId: v.id })) reload(); });
}
