// شاشات وحوارات الإدارة التشغيلية: العملاء، المزادات، البيع والدفعات، الشحنات، الجمارك، الموردون
import { html, raw, render, $, $$, api, fmt, LABELS, state, toast, modal, icon } from './core.js';

const can = (...roles) => roles.includes(state.user.role);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));
const num = (name, label, extra = '') => html`<label class="field">${label}<input class="input num" name="${name}" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" ${raw(extra)}></label>`;
const options = (list, cur, blank = '—') => html`${blank ? html`<option value="">${blank}</option>` : ''}${list.map(([v, l]) => html`<option value="${v}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${l}</option>`)}`;

export async function refreshMeta() { state.meta = await api('/meta'); }

/** نافذة عريضة قابلة لإعادة الرسم: draw() يعيد { body, bind(root) } */
function panelDialog(title, draw) {
  const d = document.createElement('dialog');
  d.className = 'modal';
  d.style.width = 'min(820px, calc(100vw - 32px))';
  document.body.appendChild(d);
  const close = () => { if (d.open) d.close(); d.remove(); };
  const refresh = async () => {
    try {
      const { body, bind } = await draw(refresh, close);
      render(d, html`<div class="m-h"><h3>${title}</h3><button class="btn btn-ghost btn-sm" data-close aria-label="إغلاق">✕</button></div><div class="m-b" style="max-height:70vh;overflow:auto">${body}</div>`);
      $('[data-close]', d).onclick = close;
      bind?.(d);
    } catch (e) { toast(e.message, 'err'); close(); }
  };
  d.addEventListener('close', () => d.remove());
  d.showModal();
  refresh();
}

const guard = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'err'); return null; } };

// ======================================================================= العملاء
export async function newCustomerDialog() {
  const r = await modal({ title: 'عميل جديد', submitLabel: 'حفظ العميل', body: html`
    <label class="field">الاسم الكامل أو اسم المعرض<input class="input" name="fullName" required minlength="2"></label>
    <div class="grid g2"><label class="field">النوع<select class="input" name="customerType">${options([['INDIVIDUAL', 'فرد'], ['DEALER', 'معرض / تاجر'], ['COMPANY', 'شركة']], 'INDIVIDUAL', '')}</select></label>
      <label class="field">المدينة<input class="input" name="city"></label></div>
    <div class="grid g2"><label class="field">الهاتف<input class="input num" name="phone" autocomplete="off"></label>
      <label class="field">رقم الهوية / السجل التجاري<input class="input num" name="nationalId" autocomplete="off"></label></div>
    <label class="field">ملاحظات<input class="input" name="notes" maxlength="500"></label>
    <p class="faint" style="margin:0">الهاتف والهوية يُحفظان مشفّرين. لا يُنشأ حساب دخول بهذا النموذج؛ لحساب مزايد إلكتروني استخدم الإعدادات ← مستخدم جديد.</p>` });
  if (!r) return null;
  return guard(() => api('/customers', { method: 'POST', body: clean(r) }), 'أُضيف العميل');
}

