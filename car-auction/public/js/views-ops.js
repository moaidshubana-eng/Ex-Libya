import { html, raw, render, $, $$, api, fmt, LABELS, STAGE_COLORS, state, statusBadge, toast, modal, icon } from './core.js';

const can = (...roles) => roles.includes(state.user.role);

// ======================================================================= الشحنات
export async function shipmentsView(el) {
  const { items } = await api('/shipments');
  const open = items.filter((s) => !['CLOSED', 'CANCELLED'].includes(s.status));
  const closed = items.filter((s) => ['CLOSED', 'CANCELLED'].includes(s.status));
  const pct = (s) => ({ BOOKED: 4, LOADING: 10, DEPARTED: 25, IN_TRANSIT: 55, TRANSSHIPMENT: 60, ARRIVED: 92, DISCHARGED: 100, CLOSED: 100 }[s.status] ?? 0);
  const card = (s) => html`<article class="card ship">
    <div class="row" style="justify-content:space-between"><div><b style="font-size:16px">${s.shipment_no}</b> <span class="faint">· ${s.carrier || ''} · ${s.vessel_name || ''} ${s.voyage_no || ''}</span></div><span class="badge">${LABELS.shipment[s.status]}</span></div>
    <div class="route"><div class="port"><b>${s.pol}</b><span class="faint">${fmt.date(s.atd || s.etd)}</span></div>
      <div class="line"><span style="width:${pct(s)}%"></span><div class="ship-ico" style="inset-inline-start:${pct(s)}%">${icon('ship')}</div></div>
      <div class="port" style="text-align:end"><b>${s.pod}</b><span class="faint">${s.ata ? fmt.date(s.ata) : `متوقع ${fmt.date(s.eta)}`}</span></div></div>
    <div class="row faint"><span>الحاوية <span class="mono">${s.container_no}</span> (${s.container_type.replace('C', '')})</span><span>بوليصة <span class="mono">${s.bill_of_lading || '—'}</span></span>
      ${s.last_event ? html`<span>آخر حدث: <b>${s.last_event.code}</b> ${s.last_event.description} · ${fmt.dt(s.last_event.at)}</span>` : ''}<span>تحديث التتبع ${fmt.ago(s.last_tracking_at)}</span></div>
    <div class="row">${s.vehicles.map((v) => html`<a class="chip" href="#/vehicles/${v.id}">${v.stock_no} · ${v.title}</a>`)}<span class="faint">${s.vehicles.length}/${s.capacity}</span>
      ${can('ADMIN', 'ACCOUNTANT', 'OPERATIONS') ? html`<button class="btn btn-sm" style="margin-inline-start:auto" data-shared="${s.id}" data-no="${s.shipment_no}">${icon('plus')} تكلفة مشتركة</button>` : ''}</div>
  </article>`;
  render(el, html`<div class="stack">${open.map(card)}</div>
    <h3 style="margin:26px 2px 10px">شحنات مغلقة</h3>
    <div class="card table-wrap"><table class="t"><thead><tr><th>الشحنة</th><th>الحاوية</th><th>المسار</th><th>الوصول</th><th class="n">سيارات</th></tr></thead>
      <tbody>${closed.map((s) => html`<tr><td>${s.shipment_no}</td><td class="mono">${s.container_no}</td><td>${s.pol} ← ${s.pod}</td><td>${fmt.date(s.ata)}</td><td class="n">${s.vehicles.length}</td></tr>`)}</tbody></table></div>`);

  $$('[data-shared]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = await modal({
      title: `تكلفة مشتركة على ${b.dataset.no}`, submitLabel: 'توزيع التكلفة', body: html`
        <p class="faint" style="margin:0">تُوزَّع على سيارات الحاوية آليًا، ومجموع الحصص يساوي الإجمالي بالضبط (تُوزَّع كسور التقريب بطريقة الباقي الأكبر).</p>
        <label class="field">البند<select class="input" name="categoryCode">${state.meta.costCategories.filter((c) => ['OCEAN', 'LIBYA_PORT', 'CUSTOMS', 'LIBYA_INLAND'].includes(c.stage)).map((c) => html`<option value="${c.code}">${c.name_ar}</option>`)}</select></label>
        <div class="grid g3"><label class="field">الإجمالي<input class="input num" name="totalAmount" required pattern="\\d+(\\.\\d{1,3})?"></label>
          <label class="field">العملة<select class="input" name="currency"><option>USD</option><option>LYD</option><option>EUR</option></select></label>
          <label class="field">التاريخ<input class="input" type="date" name="incurredAt" value="${new Date().toISOString().slice(0, 10)}" required></label></div>
        <label class="field">طريقة التوزيع<select class="input" name="method"><option value="EQUAL">بالتساوي</option><option value="BY_PURCHASE_VALUE">حسب قيمة الشراء</option></select></label>
        <label class="field">الوصف<input class="input" name="description"></label>` });
    if (!r) return;
    try {
      const body = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''));
      const out = await api(`/shipments/${b.dataset.shared}/shared-costs`, { method: 'POST', body });
      toast(`تم التوزيع على ${out.shares.length} سيارات: ${out.shares.map((s) => s.amount).join(' + ')}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }));
}

// ======================================================================= لوحة الجمارك
const CUSTOMS_FLOW = ['DOCS_PENDING', 'SUBMITTED', 'INSPECTION', 'ASSESSED', 'DUTY_PAID', 'RELEASED'];
export async function customsView(el) {
  const { items } = await api('/customs');
  const by = (s) => items.filter((i) => i.status === s);
  const recent = (i) => i.status !== 'RELEASED' || (Date.now() - new Date(i.released_at)) < 14 * 86_400_000;
  render(el, html`
    <p class="muted" style="margin-top:0">مسار كل بيان جمركي من استلام المستندات حتى الإفراج. انقر أي بطاقة لتحديث حالتها؛ الإفراج ينقل السيارة تلقائيًا إلى "مُفرج عنها"، وسداد الرسم يسجله تكلفةً على السيارة.</p>
    <div class="kanban">${CUSTOMS_FLOW.map((s) => html`<div class="kcol"><h4><span>${LABELS.customs[s]}</span><span class="badge">${by(s).length}</span></h4>
      ${by(s).filter(recent).map((i) => html`<div class="kitem" tabindex="0" role="button" data-id="${i.id}">
        <div class="row" style="justify-content:space-between"><b>${i.stock_no}</b><span class="faint">${i.port}</span></div>
        <div>${i.title}</div><div class="mono faint">${i.vin}</div>
        <div class="row faint" style="justify-content:space-between"><span>${i.declaration_no || 'بلا بيان'}</span>${s !== 'RELEASED' ? html`<span class="${i.days_open > 7 ? 'neg' : ''}">${i.days_open} يوم</span>` : ''}</div>
        ${i.duty_amount_lyd ? html`<div class="faint">الرسم: <b class="num">${fmt.lyd(i.duty_amount_lyd)}</b></div>` : ''}
      </div>`)}</div>`)}</div>
    ${by('REJECTED').length ? html`<div class="card" style="margin-top:16px"><div class="card-h"><h3>مرفوضة</h3></div><div class="card-b">${by('REJECTED').map((i) => html`<div>${i.stock_no} — ${i.rejection_reason}</div>`)}</div></div>` : ''}`);

  const open = async (id) => {
    const i = items.find((x) => x.id === id);
    if (!can('ADMIN', 'OPERATIONS')) return (location.hash = `#/vehicles/${i.vehicle_id}`);
    const r = await modal({
      title: `البيان الجمركي — ${i.stock_no}`, submitLabel: 'تحديث', body: html`
        <div class="faint">${i.title} · <span class="mono">${i.vin}</span> · <a href="#/vehicles/${i.vehicle_id}">ملف السيارة</a></div>
        <label class="field">الحالة<select class="input" name="status">${[...CUSTOMS_FLOW, 'REJECTED'].map((s) => html`<option value="${s}" ${s === i.status ? 'selected' : ''}>${LABELS.customs[s]}</option>`)}</select></label>
        <label class="field">رقم البيان<input class="input" name="declarationNo" value="${i.declaration_no || ''}"></label>
        <div class="grid g2"><label class="field">القيمة المقدرة (د.ل)<input class="input num" name="assessedValueLyd" value="${i.assessed_value_lyd || ''}"></label>
          <label class="field">الرسم الجمركي (د.ل)<input class="input num" name="dutyAmountLyd" value="${i.duty_amount_lyd || ''}"></label></div>
        <label class="field">سبب الرفض (عند الرفض)<input class="input" name="rejectionReason" value="${i.rejection_reason || ''}"></label>` });
    if (!r) return;
    try {
      const body = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''));
      await api(`/customs/${id}`, { method: 'PATCH', body });
      toast('تم تحديث البيان', 'ok');
      customsView(el);
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('.kitem', el).forEach((k) => {
    k.addEventListener('click', () => open(k.dataset.id));
    k.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(k.dataset.id); });
  });
}

// ======================================================================= تقرير التكاليف
export async function reportsView(el, { query }) {
  const f = { status: '', make: '', from: '', to: '', ...query };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const r = await api(`/reports/costs?${qs}`);
  const t = r.totals;
  const STG = [['purchase_lyd', 'PURCHASE'], ['us_logistics_lyd', 'US_LOGISTICS'], ['ocean_lyd', 'OCEAN'], ['libya_port_lyd', 'LIBYA_PORT'], ['customs_lyd', 'CUSTOMS'], ['libya_inland_lyd', 'LIBYA_INLAND'], ['preparation_lyd', 'PREPARATION'], ['overhead_lyd', 'OVERHEAD']];
  const totalCost = Number(t.total_cost_lyd) || 1;

  render(el, html`
    <div class="print-only" style="margin-bottom:10px"><h2 style="margin:0">تقرير تكاليف السيارات المستوردة</h2>
      <div>صدر في ${fmt.dt(r.generatedAt)} · بواسطة ${state.user.full_name} · ${qs ? `مرشحات: ${decodeURIComponent(qs)}` : 'كل السيارات'}</div></div>
    <form class="card filters no-print" data-f>
      <label class="field">الحالة<select class="input" name="status"><option value="">الكل</option>${state.meta.statuses.map((s) => html`<option value="${s.code}" ${s.code === f.status ? 'selected' : ''}>${s.label}</option>`)}</select></label>
      <label class="field">الماركة<select class="input" name="make"><option value="">الكل</option>${state.meta.makes.map((m) => html`<option ${m === f.make ? 'selected' : ''}>${m}</option>`)}</select></label>
      <label class="field">من تاريخ<input class="input" type="date" name="from" value="${f.from}"></label>
      <label class="field">إلى تاريخ<input class="input" type="date" name="to" value="${f.to}"></label>
      <button class="btn btn-primary">تطبيق</button>
      <span style="flex:1"></span>
      <a class="btn" href="/api/reports/costs.xlsx?${qs}" download>${icon('xls')} Excel</a>
      <a class="btn" href="/api/reports/costs.csv?${qs}" download>CSV</a>
      <button type="button" class="btn" data-print>${icon('pdf')} PDF / طباعة</button>
    </form>
    <div class="grid g4" style="margin-top:16px">
      ${kpi('عدد السيارات', fmt.n(t.vehicles), `${t.sold} مباعة`)}${kpi('إجمالي التكلفة الواصلة', fmt.lyd(t.total_cost_lyd), `غير مسدد ${fmt.lyd(t.unpaid_lyd)}`)}
      ${kpi('إجمالي المبيعات', fmt.lyd(t.sale_price_lyd), '')}${kpi('هامش الربح المحقق', fmt.lyd(t.margin_lyd), t.avg_margin_pct != null ? `${t.avg_margin_pct}% على التكلفة` : '')}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>توزيع التكاليف حسب المرحلة</h3></div><div class="card-b stack" style="gap:10px">
      <div class="bar" style="height:16px">${STG.map(([k, s]) => html`<span title="${LABELS.stage[s]}" style="width:${(Number(t[k]) / totalCost) * 100}%;background:${STAGE_COLORS[s]}"></span>`)}</div>
      <div class="row" style="gap:16px">${STG.map(([k, s]) => html`<span class="row" style="gap:6px"><span style="width:10px;height:10px;border-radius:3px;background:${STAGE_COLORS[s]}"></span>${LABELS.stage[s]} <b class="num">${fmt.lyd(t[k])}</b> <span class="faint">${((Number(t[k]) / totalCost) * 100).toFixed(1)}%</span></span>`)}</div>
    </div></div>
    <div class="card table-wrap" style="margin-top:16px"><table class="t">
      <thead><tr><th>المخزون</th><th>السيارة</th><th>الحالة</th>${STG.map(([, s]) => html`<th class="n">${LABELS.stage[s]}</th>`)}<th class="n">الإجمالي</th><th class="n">البيع</th><th class="n">الهامش</th></tr></thead>
      <tbody>${r.rows.map((x) => html`<tr><td><a href="#/vehicles/${x.vehicle_id}">${x.stock_no}</a></td><td>${x.year} ${x.make} ${x.model}</td><td>${statusBadge(x.status)}</td>
        ${STG.map(([k]) => html`<td class="n">${Number(x[k]) ? fmt.n(x[k]) : html`<span class="faint">—</span>`}</td>`)}
        <td class="n"><b>${fmt.n(x.total_cost_lyd)}</b>${Number(x.estimated_part_lyd) ? html`<span class="faint" title="يتضمن تقديرات"> *</span>` : ''}</td>
        <td class="n">${x.sale_price_lyd ? fmt.n(x.sale_price_lyd) : '—'}</td>
        <td class="n ${x.margin_lyd == null ? '' : Number(x.margin_lyd) >= 0 ? 'pos' : 'neg'}">${x.margin_lyd == null ? '—' : fmt.n(x.margin_lyd)}</td></tr>`)}</tbody>
      <tfoot><tr><td colspan="3">الإجمالي (د.ل)</td>${STG.map(([k]) => html`<td class="n">${fmt.n(t[k])}</td>`)}<td class="n">${fmt.n(t.total_cost_lyd)}</td><td class="n">${fmt.n(t.sale_price_lyd)}</td><td class="n">${fmt.n(t.margin_lyd)}</td></tr></tfoot>
    </table></div>
    <p class="faint">* السيارة تتضمن بنود تكلفة تقديرية (مثل رسم جمركي متوقع) ستُستبدل بالفعلية عند تسجيلها. كل المبالغ بالدينار الليبي بسعر الصرف المحفوظ لحظة تسجيل كل بند.</p>`);

  $('[data-f]', el).addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/reports?${new URLSearchParams(Object.entries(Object.fromEntries(new FormData(e.target))).filter(([, v]) => v))}`;
  });
  $('[data-print]', el).addEventListener('click', () => window.print());
}
const kpi = (label, value, sub) => html`<div class="card kpi"><span class="label">${label}</span><span class="value num">${value}</span><span class="sub">${sub}</span></div>`;

// ======================================================================= التكامل والمزامنة
export async function integrationsView(el) {
  const d = await api('/integrations');
  const canRun = can('ADMIN', 'OPERATIONS');
  const srcState = (s) => s.circuit_open_until && new Date(s.circuit_open_until) > new Date() ? html`<span class="badge" style="color:var(--danger)"><span class="dot"></span>قاطع الدائرة مفتوح حتى ${fmt.dt(s.circuit_open_until)}</span>`
    : s.consecutive_failures ? html`<span class="badge" style="color:var(--accent)"><span class="dot"></span>${s.consecutive_failures} إخفاقات متتالية</span>`
    : html`<span class="badge" style="color:var(--success)"><span class="dot"></span>سليم</span>`;
  render(el, html`
    <div class="grid g3">${d.sources.filter((s) => ['COPART', 'IAAI', 'TRACKING'].includes(s.code)).map((s) => html`<div class="card card-b stack" style="gap:8px">
      <div class="row" style="justify-content:space-between"><b style="font-size:16px">${s.name}</b>${srcState(s)}</div>
      <div class="faint">آخر مزامنة ناجحة: ${fmt.dt(s.last_success_at)} (${fmt.ago(s.last_success_at)}) · الدورية كل ${Math.round(s.sync_interval_sec / 60)} دقيقة</div>
      <div class="faint">مؤشر التزامن التزايدي: <span class="mono">${s.last_cursor ? fmt.dt(s.last_cursor) : '—'}</span></div>
      ${canRun ? html`<button class="btn btn-primary" data-sync="${s.code}">${icon('sync')} مزامنة الآن</button>` : ''}
    </div>`)}</div>
    ${canRun ? html`<div class="card card-b" style="margin-top:16px"><div class="row"><b>استيراد ملف CSV</b><span class="faint">(تصدير بوابة Copart/IAAI أو ملف الوسيط) — الأعمدة: lot_number, vin, year, make, model, trim, color, odometer, title, damage, yard, state, purchase_price_usd, buyer_fee_usd, sale_date</span>
      <input type="file" accept=".csv,text/csv" data-csv class="input" style="max-width:320px"></div></div>` : ''}
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>طابور الأخطاء (Dead-letter)</h3><span class="badge">${d.deadLetters.length}</span><span style="flex:1"></span><span class="faint">عناصر فشلت بعد كل المحاولات — صحّح السبب ثم أعد المعالجة</span></div>
      ${d.deadLetters.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>المصدر</th><th>المرجع</th><th>الخطأ</th><th class="n">محاولات</th><th>التاريخ</th><th></th></tr></thead>
        <tbody>${d.deadLetters.map((x) => html`<tr><td>${x.id}</td><td>${x.source}</td><td class="mono">${x.external_ref}</td><td>${x.error}</td><td class="n">${x.attempts}</td><td>${fmt.dt(x.created_at)}</td>
          <td>${canRun ? html`<button class="btn btn-sm" data-retry="${x.id}">إعادة المعالجة</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<div class="empty">لا توجد أخطاء معلقة</div>`}</div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h3>سجل جولات المزامنة</h3></div><div class="table-wrap"><table class="t">
      <thead><tr><th>#</th><th>المصدر</th><th>النوع</th><th>الحالة</th><th>المُشغِّل</th><th class="n">مقروءة</th><th class="n">جديدة</th><th class="n">محدثة</th><th class="n">بلا تغيير</th><th class="n">فاشلة</th><th class="n">المدة</th><th>البداية</th><th>الخطأ</th></tr></thead>
      <tbody>${d.jobs.map((j) => html`<tr><td>${j.id}</td><td>${j.source}</td><td>${j.job_type}</td>
        <td><span class="badge" style="color:${{ SUCCEEDED: 'var(--success)', PARTIAL: 'var(--accent)', FAILED: 'var(--danger)' }[j.status] || 'var(--info)'}"><span class="dot"></span>${LABELS.job[j.status]}</span></td>
        <td class="faint">${j.triggered_by.startsWith('USER') ? 'مستخدم' : j.triggered_by === 'SCHEDULER' ? 'المجدول' : j.triggered_by}</td>
        <td class="n">${j.items_seen}</td><td class="n">${j.items_created}</td><td class="n">${j.items_updated}</td><td class="n">${j.items_unchanged}</td><td class="n ${j.items_failed ? 'neg' : ''}">${j.items_failed}</td>
        <td class="n">${j.seconds ?? '—'}ث</td><td>${fmt.dt(j.started_at)}</td><td class="faint">${j.error || ''}</td></tr>`)}</tbody></table></div></div>`);

  $$('[data-sync]', el).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'جارٍ…';
    try {
      const r = await api(`/integrations/${b.dataset.sync}/sync`, { method: 'POST', body: {} });
      toast(`${b.dataset.sync}: ${r.created} جديدة، ${r.updated} محدثة، ${r.unchanged} بلا تغيير، ${r.failed} فاشلة${r.error ? ` — ${r.error}` : ''}`, r.error ? 'err' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
    integrationsView(el);
  }));
  $$('[data-retry]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/integrations/dead-letters/${b.dataset.retry}/retry`, { method: 'POST', body: {} });
    toast(r.ok ? 'تمت المعالجة بنجاح' : `ما زال يفشل: ${r.error}`, r.ok ? 'ok' : 'err');
    integrationsView(el);
  }));
  $('[data-csv]', el)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const r = await api('/integrations/csv', { method: 'POST', body: await file.text(), headers: { 'Content-Type': 'text/csv' } });
      toast(`CSV: ${r.created} جديدة، ${r.updated} محدثة، ${r.failed} فاشلة`, r.failed ? '' : 'ok');
    } catch (err) { toast(err.message, 'err'); }
    integrationsView(el);
  });
}

// ======================================================================= سجل التدقيق
export async function auditView(el) {
  const { items } = await api('/audit');
  render(el, html`<div class="card table-wrap"><table class="t"><thead><tr><th>#</th><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>الكيان</th><th>التفاصيل</th><th>IP</th></tr></thead>
    <tbody>${items.map((a) => html`<tr><td>${a.id}</td><td>${fmt.dt(a.at)}</td><td>${a.actor || 'النظام'}</td><td><b>${a.action}</b></td><td>${a.entity} <span class="mono faint">${(a.entity_id || '').slice(0, 8)}</span></td>
      <td class="faint" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.after_data ? JSON.stringify(a.after_data) : ''}</td><td class="mono faint">${a.ip || ''}</td></tr>`)}</tbody></table></div>
    <p class="faint">سجل التدقيق للإلحاق فقط: قاعدة البيانات نفسها ترفض أي تعديل أو حذف عليه.</p>`);
}

export { raw };