export async function customersView(el) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  const { items } = await api(`/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const KYC = [['PENDING', 'قيد التحقق'], ['VERIFIED', 'موثّق'], ['REJECTED', 'مرفوض'], ['SUSPENDED', 'موقوف']];
  render(el, html`<div class="card">
    <form class="filters" data-search><label class="field grow">بحث<input class="input" name="q" value="${q}" placeholder="الاسم أو رقم العميل"></label>
      <button class="btn btn-primary">بحث</button>${can('ADMIN', 'SALES') ? html`<button type="button" class="btn btn-accent" data-new>${icon('plus')} عميل جديد</button>` : ''}</form>
    <div class="table-wrap"><table class="t"><thead><tr><th>الرقم</th><th>الاسم</th><th>النوع</th><th>المدينة</th><th>الهاتف</th><th>التحقق</th><th class="n">سياراته</th><th>بوابة العملاء</th></tr></thead>
      <tbody>${items.map((c) => html`<tr><td class="mono">${c.code}</td><td><b>${c.full_name}</b></td><td>${{ INDIVIDUAL: 'فرد', DEALER: 'معرض', COMPANY: 'شركة' }[c.customer_type]}</td><td>${c.city || '—'}</td><td class="mono">${c.phone || '—'}</td>
        <td>${can('ADMIN', 'SALES') ? html`<select class="input" style="min-width:120px;min-height:32px;padding:2px 8px" data-kyc="${c.id}">${options(KYC, c.kyc_status, '')}</select>` : KYC.find(([v]) => v === c.kyc_status)[1]}</td><td class="n">${c.cars + c.purchases}</td>
        <td>${portalBadge(c)}${can('ADMIN', 'SALES') ? html` <button class="btn btn-sm" data-portal="${c.id}">${c.portal_active == null ? 'تفعيل' : 'إدارة'}</button>` : ''}</td></tr>`)}</tbody></table>
      ${items.length ? '' : html`<div class="empty">لا يوجد عملاء</div>`}</div></div>`);
  $('[data-search]', el).addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/customers${e.target.q.value ? `?q=${encodeURIComponent(e.target.q.value)}` : ''}`; });
  $('[data-new]', el)?.addEventListener('click', async () => { if (await newCustomerDialog()) customersView(el); });
  $$('[data-kyc]', el).forEach((s) => s.addEventListener('change', () => guard(() => api(`/customers/${s.dataset.kyc}`, { method: 'PATCH', body: { kycStatus: s.value } }), 'تم تحديث حالة التحقق')));
  $$('[data-portal]', el).forEach((b) => b.addEventListener('click', () => portalDialog(items.find((c) => c.id === b.dataset.portal), () => customersView(el))));
}

const portalBadge = (c) => (c.portal_active == null ? html`<span class="faint">—</span>`
  : c.portal_active ? html`<span class="badge" style="color:#16a34a"><span class="dot"></span><span style="color:var(--text)">مفعّل${c.portal_last_login ? '' : ' (لم يدخل بعد)'}</span></span>`
    : html`<span class="badge" style="color:#94a3b8"><span class="dot"></span><span style="color:var(--text)">موقوف</span></span>`);

/** حساب بوابة العميل: تفعيل أو إعادة تعيين كلمة سر مؤقتة تُعرض مرة واحدة، مع رسالة جاهزة للإرسال */
function portalDialog(c, reload) {
  let shown = null; // كلمة السر المؤقتة بعد إنشائها (لا تُحفظ في أي مكان)
  panelDialog(`بوابة العملاء — ${c.full_name}`, async (refresh) => {
    const { account, phone } = await api(`/customers/${c.id}/portal`);
    const link = `${location.origin}/portal`;
    const msg = shown && `مرحبا ${c.full_name}، تقدر تتابع سياراتك وكشف حسابك من بوابة Golden Gate Motors:\n${link}\nرقم الدخول: ${phone}\nكلمة السر المؤقتة: ${shown}\n(بيطلب منك تغييرها أول مرة)`;
    const waPhone = String(phone || '').replace(/\D/g, '').replace(/^0/, '218');
    return {
      body: html`
        ${!phone ? html`<div class="alert danger">ما فيش رقم هاتف لهذا العميل. العميل يدخل البوابة برقم هاتفه، فسجّله أولًا.</div>` : ''}
        <dl class="specs" style="margin-bottom:12px">
          <div><dt>رقم الدخول</dt><dd class="mono">${phone || '—'}</dd></div>
          <div><dt>الحالة</dt><dd>${!account ? 'غير مفعّل' : account.is_active ? 'مفعّل' : 'موقوف'}</dd></div>
          <div><dt>آخر دخول</dt><dd>${account?.last_login_at ? fmt.dt(account.last_login_at) : '—'}</dd></div>
          <div><dt>كلمة السر</dt><dd>${!account ? '—' : account.must_change ? 'مؤقتة (لم يغيّرها بعد)' : 'غيّرها العميل'}</dd></div>
        </dl>
        ${shown ? html`<div class="alert" style="margin-bottom:12px"><b>كلمة السر المؤقتة:</b> <span class="mono" style="font-size:20px;letter-spacing:2px">${shown}</span>
          <div class="faint" style="font-size:12.5px">تظهر مرة وحدة بس. أرسلها للعميل الآن.</div>
          <textarea class="input" readonly rows="5" style="margin-top:8px;width:100%" data-msg>${msg}</textarea>
          <div class="row" style="gap:6px;margin-top:8px"><button class="btn btn-sm" data-copymsg>نسخ الرسالة</button>
            ${waPhone ? html`<a class="btn btn-sm btn-accent" target="_blank" rel="noopener noreferrer" href="https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}">إرسال واتساب</a>` : ''}</div></div>` : ''}
        <div class="row" style="gap:8px;flex-wrap:wrap">
          ${phone ? html`<button class="btn btn-primary" data-set>${account ? 'إعادة تعيين كلمة السر' : 'تفعيل حساب البوابة'}</button>` : ''}
          ${account?.is_active ? html`<button class="btn btn-danger" data-off>إيقاف الحساب</button>` : ''}
          <a class="btn btn-ghost" href="/portal" target="_blank" rel="noopener">فتح البوابة ↗</a></div>
        <p class="faint" style="font-size:12.5px;margin:12px 0 0">العميل يشوف سياراته المسجلة باسمه فقط: المراحل، والحاوية، والصور، والسعر المتفق عليه، وكشف حسابه. ما يشوفش التكاليف ولا الموردين.</p>`,
      bind: (root) => {
        $('[data-set]', root)?.addEventListener('click', async () => {
          if (account && !confirm('إعادة التعيين تلغي كلمة السر الحالية وتخرج العميل من البوابة. نكمّل؟')) return;
          const r = await guard(() => api(`/customers/${c.id}/portal`, { method: 'POST', body: {} }), account ? 'أُعيد تعيين كلمة السر' : 'فُعّل حساب البوابة');
          if (r) { shown = r.password; refresh(); reload(); }
        });
        $('[data-off]', root)?.addEventListener('click', async () => {
          if (!confirm('إيقاف حساب البوابة لهذا العميل؟')) return;
          if (await guard(() => api(`/customers/${c.id}/portal`, { method: 'DELETE' }), 'أُوقف الحساب')) { shown = null; refresh(); reload(); }
        });
        $('[data-copymsg]', root)?.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(msg); toast('نُسخت الرسالة', 'ok'); } catch { $('[data-msg]', root).select(); }
        });
      },
    };
  });
}

// ======================================================================= المزادات
const toIso = (local) => (local ? new Date(local).toISOString() : '');
export async function newAuctionDialog() {
  const pad = (n) => String(n).padStart(2, '0');
  const dt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const start = new Date(Date.now() + 3600_000), end = new Date(Date.now() + 3 * 86_400_000);
  const r = await modal({ title: 'مزاد جديد', submitLabel: 'إنشاء المزاد', body: html`
    <label class="field">اسم المزاد<input class="input" name="title" required minlength="3" placeholder="مزاد الخميس الأسبوعي"></label>
    <div class="grid g2"><label class="field">يبدأ<input class="input" type="datetime-local" name="startsAt" value="${dt(start)}" required></label>
      <label class="field">ينتهي<input class="input" type="datetime-local" name="endsAt" value="${dt(end)}" required></label></div>
    <div class="grid g3">${num('depositRequiredLyd', 'التأمين المطلوب (د.ل)', 'value="5000"')}
      <label class="field">نافذة منع القنص (ثانية)<input class="input num" name="antiSnipeWindowSec" value="120" pattern="\\d+"></label>
      <label class="field">التمديد (ثانية)<input class="input num" name="extensionSec" value="120" pattern="\\d+"></label></div>
    <label class="field">الشروط (تظهر للمزايدين)<input class="input" name="terms" maxlength="2000" placeholder="تُباع السيارات بحالتها، ويُسدد الثمن خلال 3 أيام"></label>
    <p class="faint" style="margin:0">أي مزايدة في آخر "نافذة منع القنص" تمدد الوقت بمقدار "التمديد". بعد الإنشاء أدرج السيارات من ملف كل سيارة (إدراج في مزاد)، وسجّل المزايدين واعتمد تأميناتهم.</p>` });
  if (!r) return null;
  const body = clean({ ...r, startsAt: toIso(r.startsAt), endsAt: toIso(r.endsAt) });
  for (const k of ['antiSnipeWindowSec', 'extensionSec']) if (body[k] !== undefined) body[k] = Number(body[k]);
  return guard(() => api('/auctions', { method: 'POST', body }), 'أُنشئ المزاد');
}

const DEPOSIT = { PENDING: ['بانتظار التأمين', 'var(--accent)'], HELD: ['تأمين معتمد', 'var(--success)'], RELEASED: ['أُفرج عنه', 'var(--text-3)'], APPLIED: ['خُصم من الثمن', 'var(--info)'], FORFEITED: ['مصادَر', 'var(--danger)'] };

export function registrationsDialog(event) {
  panelDialog(`المسجلون في: ${event.title}`, async (refresh) => {
    const [{ items }, cust] = await Promise.all([api(`/auctions/${event.id}/registrations`), can('ADMIN', 'SALES') ? api('/customers') : { items: [] }]);
    const taken = new Set(items.map((r) => r.customer_id));
    const free = cust.items.filter((c) => !taken.has(c.id) && !['REJECTED', 'SUSPENDED'].includes(c.kyc_status));
    const body = html`
      <p class="muted" style="margin:0">التأمين المطلوب <b class="num">${fmt.lyd(event.deposit_required_lyd)}</b>. لا يستطيع العميل المزايدة قبل <b>اعتماد التأمين</b> بعد استلامه فعليًا.</p>
      ${can('ADMIN', 'SALES') ? html`<form class="row" data-add><select class="input" name="customerId" style="flex:1" required><option value="">اختر عميلًا للتسجيل…</option>${free.map((c) => html`<option value="${c.id}">${c.code} — ${c.full_name}</option>`)}</select>
        <button class="btn btn-primary">تسجيل</button><button type="button" class="btn" data-newc>عميل جديد</button></form>` : ''}
      <div class="table-wrap"><table class="t"><thead><tr><th>رقم المزايد</th><th>العميل</th><th class="n">التأمين</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${items.map((r) => html`<tr><td class="num"><b>#${r.paddle_no}</b></td><td>${r.code} — ${r.full_name}</td><td class="n">${fmt.lyd(r.deposit_amount_lyd)}</td>
          <td><span class="badge" style="color:${DEPOSIT[r.deposit_status][1]}"><span class="dot"></span><span style="color:var(--text)">${DEPOSIT[r.deposit_status][0]}</span></span></td>
          <td class="row">${r.deposit_status === 'PENDING' ? html`<button class="btn btn-sm btn-primary" data-dep="${r.id}" data-to="HELD">اعتماد التأمين</button><button class="btn btn-sm" data-dep="${r.id}" data-to="RELEASED">إلغاء</button>` : ''}
            ${r.deposit_status === 'HELD' ? html`<button class="btn btn-sm" data-dep="${r.id}" data-to="RELEASED">إفراج</button><button class="btn btn-sm btn-danger" data-dep="${r.id}" data-to="FORFEITED">مصادرة</button>` : ''}</td></tr>`)}</tbody></table>
        ${items.length ? '' : html`<div class="empty">لا مسجلين بعد</div>`}</div>`;
    const bind = (root) => {
      $('[data-add]', root)?.addEventListener('submit', async (e) => { e.preventDefault(); if (await guard(() => api(`/auctions/${event.id}/registrations`, { method: 'POST', body: { customerId: e.target.customerId.value } }), 'تم التسجيل')) refresh(); });
      $('[data-newc]', root)?.addEventListener('click', async () => { if (await newCustomerDialog()) refresh(); });
      $$('[data-dep]', root).forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.to === 'FORFEITED' && !(await modal({ title: 'مصادرة التأمين', submitLabel: 'مصادرة', danger: true, body: html`<p style="margin:0">سيُصادَر التأمين نهائيًا (مثلًا لامتناع الفائز عن السداد). هل أنت متأكد؟</p>` }))) return;
        if (await guard(() => api(`/registrations/${b.dataset.dep}`, { method: 'PATCH', body: { depositStatus: b.dataset.to } }), 'تم')) refresh();
      }));
    };
    return { body, bind };
  });
}

export async function cancelAuctionDialog(event, after) {
  const ok = await modal({ title: `إلغاء المزاد: ${event.title}`, submitLabel: 'إلغاء المزاد', danger: true, body: html`<p style="margin:0">تعود كل سياراته إلى "متاحة في المعرض" ويُفرج عن تأمينات المسجلين. لا يُلغى مزاد عليه مزايدات.</p>` });
  if (ok && (await guard(() => api(`/auctions/${event.id}/cancel`, { method: 'POST' }), 'أُلغي المزاد'))) after();
}

// ======================================================================= البيع المباشر والدفعات
export async function sellDialog(v, reload) {
  const { items } = await api('/customers');
  const cost = v.costs?.summary?.total_cost_lyd;
  const r = await modal({ title: `بيع مباشر — ${v.stock_no}`, submitLabel: 'تسجيل البيع', body: html`
    <label class="field">المشتري<select class="input" name="customerId" required><option value="">اختر العميل…</option>${items.filter((c) => !['REJECTED', 'SUSPENDED'].includes(c.kyc_status)).map((c) => html`<option value="${c.id}">${c.code} — ${c.full_name}</option>`)}</select></label>
    <div class="grid g2">${num('priceLyd', 'سعر البيع (د.ل)', `required value="${v.list_price_lyd ? Math.round(Number(v.list_price_lyd)) : ''}"`)}
      <label class="field">مهلة السداد (أيام)<input class="input num" name="dueDays" value="3" pattern="\\d+"></label></div>
    ${cost ? html`<p class="faint" style="margin:0">التكلفة الواصلة حتى الآن ${fmt.lyd(cost)}.</p>` : ''}
    <p class="faint" style="margin:0">تصدر فاتورة برقم متسلسل وتصبح السيارة "مباعة". سجّل الدفعات بعدها من ملف السيارة. العميل غير موجود؟ أضفه من صفحة العملاء.</p>` });
  if (!r) return;
  const body = clean({ ...r }); if (body.dueDays) body.dueDays = Number(body.dueDays);
  if (await guard(() => api(`/vehicles/${v.id}/sell`, { method: 'POST', body }), 'تم تسجيل البيع')) reload();
}

export async function paymentDialog(sale, reload) {
  const remaining = Math.max(0, Number(sale.sale_price_lyd) + Number(sale.buyer_fee_lyd || 0) - Number(sale.paid_lyd));
  const r = await modal({ title: `دفعة — فاتورة ${sale.invoice_no}`, submitLabel: 'تسجيل الدفعة', body: html`
    <div class="faint">المتبقي <b class="num">${fmt.lyd(remaining)}</b></div>
    <div class="grid g3">${num('amount', 'المبلغ', `required value="${Math.round(remaining) || ''}"`)}
      <label class="field">العملة<select class="input" name="currency">${options([['LYD', 'دينار'], ['USD', 'دولار'], ['EUR', 'يورو']], 'LYD', '')}</select></label>
      <label class="field">الطريقة<select class="input" name="method">${options([['CASH', 'نقدًا'], ['BANK_TRANSFER', 'حوالة مصرفية'], ['CHEQUE', 'صك'], ['CARD', 'بطاقة'], ['OTHER', 'أخرى']], 'CASH', '')}</select></label></div>
    <label class="field">المرجع (رقم الحوالة/الصك)<input class="input" name="reference" maxlength="80"></label>
    <p class="faint" style="margin:0">الدفع بالدولار يُحوَّل بسعر صرف اليوم المسجّل. لا يُقبل دفع يتجاوز المستحق.</p>` });
  if (r && (await guard(() => api(`/sales/${sale.id}/payments`, { method: 'POST', body: clean(r) }), 'سُجّلت الدفعة'))) reload();
}

// ======================================================================= الجمارك
export async function openCustomsDialog(v, reload) {
  const brokers = state.meta.vendors.filter((x) => x.vendor_type === 'CUSTOMS_BROKER');
  const r = await modal({ title: `فتح بيان جمركي — ${v.stock_no}`, submitLabel: 'فتح البيان', body: html`
    <label class="field">المخلّص الجمركي<select class="input" name="brokerId">${options(brokers.map((b) => [b.id, b.name]), '', 'بدون تحديد الآن')}</select></label>
    <label class="field">رقم البيان (إن توفر)<input class="input" name="declarationNo"></label>
    <p class="faint" style="margin:0">يُفتح البيان بحالة "بانتظار المستندات" في ميناء وصول السيارة، ثم يُحدَّث من صفحة الجمارك. لا مخلّصين في القائمة؟ أضفهم من الإعدادات ← الموردون.</p>` });
  if (r && (await guard(() => api(`/vehicles/${v.id}/customs`, { method: 'POST', body: clean(r) }), 'فُتح البيان'))) reload();
}

// ======================================================================= الشحنات
const portsOf = (country) => state.meta.ports.filter((p) => p.country === country).map((p) => [p.code, p.name_ar]);
const vendorsOf = (type) => state.meta.vendors.filter((v) => v.vendor_type === type).map((v) => [v.id, v.name]);

export async function newShipmentDialog() {
  const r = await modal({ title: 'شحنة جديدة', submitLabel: 'إنشاء الشحنة', body: html`
    <div class="grid g2"><label class="field">ميناء التحميل<select class="input" name="polCode" required>${options(portsOf('US'), 'USHOU', '')}</select></label>
      <label class="field">ميناء الوصول<select class="input" name="podCode" required>${options(portsOf('LY'), 'LYMRA', '')}</select></label></div>
    <div class="grid g3"><label class="field">رقم الحاوية<input class="input mono" name="containerNo" maxlength="11" pattern="[A-Z]{4}\\d{7}" placeholder="MSCU1234567" style="text-transform:uppercase"></label>
      <label class="field">بوليصة الشحن<input class="input mono" name="billOfLading"></label>
      <label class="field">رقم الحجز<input class="input mono" name="bookingNo"></label></div>
    <div class="grid g3"><label class="field">النوع<select class="input" name="containerType">${options([['C40HC', '40 HC'], ['C40', '40'], ['C20', '20'], ['RORO', 'RoRo']], 'C40HC', '')}</select></label>
      <label class="field">سعة السيارات<input class="input num" name="capacity" value="4" pattern="\\d+"></label>
      <label class="field">الخط الملاحي<select class="input" name="carrierId">${options(vendorsOf('SHIPPING_LINE'), '', '—')}</select></label></div>
    <div class="grid g3"><label class="field">السفينة<input class="input" name="vesselName"></label>
      <label class="field">الإبحار المتوقع<input class="input" type="date" name="etd"></label>
      <label class="field">الوصول المتوقع<input class="input" type="date" name="eta"></label></div>
    <p class="faint" style="margin:0">بعد الإنشاء أضف السيارات من بطاقة الشحنة (السيارة يجب أن تكون في "مستودع التصدير").</p>` });
  if (!r) return null;
  const body = clean({ ...r, containerNo: r.containerNo.toUpperCase() }); if (body.capacity) body.capacity = Number(body.capacity);
  return guard(() => api('/shipments', { method: 'POST', body }), 'أُنشئت الشحنة');
}

export async function editShipmentDialog(s, reload) {
  const ORDER = ['BOOKED', 'LOADING', 'DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT', 'ARRIVED', 'DISCHARGED', 'CLOSED'];
  const next = ORDER.slice(ORDER.indexOf(s.status));
  const r = await modal({ title: `تحديث الشحنة ${s.shipment_no}`, submitLabel: 'حفظ', body: html`
    <label class="field">الحالة<select class="input" name="status">${options([...next, 'CANCELLED'].map((x) => [x, LABELS.shipment[x]]), s.status, '')}</select></label>
    <p class="faint" style="margin:0">"غادرت / في البحر" تنقل كل سيارات الحاوية إلى "في البحر"، و"وصلت / أُفرغت" تنقلها إلى "في الميناء"، وتُسجَّل الأحداث والتواريخ تلقائيًا.</p>
    <div class="grid g2"><label class="field">رقم الحاوية<input class="input mono" name="containerNo" value="${s.container_no || ''}" pattern="[A-Z]{4}\\d{7}" style="text-transform:uppercase"></label>
      <label class="field">بوليصة الشحن<input class="input mono" name="billOfLading" value="${s.bill_of_lading || ''}"></label></div>
    <div class="grid g2"><label class="field">السفينة<input class="input" name="vesselName" value="${s.vessel_name || ''}"></label><label class="field">الرحلة<input class="input" name="voyageNo" value="${s.voyage_no || ''}"></label></div>
    <div class="grid g2"><label class="field">الوصول المتوقع (ETA)<input class="input" type="date" name="eta" value="${(s.eta || '').slice(0, 10)}"></label>
      <label class="field">الوصول الفعلي<input class="input" type="date" name="ata" value="${(s.ata || '').slice(0, 10)}"></label></div>` });
  if (!r) return;
  const body = clean({ ...r, containerNo: r.containerNo.toUpperCase() });
  if (body.status === s.status) delete body.status;
  if (await guard(() => api(`/shipments/${s.id}`, { method: 'PATCH', body }), 'تم التحديث')) reload();
}

export async function addCarToShipmentDialog(s, reload) {
  const { items } = await api('/vehicles?status=AT_US_WAREHOUSE&pageSize=100');
  const ready = items.filter((v) => !s.vehicles.some((x) => x.id === v.id));
  if (!ready.length) return toast('لا توجد سيارات في "مستودع التصدير" جاهزة للتحميل. انقل السيارة إلى هذه الحالة أولًا من ملفها.', 'err');
  const r = await modal({ title: `تحميل سيارة في ${s.shipment_no}`, submitLabel: 'تحميل', body: html`
    <label class="field">السيارة<select class="input" name="vehicleId" required><option value="">اختر…</option>${ready.map((v) => html`<option value="${v.id}">${v.stock_no} — ${v.year} ${v.make} ${v.model} — ${v.vin}</option>`)}</select></label>
    <p class="faint" style="margin:0">المتاح ${s.capacity - s.vehicles.length} من ${s.capacity}. تنتقل السيارة إلى "محمّلة في الحاوية".</p>` });
  if (r && (await guard(() => api(`/shipments/${s.id}/vehicles`, { method: 'POST', body: r }), 'تم التحميل'))) reload();
}

export async function removeCarFromShipment(s, vehicleId, reload) {
  const ok = await modal({ title: 'إنزال السيارة من الحاوية', submitLabel: 'إنزال', body: html`<p style="margin:0">تعود السيارة إلى "في مستودع التصدير".</p>` });
  if (ok && (await guard(() => api(`/shipments/${s.id}/vehicles/${vehicleId}`, { method: 'DELETE' }), 'تم الإنزال'))) reload();
}

// ======================================================================= الموردون
const VENDOR_TYPES = [['TOWING', 'سحب'], ['FREIGHT_FORWARDER', 'وكيل شحن'], ['SHIPPING_LINE', 'خط ملاحي'], ['INSURANCE', 'تأمين'], ['CUSTOMS_BROKER', 'مخلّص جمركي'], ['INLAND_TRANSPORT', 'نقل بري'], ['WORKSHOP', 'ورشة'], ['AUCTION', 'مزاد'], ['OTHER', 'أخرى']];
export const vendorTypeLabel = (t) => VENDOR_TYPES.find(([v]) => v === t)?.[1] || t;
export async function newVendorDialog() {
  const r = await modal({ title: 'مورد جديد', submitLabel: 'حفظ', body: html`
    <label class="field">الاسم<input class="input" name="name" required minlength="2"></label>
    <div class="grid g3"><label class="field">النوع<select class="input" name="vendorType">${options(VENDOR_TYPES, 'SHIPPING_LINE', '')}</select></label>
      <label class="field">الدولة (رمز من حرفين)<input class="input mono" name="country" maxlength="2" placeholder="LY" style="text-transform:uppercase"></label>
      <label class="field">الهاتف<input class="input num" name="phone"></label></div>` });
  if (!r) return null;
  const v = await guard(() => api('/vendors', { method: 'POST', body: clean({ ...r, country: r.country.toUpperCase() }) }), 'أُضيف المورد');
  if (v) await refreshMeta();
  return v;
}
