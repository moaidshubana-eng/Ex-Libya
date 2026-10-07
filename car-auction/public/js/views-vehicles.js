import { html, raw, render, $, $$, api, fmt, LABELS, STAGE_COLORS, state, statusBadge, imgUrl, toast, modal, icon } from './core.js';
import { galleryTemplate, mountGallery, openLightbox } from './gallery.js';

const can = (...roles) => roles.includes(state.user.role);
const STAGES = [
  ['USA', 'في أمريكا'], ['OCEAN', 'الشحن البحري'], ['LIBYA', 'ليبيا: الميناء والجمارك'], ['SALES', 'المبيعات'], ['CLOSED', 'منتهية'],
];

// ======================================================================= لوحة المؤشرات
export async function dashboardView(el) {
  const d = await api('/dashboard');
  const count = Object.fromEntries(d.byStatus.map((s) => [s.status, s.n]));
  const total = d.byStatus.reduce((a, s) => a + s.n, 0);
  const st = state.meta.statuses;
  const sum = (codes) => codes.reduce((a, c) => a + (count[c] || 0), 0);
  const inTransit = sum(['LOADED', 'IN_TRANSIT_SEA']);
  const atPort = sum(['AT_PORT_LIBYA', 'IN_CUSTOMS']);
  const syncBad = d.sync.filter((s) => s.circuit_open_until || s.consecutive_failures > 0 || s.open_errors > 0);

  render(el, html`
    <div class="grid g4">
      ${kpi('money', 'قيمة المخزون (التكلفة الواصلة)', fmt.lyd(d.money.inventory_cost_lyd), `${total - sum(['SOLD', 'DELIVERED', 'CANCELLED'])} سيارة غير مباعة`, '#0b3b66')}
      ${kpi('ship', 'في الطريق بحرًا', fmt.n(inTransit), `${d.shipments.length} شحنة مفتوحة`, '#0284c7')}
      ${kpi('customs', 'في الميناء والجمارك', fmt.n(atPort), d.aging.find((a) => a.status === 'IN_CUSTOMS') ? `متوسط ${d.aging.find((a) => a.status === 'IN_CUSTOMS').avg_days} يوم في الجمارك` : '', '#f97316')}
      ${kpi('gavel', 'مزايدات حية', fmt.n(d.auctions.open_lots), `${d.auctions.open_bids} مزايدة على اللوتات المفتوحة`, '#e11d48')}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>دورة حياة الأسطول</h2><span class="faint">${total} سيارة · انقر أي حالة لعرض سياراتها</span></div>
      <div class="card-b stack">
        <div class="bar" role="img" aria-label="توزيع السيارات حسب الحالة">${st.filter((s) => count[s.code]).map((s) => html`<span title="${s.label}: ${count[s.code]}" style="width:${(count[s.code] / total) * 100}%;background:${s.color}"></span>`)}</div>
        <div class="pipeline">${STAGES.map(([stage, label]) => {
          const list = st.filter((s) => s.stage === stage);
          return html`<div class="stage"><h4><span>${label}</span><b class="num">${sum(list.map((s) => s.code))}</b></h4>
            ${list.map((s) => html`<a class="s-row" href="#/vehicles?status=${s.code}"><span><span class="badge" style="color:${s.color};padding:0 6px;border:0;background:none"><span class="dot"></span></span>${s.label}</span><b>${count[s.code] || 0}</b></a>`)}</div>`;
        })}
          <div class="stage"><h4><span>استثناءات</span><b class="num">${sum(['ON_HOLD', 'CANCELLED'])}</b></h4>
            ${st.filter((s) => s.stage === 'EXCEPTION').map((s) => html`<a class="s-row" href="#/vehicles?status=${s.code}"><span>${s.label}</span><b>${count[s.code] || 0}</b></a>`)}</div>
        </div>
      </div>
    </div>

    <div class="grid g2" style="margin-top:16px;grid-template-columns:1.5fr 1fr">
      <div class="card">
        <div class="card-h"><h2>الشحنات المفتوحة</h2><span class="spacer" style="flex:1"></span><a href="#/shipments">عرض الكل</a></div>
        <div class="table-wrap"><table class="t">
          <thead><tr><th>الشحنة</th><th>الحاوية</th><th>السفينة</th><th>الوجهة</th><th>الحالة</th><th>الوصول المتوقع</th><th class="n">السيارات</th></tr></thead>
          <tbody>${d.shipments.map((s) => html`<tr><td><b>${s.shipment_no}</b></td><td class="mono">${s.container_no}</td><td>${s.vessel_name || '—'}</td><td>${s.pod}</td>
            <td><span class="badge">${LABELS.shipment[s.status]}</span></td><td>${fmt.date(s.eta)}</td><td class="n">${s.cars}</td></tr>`)}</tbody>
        </table></div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-h"><h2>المؤشرات المالية</h2></div>
          <div class="card-b stack" style="gap:10px">
            ${line('إجمالي المبيعات', fmt.lyd(d.money.sales_lyd))}
            ${line('هامش الربح المحقق', raw(`<span class="${Number(d.money.realized_margin_lyd) >= 0 ? 'pos' : 'neg'}">${fmt.lyd(d.money.realized_margin_lyd)}</span>`))}
            ${line('مستحقات غير مسددة للموردين', fmt.lyd(d.money.unpaid_lyd))}
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h2>صحة الربط الخارجي</h2><span style="flex:1"></span><a href="#/integrations">التفاصيل</a></div>
          <div class="card-b stack" style="gap:8px">
            ${d.sync.map((s) => html`<div class="row" style="justify-content:space-between">
              <span><b>${s.name}</b> <span class="faint">آخر نجاح ${fmt.ago(s.last_success_at)}</span></span>
              ${s.circuit_open_until ? html`<span class="badge" style="color:var(--danger)"><span class="dot"></span>موقوف مؤقتًا</span>`
                : s.open_errors ? html`<span class="badge" style="color:var(--accent)"><span class="dot"></span>${s.open_errors} أخطاء</span>`
                : html`<span class="badge" style="color:var(--success)"><span class="dot"></span>سليم</span>`}
            </div>`)}
            ${syncBad.length ? html`<div class="alert">توجد عناصر تحتاج مراجعة في طابور أخطاء المزامنة.</div>` : ''}
          </div>
        </div>
      </div>
    </div>`);
}

const kpi = (ic, label, value, sub, c) => html`<div class="card kpi" style="--c:${c}"><span class="label"><span class="ico">${icon(ic)}</span>${label}</span><span class="value num">${value}</span><span class="sub">${sub}</span></div>`;
const line = (k, v) => html`<div class="row" style="justify-content:space-between"><span class="muted">${k}</span><b class="num">${v}</b></div>`;

// ======================================================================= قائمة السيارات
export async function vehiclesView(el, { query }) {
  const f = { q: '', status: '', make: '', source: '', sort: 'newest', page: '1', view: 'grid', ...query };
  const staff = state.user.role !== 'BIDDER';
  const params = new URLSearchParams(Object.entries({ ...f, pageSize: 24 }).filter(([k, v]) => v && k !== 'view'));
  const data = await api(`/vehicles?${params}`);
  const selected = new Set(f.status ? f.status.split(',') : []);
  const pages = Math.ceil(data.total / data.pageSize);

  const go = (patch) => {
    const next = { ...f, page: '1', ...patch };
    location.hash = `#/vehicles?${new URLSearchParams(Object.entries(next).filter(([, v]) => v))}`;
  };

  render(el, html`
    <div class="card">
      <form class="filters" data-filters>
        <label class="field grow">بحث<input class="input" name="q" value="${f.q}" placeholder="VIN، رقم المخزون، رقم اللوت، الحاوية، الطراز…" autocomplete="off"></label>
        <label class="field">الماركة<select class="input" name="make"><option value="">الكل</option>${state.meta.makes.map((m) => html`<option ${m === f.make ? 'selected' : ''}>${m}</option>`)}</select></label>
        ${staff ? html`<label class="field">المصدر<select class="input" name="source"><option value="">الكل</option>${['COPART', 'IAAI'].map((s) => html`<option ${s === f.source ? 'selected' : ''}>${s}</option>`)}</select></label>` : ''}
        <label class="field">الترتيب<select class="input" name="sort">${[['newest', 'الأحدث'], ['year_desc', 'سنة الصنع'], ['price_asc', 'السعر ↑'], ['price_desc', 'السعر ↓'], ['eta', 'أقرب وصول'], ['status', 'الحالة']].map(([v, l]) => html`<option value="${v}" ${v === f.sort ? 'selected' : ''}>${l}</option>`)}</select></label>
        <button class="btn btn-primary">تطبيق</button>
        <div class="row" style="margin-inline-start:auto">
          <button type="button" class="btn btn-sm ${f.view === 'grid' ? 'btn-primary' : ''}" data-view="grid">بطاقات</button>
          <button type="button" class="btn btn-sm ${f.view === 'table' ? 'btn-primary' : ''}" data-view="table">جدول</button>
        </div>
      </form>
      ${staff ? html`<div class="row" style="padding:0 16px 14px">${state.meta.statuses.map((s) => html`<button type="button" class="chip ${selected.has(s.code) ? 'on' : ''}" data-status="${s.code}">${s.label}</button>`)}
        ${selected.size ? html`<button type="button" class="btn btn-sm btn-ghost" data-status="">مسح</button>` : ''}</div>` : ''}
    </div>
    <div class="row" style="margin:14px 2px;justify-content:space-between"><span class="muted"><b class="num">${data.total}</b> سيارة</span></div>
    ${!data.items.length ? html`<div class="card empty">لا توجد نتائج مطابقة</div>`
      : f.view === 'table' ? vehiclesTable(data.items) : html`<div class="vgrid">${data.items.map(vehicleCard)}</div>`}
    ${pages > 1 ? html`<nav class="pager" aria-label="الصفحات">${Array.from({ length: pages }, (_, i) => html`<button class="btn btn-sm ${String(i + 1) === f.page ? 'btn-primary' : ''}" data-page="${i + 1}">${i + 1}</button>`)}</nav>` : ''}
    <div data-cmp></div>`);

  $('[data-filters]', el).addEventListener('submit', (e) => {
    e.preventDefault();
    go(Object.fromEntries(new FormData(e.target)));
  });
  $$('[data-status]', el).forEach((b) => b.addEventListener('click', () => {
    const s = b.dataset.status;
    if (!s) return go({ status: '' });
    selected.has(s) ? selected.delete(s) : selected.add(s);
    go({ status: [...selected].join(',') });
  }));
  $$('[data-view]', el).forEach((b) => b.addEventListener('click', () => go({ view: b.dataset.view, page: f.page })));
  $$('[data-page]', el).forEach((b) => b.addEventListener('click', () => go({ page: b.dataset.page })));
  bindCompare(el);
}

function vehicleCard(v) {
  const staff = state.user.role !== 'BIDDER';
  return html`<article class="card vcard">
    <a class="img" href="#/vehicles/${v.id}" aria-label="${v.year} ${v.make} ${v.model}">${v.image_id ? html`<img src="${imgUrl(v.id, v.image_id)}" alt="" loading="lazy">` : ''}${statusBadge(v.status)}</a>
    <label class="cmp"><input type="checkbox" data-compare="${v.id}" ${state.compare.has(v.id) ? 'checked' : ''}> مقارنة</label>
    <div class="body">
      <h3><a href="#/vehicles/${v.id}" style="color:inherit">${v.year} ${v.make} ${v.model}</a> <span class="faint">${v.trim || ''}</span></h3>
      <div class="meta"><span class="mono">${v.vin}</span></div>
      <div class="meta"><span>${fmt.odo(v.odometer, v.odometer_unit)}</span><span>${LABELS.title[v.title_type]}</span><span>${v.primary_damage || ''}</span></div>
      ${staff && v.container_no ? html`<div class="meta">${icon('ship')}<span class="mono">${v.container_no}</span><span>وصول ${fmt.date(v.eta)}</span></div>` : ''}
      <div class="foot">
        <span class="faint">${v.stock_no}${staff && v.source ? ` · ${v.source} ${v.lot_number}` : ''}</span>
        ${v.total_cost_lyd != null ? html`<b class="num" title="التكلفة الواصلة حتى الآن">${fmt.lyd(v.total_cost_lyd)}</b>` : v.list_price_lyd ? html`<b class="num">${fmt.lyd(v.list_price_lyd)}</b>` : ''}
      </div>
    </div>
  </article>`;
}

function vehiclesTable(items) {
  return html`<div class="card table-wrap"><table class="t">
    <thead><tr><th></th><th>المخزون</th><th>السيارة</th><th>VIN</th><th>الحالة</th><th>المصدر</th><th>الحاوية</th><th>الوصول</th><th class="n">التكلفة</th></tr></thead>
    <tbody>${items.map((v) => html`<tr>
      <td><input type="checkbox" data-compare="${v.id}" ${state.compare.has(v.id) ? 'checked' : ''} aria-label="مقارنة"></td>
      <td><a href="#/vehicles/${v.id}"><b>${v.stock_no}</b></a></td><td>${v.year} ${v.make} ${v.model}</td><td class="mono">${v.vin}</td>
      <td>${statusBadge(v.status)}</td><td>${v.source ? `${v.source} ${v.lot_number}` : '—'}</td><td class="mono">${v.container_no || '—'}</td><td>${fmt.date(v.eta)}</td>
      <td class="n">${v.total_cost_lyd != null ? fmt.lyd(v.total_cost_lyd) : '—'}</td></tr>`)}</tbody></table></div>`;
}

function bindCompare(el) {
  const bar = $('[data-cmp]', el);
  const draw = () => {
    render(bar, state.compare.size ? html`<div class="cmp-bar">${icon('compare')}<b>${state.compare.size} سيارات للمقارنة</b><span style="flex:1"></span>
      <button class="btn btn-sm" data-clear>مسح</button><a class="btn btn-sm" href="#/compare?ids=${[...state.compare].join(',')}" ${state.compare.size < 2 ? 'aria-disabled="true"' : ''}>قارن الآن</a></div>` : html``);
    $('[data-clear]', bar)?.addEventListener('click', () => { state.compare.clear(); $$('[data-compare]', el).forEach((c) => { c.checked = false; }); draw(); });
  };
  $$('[data-compare]', el).forEach((c) => c.addEventListener('change', () => {
    if (c.checked) {
      if (state.compare.size >= 4) { c.checked = false; return toast('الحد الأقصى 4 سيارات للمقارنة', 'err'); }
      state.compare.add(c.dataset.compare);
    } else state.compare.delete(c.dataset.compare);
    draw();
  }));
  draw();
}

// ======================================================================= تفاصيل السيارة
export async function vehicleDetailView(el, { params, setTitle }) {
  const v = await api(`/vehicles/${params.id}`);
  const title = `${v.year} ${v.make} ${v.model} ${v.trim || ''}`.trim();
  setTitle(title, v.stock_no);
  const urlOf = (im) => imgUrl(v.id, im.id);
  const staff = state.user.role !== 'BIDDER';
  const MAIN = ['PURCHASED', 'AWAITING_PICKUP', 'US_INLAND_TRANSIT', 'AT_US_WAREHOUSE', 'LOADED', 'IN_TRANSIT_SEA', 'AT_PORT_LIBYA', 'IN_CUSTOMS', 'CUSTOMS_CLEARED', 'LY_INLAND_TRANSIT', 'IN_STOCK', 'SOLD', 'DELIVERED'];
  const effective = v.status === 'ON_HOLD' ? (v.history.filter((h) => h.to_status !== 'ON_HOLD').at(-1)?.to_status) : v.status === 'IN_AUCTION' ? 'IN_STOCK' : v.status;
  const curIdx = MAIN.indexOf(effective);
  const label = (c) => state.meta.statuses.find((s) => s.code === c)?.label || c;
  const listing = v.listings[0];

  const tabs = [['specs', 'المواصفات الفنية'], ...(staff ? [['track', 'الشحن والجمارك'], ...(v.costs ? [['costs', 'التكاليف']] : []), ['source', 'بيانات المصدر'], ['history', 'السجل']] : [])];

  render(el, html`
    ${v.status === 'ON_HOLD' && staff ? html`<div class="alert danger" style="margin-bottom:14px"><b>معلقة:</b> ${v.hold_reason}</div>` : ''}
    <div class="detail">
      <div class="stack">
        ${galleryTemplate(v.images, urlOf, title)}
        ${staff ? html`<div class="card"><div class="timeline" aria-label="مراحل دورة الحياة">${MAIN.map((s, i) => html`<div class="tl ${i < curIdx ? 'done' : i === curIdx ? 'cur' : ''}"><div class="pt"></div>${label(s)}</div>`)}</div></div>` : ''}
        <div class="card">
          <div class="tabs" role="tablist">${tabs.map(([k, l], i) => html`<button role="tab" class="${i === 0 ? 'on' : ''}" data-tab="${k}">${l}</button>`)}</div>
          <div class="card-b" data-tabbody></div>
        </div>
      </div>
      <aside class="stack">
        <div class="card card-b stack" style="gap:12px">
          <div class="row" style="justify-content:space-between">${statusBadge(v.status)}<span class="faint">${v.stock_no}</span></div>
          <h2 style="margin:0;font-size:22px">${title}</h2>
          <div class="row"><span class="mono">${v.vin}</span><button class="btn btn-sm btn-ghost" data-copy="${v.vin}">نسخ</button></div>
          <div class="grid g3" style="gap:8px;text-align:center">
            ${mini('العداد', fmt.odo(v.odometer, v.odometer_unit))}${mini('الملكية', LABELS.title[v.title_type])}${mini('التقييم', v.condition_grade ? `${v.condition_grade} / 5` : '—')}
          </div>
          ${v.lot && ['OPEN', 'PENDING'].includes(v.lot.status) ? html`<a class="btn btn-accent" href="#/lots/${v.lot.id}">${icon('gavel')} المزايدة الحية — ${fmt.lyd(v.lot.current_price)}</a>` : ''}
          ${v.costs ? html`<div class="row" style="justify-content:space-between;border-top:1px dashed var(--border);padding-top:10px"><span class="muted">التكلفة الواصلة حتى الآن</span><b class="num" style="font-size:18px">${fmt.lyd(v.costs.summary.total_cost_lyd)}</b></div>` : ''}
          ${v.sale ? html`<div class="row" style="justify-content:space-between"><span class="muted">سعر البيع (${v.sale.invoice_no})</span><b class="num">${fmt.lyd(v.sale.sale_price_lyd)}</b></div>` : ''}
          ${can('ADMIN', 'SALES') && v.status === 'IN_STOCK' ? html`<button class="btn btn-accent" data-list>${icon('gavel')} إدراج في مزاد</button>` : ''}
          ${can('ADMIN', 'OPERATIONS') && v.next_statuses.length ? html`<div class="row" style="border-top:1px dashed var(--border);padding-top:10px">
            <select class="input" data-next style="flex:1">${v.next_statuses.map((s) => html`<option value="${s}">${label(s)}</option>`)}</select>
            <button class="btn btn-primary" data-move>تحديث الحالة</button></div>` : ''}
        </div>
        ${v.shipment && staff ? html`<div class="card card-b stack" style="gap:8px">
          <div class="row" style="justify-content:space-between"><b>${icon('ship')} ${v.shipment.shipment_no}</b><span class="badge">${LABELS.shipment[v.shipment.status]}</span></div>
          ${routeBar(v.shipment)}
          <div class="faint">الحاوية <span class="mono">${v.shipment.container_no}</span> · ${v.shipment.carrier || ''} · ${v.shipment.vessel_name || ''}</div>
        </div>` : ''}
        ${v.customs && staff ? html`<div class="card card-b stack" style="gap:6px"><div class="row" style="justify-content:space-between"><b>${icon('customs')} الجمارك — ${v.customs.port}</b><span class="badge">${LABELS.customs[v.customs.status]}</span></div>
          <div class="faint">${v.customs.declaration_no ? `بيان ${v.customs.declaration_no}` : 'لم يُقدَّم البيان بعد'} · ${v.customs.broker || ''}</div></div>` : ''}
      </aside>
    </div>`);

  mountGallery(el, v.images, urlOf, title);
  $('[data-copy]', el)?.addEventListener('click', (e) => navigator.clipboard?.writeText(e.target.dataset.copy).then(() => toast('تم نسخ VIN', 'ok')));
  $('[data-move]', el)?.addEventListener('click', async () => {
    const to = $('[data-next]', el).value;
    let reason = null;
    if (to === 'ON_HOLD' || to === 'CANCELLED') {
      const r = await modal({ title: to === 'ON_HOLD' ? 'تعليق السيارة' : 'إلغاء السيارة', body: html`<label class="field">السبب (إلزامي)<textarea class="input" name="reason" required minlength="3" rows="3"></textarea></label>`, submitLabel: 'تأكيد', danger: to === 'CANCELLED' });
      if (!r) return;
      reason = r.reason;
    }
    try {
      await api(`/vehicles/${v.id}/status`, { method: 'POST', body: { to, reason, version: v.version } });
      toast(`تم نقل السيارة إلى "${label(to)}"`, 'ok');
      vehicleDetailView(el, { params, setTitle });
    } catch (e) { toast(e.message, 'err'); }
  });

  $('[data-list]', el)?.addEventListener('click', async () => {
    const { events } = await api('/auctions');
    const open = events.filter((e) => ['SCHEDULED', 'LIVE'].includes(e.status) && new Date(e.ends_at) > new Date());
    if (!open.length) return toast('لا يوجد مزاد مجدول أو مباشر حاليًا', 'err');
    const cost = v.costs?.summary?.total_cost_lyd;
    const r = await modal({
      title: 'إدراج السيارة في مزاد', submitLabel: 'إدراج', body: html`
        <label class="field">المزاد<select class="input" name="eventId">${open.map((e) => html`<option value="${e.id}">${e.title} — ${fmt.dt(e.starts_at)}</option>`)}</select></label>
        <div class="grid g2"><label class="field">سعر الافتتاح (د.ل)<input class="input num" name="startingPrice" required pattern="\\d+" value="${cost ? Math.round((Number(cost) * 0.85) / 500) * 500 : ''}"></label>
        <label class="field">الحد الأدنى السري (اختياري)<input class="input num" name="reservePrice" pattern="\\d+" value="${cost ? Math.round((Number(cost) * 1.1) / 500) * 500 : ''}"></label></div>
        ${cost ? html`<p class="faint" style="margin:0">التكلفة الواصلة حتى الآن ${fmt.lyd(cost)} — القيم المقترحة 85% و110% منها.</p>` : ''}` });
    if (!r) return;
    try {
      const lot = await api(`/auctions/${r.eventId}/lots`, { method: 'POST', body: { vehicleId: v.id, startingPrice: r.startingPrice, ...(r.reservePrice ? { reservePrice: r.reservePrice } : {}) } });
      toast(`أُدرجت السيارة كلوت رقم ${lot.lot_no}`, 'ok');
      location.hash = `#/lots/${lot.id}`;
    } catch (e) { toast(e.message, 'err'); }
  });

  const body = $('[data-tabbody]', el);
  const showTab = (k) => {
    $$('[data-tab]', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    render(body, TAB[k](v));
    if (k === 'costs') bindCosts(body, v, () => vehicleDetailView(el, { params, setTitle }));
  };
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  showTab('specs');
}

const mini = (k, v) => html`<div style="background:var(--surface-2);border-radius:10px;padding:8px"><div class="faint">${k}</div><b style="font-size:13px">${v}</b></div>`;

function routeBar(s) {
  const pct = { BOOKED: 4, LOADING: 10, DEPARTED: 25, IN_TRANSIT: 55, TRANSSHIPMENT: 60, ARRIVED: 92, DISCHARGED: 100, CLOSED: 100 }[s.status] ?? 0;
  return html`<div class="route"><div class="port"><b>${s.pol}</b><span class="faint">${fmt.date(s.atd || s.etd)}</span></div>
    <div class="line"><span style="width:${pct}%"></span><div class="ship-ico" style="inset-inline-start:${pct}%">${icon('ship')}</div></div>
    <div class="port" style="text-align:end"><b>${s.pod}</b><span class="faint">${s.ata ? fmt.date(s.ata) : `متوقع ${fmt.date(s.eta)}`}</span></div></div>`;
}

const spec = (k, v) => html`<div><dt>${k}</dt><dd>${v ?? '—'}</dd></div>`;
const TAB = {
  specs: (v) => html`<dl class="specs" style="margin:0">
    ${spec('سنة الصنع', v.year)}${spec('الماركة / الطراز', `${v.make} ${v.model}`)}${spec('الفئة', v.trim)}${spec('نوع الهيكل', v.body_style)}
    ${spec('اللون الخارجي', LABELS.color[v.exterior_color] || v.exterior_color)}${spec('اللون الداخلي', LABELS.color[v.interior_color] || v.interior_color)}
    ${spec('المحرك', v.engine)}${spec('الأسطوانات', v.cylinders)}${spec('الوقود', v.fuel_type)}${spec('ناقل الحركة', v.transmission)}${spec('الدفع', v.drive_type)}
    ${spec('قراءة العداد', fmt.odo(v.odometer, v.odometer_unit))}${spec('حالة العداد', v.odometer_brand)}${spec('نوع الملكية', LABELS.title[v.title_type])}
    ${spec('ولاية الملكية', v.title_state)}${spec('الضرر الرئيسي', v.primary_damage)}${spec('الضرر الثانوي', v.secondary_damage)}
    ${spec('المفاتيح', v.has_keys == null ? '—' : v.has_keys ? 'متوفرة' : 'غير متوفرة')}${spec('تعمل وتسير', v.run_and_drive == null ? '—' : v.run_and_drive ? 'نعم' : 'لا')}
    ${spec('ميناء الوصول', v.destination_port)}
  </dl>
  ${v.inspections.length ? html`<h4>تقارير الفحص</h4>${v.inspections.map((i) => html`<div class="alert" style="margin-bottom:8px"><b>${i.stage}</b> · تقييم ${i.grade} · ${fmt.date(i.inspected_at)}<br>${i.findings.map((f) => `${f.part}: ${f.issue}`).join(' — ')}</div>`)}` : ''}`,

  track: (v) => html`<div class="stack">
    ${v.shipment ? html`<div><h4 style="margin-top:0">الشحن البحري</h4><dl class="specs">
      ${spec('رقم الشحنة', v.shipment.shipment_no)}${spec('رقم الحجز', v.shipment.booking_no)}${spec('بوليصة الشحن', v.shipment.bill_of_lading)}
      ${spec('الحاوية', raw(`<span class="mono">${v.shipment.container_no}</span>`))}${spec('الخط الملاحي', v.shipment.carrier)}${spec('السفينة / الرحلة', `${v.shipment.vessel_name || '—'} / ${v.shipment.voyage_no || '—'}`)}
      ${spec('المغادرة', fmt.date(v.shipment.atd || v.shipment.etd))}${spec('الوصول', v.shipment.ata ? fmt.date(v.shipment.ata) : `متوقع ${fmt.date(v.shipment.eta)}`)}${spec('موضعها في الحاوية', v.shipment.position)}
    </dl>
    <ul class="hist" style="margin-top:10px">${(v.shipment.events || []).map((e) => html`<li><span class="faint">${fmt.dt(e.occurred_at)}</span><span><b>${e.event_code}</b> — ${e.description} · ${e.location || ''}</span></li>`)}</ul></div>`
      : html`<div class="empty">لم تُحمَّل في حاوية بعد</div>`}
    ${v.customs ? html`<div><h4>الجمارك</h4><dl class="specs">
      ${spec('الحالة', LABELS.customs[v.customs.status])}${spec('رقم البيان', v.customs.declaration_no)}${spec('المنفذ', v.customs.port)}${spec('المخلص', v.customs.broker)}
      ${spec('القيمة المقدرة', fmt.lyd(v.customs.assessed_value_lyd))}${spec('الرسم', fmt.lyd(v.customs.duty_amount_lyd))}${spec('تاريخ التقديم', fmt.date(v.customs.submitted_at))}${spec('تاريخ الإفراج', fmt.date(v.customs.released_at))}
    </dl></div>` : ''}
    ${v.transports.length ? html`<div><h4>النقل البري</h4>${v.transports.map((t) => html`<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--border)"><span>${t.from_location} ← ${t.to_location} · ${t.vendor || ''}</span><span class="badge">${t.status}</span></div>`)}</div>` : ''}
  </div>`,

  costs: (v) => {
    const s = v.costs.summary;
    const stages = Object.keys(LABELS.stage);
    const max = Math.max(1, ...stages.map((k) => Number(s[`${k.toLowerCase()}_lyd`] || 0)));
    return html`<div class="stack">
      <div class="row" style="justify-content:space-between"><div><span class="muted">إجمالي التكلفة الواصلة</span><div style="font-size:24px;font-weight:800" class="num">${fmt.lyd(s.total_cost_lyd, true)}</div>
        ${Number(s.estimated_part_lyd) ? html`<span class="faint">منها ${fmt.lyd(s.estimated_part_lyd)} تقديري</span>` : ''}</div>
        ${can('ADMIN', 'ACCOUNTANT', 'OPERATIONS') ? html`<button class="btn btn-primary" data-addcost>${icon('plus')} إضافة تكلفة</button>` : ''}</div>
      <div>${stages.map((k) => {
        const val = Number(s[`${k.toLowerCase()}_lyd`] || 0);
        return html`<div class="cost-stage"><span>${LABELS.stage[k]}</span><div class="progress"><span style="width:${(val / max) * 100}%;background:${STAGE_COLORS[k]}"></span></div><b class="num" style="text-align:end">${fmt.lyd(val)}</b></div>`;
      })}</div>
      ${s.sale_price_lyd ? html`<div class="alert"><b>سعر البيع:</b> ${fmt.lyd(s.sale_price_lyd)} · <b>الهامش:</b> <span class="${Number(s.margin_lyd) >= 0 ? 'pos' : 'neg'}">${fmt.lyd(s.margin_lyd)} (${((Number(s.margin_lyd) / Number(s.total_cost_lyd)) * 100).toFixed(1)}%)</span></div>` : ''}
      <div class="table-wrap"><table class="t"><thead><tr><th>البند والتاريخ</th><th>الوصف والمورد</th><th class="n">المبلغ الأصلي</th><th class="n">بالدينار</th><th></th></tr></thead>
        <tbody>${v.costs.items.map((c) => html`<tr>
          <td><span class="badge" style="color:${STAGE_COLORS[c.stage]}"><span class="dot"></span><span style="color:var(--text)">${c.category}</span></span><div class="faint">${fmt.date(c.incurred_at)}</div></td>
          <td class="wrap">${c.description || ''} ${c.status === 'ESTIMATED' ? html`<span class="badge" style="color:var(--accent)">تقديري</span>` : ''} ${c.is_shared ? html`<span class="faint">(مشتركة)</span>` : ''}${c.vendor ? html`<div class="faint">${c.vendor}</div>` : ''}</td>
          <td class="n">${fmt.money(c.amount, c.currency)}${c.currency === 'LYD' ? '' : html`<div class="faint">× ${Number(c.fx_rate_to_lyd).toFixed(4)}</div>`}</td>
          <td class="n"><b>${fmt.lyd(c.amount_lyd, true)}</b>${c.is_paid ? '' : html`<div><span class="badge" style="color:var(--danger)">غير مسدد</span></div>`}</td>
          <td>${can('ADMIN', 'ACCOUNTANT') && !c.is_shared ? html`<button class="btn btn-sm btn-ghost btn-danger" data-void="${c.id}">إلغاء</button>` : ''}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="3">الإجمالي</td><td class="n">${fmt.lyd(s.total_cost_lyd, true)}</td><td></td></tr></tfoot></table></div>
    </div>`;
  },

  source: (v) => html`${v.listings.map((l) => html`<dl class="specs">
    ${spec('المصدر', l.source_name)}${spec('رقم اللوت', l.lot_number)}${spec('الساحة', `${l.yard_name || ''} (${l.yard_state || ''})`)}${spec('تاريخ البيع', fmt.date(l.sale_date))}
    ${spec('حالة البيع', l.sale_status)}${spec('القيمة الفعلية ACV', fmt.money(l.acv_usd, 'USD'))}${spec('تقدير الإصلاح', fmt.money(l.repair_estimate_usd, 'USD'))}
    ${spec('سعر الشراء', fmt.money(l.purchase_price_usd, 'USD'))}${spec('آخر مزامنة', fmt.dt(l.last_synced_at))}
    ${spec('الرابط', l.listing_url ? raw(`<a href="${encodeURI(l.listing_url)}" target="_blank" rel="noopener noreferrer">فتح في ${l.source}</a>`) : '—')}
  </dl>`)}`,

  history: (v) => html`<ul class="hist">${[...v.history].reverse().map((h) => html`<li><span class="faint">${fmt.dt(h.occurred_at)}</span>
    <span>${h.from_status ? html`${statusBadge(h.from_status)} ← ` : ''}${statusBadge(h.to_status)} <span class="faint">${h.source === 'SYNC' ? 'مزامنة آلية' : h.source === 'SYSTEM' ? 'النظام' : h.changed_by || ''}</span>${h.reason ? html`<div class="muted">${h.reason}</div>` : ''}</span></li>`)}</ul>`,
};

function bindCosts(body, v, reload) {
  $('[data-addcost]', body)?.addEventListener('click', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await modal({
      title: 'إضافة تكلفة', submitLabel: 'حفظ التكلفة', body: html`
        <label class="field">البند<select class="input" name="categoryCode" required>${Object.entries(LABELS.stage).map(([stage, l]) => html`<optgroup label="${l}">${state.meta.costCategories.filter((c) => c.stage === stage).map((c) => html`<option value="${c.code}">${c.name_ar}</option>`)}</optgroup>`)}</select></label>
        <div class="grid g3"><label class="field">المبلغ<input class="input num" name="amount" required inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?"></label>
        <label class="field">العملة<select class="input" name="currency"><option>LYD</option><option>USD</option><option>EUR</option></select></label>
        <label class="field">التاريخ<input class="input" type="date" name="incurredAt" value="${today}" required></label></div>
        <label class="field">المورد<select class="input" name="vendorId"><option value="">—</option>${state.meta.vendors.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></label>
        <label class="field">الوصف<input class="input" name="description" maxlength="300"></label>
        <div class="grid g3"><label class="field">رقم الفاتورة<input class="input" name="invoiceRef" maxlength="80"></label>
        <label class="field">النوع<select class="input" name="status"><option value="ACTUAL">فعلي</option><option value="ESTIMATED">تقديري</option></select></label>
        <label class="field">مسدد؟<select class="input" name="isPaid"><option value="false">لا</option><option value="true">نعم</option></select></label></div>
        <p class="faint" style="margin:0">سعر الصرف يُؤخذ تلقائيًا من آخر سعر مسجل في تاريخ التكلفة ويُحفظ معها.</p>` });
    if (!r) return;
    try {
      const body = { ...r, isPaid: r.isPaid === 'true' };
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      await api(`/vehicles/${v.id}/costs`, { method: 'POST', body });
      toast('تمت إضافة التكلفة', 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-void]', body).forEach((b) => b.addEventListener('click', async () => {
    const r = await modal({ title: 'إلغاء بند تكلفة', submitLabel: 'إلغاء البند', danger: true, body: html`<p class="muted" style="margin:0">لا يُحذف البند فعليًا؛ يُعلَّم ملغى مع السبب ويبقى في سجل التدقيق.</p><label class="field">سبب الإلغاء<input class="input" name="reason" required minlength="3"></label>` });
    if (!r) return;
    try { await api(`/costs/${b.dataset.void}/void`, { method: 'POST', body: { reason: r.reason } }); toast('تم إلغاء البند', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
  }));
}

// ======================================================================= المقارنة
export async function compareView(el, { query }) {
  const ids = String(query.ids || '').split(',').filter(Boolean);
  if (ids.length < 2) return render(el, html`<div class="card empty">اختر سيارتين على الأقل من قائمة السيارات للمقارنة</div>`);
  const { items } = await api(`/vehicles/compare?ids=${ids.join(',')}`);
  const cols = `200px repeat(${items.length}, minmax(200px, 1fr))`;
  const rows = [
    ['السنة', (v) => v.year, 'max'], ['الماركة والطراز', (v) => `${v.make} ${v.model} ${v.trim || ''}`], ['الحالة', (v) => statusBadge(v.status)],
    ['العداد', (v) => fmt.odo(v.odometer, v.odometer_unit), 'min', (v) => v.odometer], ['المحرك', (v) => v.engine], ['الدفع', (v) => v.drive_type],
    ['الملكية', (v) => LABELS.title[v.title_type]], ['الضرر الرئيسي', (v) => v.primary_damage], ['الضرر الثانوي', (v) => v.secondary_damage || '—'],
    ['المفاتيح', (v) => (v.has_keys ? 'متوفرة' : 'لا')], ['تعمل وتسير', (v) => (v.run_and_drive ? 'نعم' : 'لا')], ['التقييم', (v) => v.condition_grade || '—', 'max', (v) => Number(v.condition_grade || 0)],
    ['المصدر', (v) => (v.listings[0] ? `${v.listings[0].source} ${v.listings[0].lot_number}` : '—')],
    ...(items[0].costs ? [['التكلفة الواصلة', (v) => fmt.lyd(v.costs.summary.total_cost_lyd), 'min', (v) => Number(v.costs.summary.total_cost_lyd)],
      ['منها الشراء', (v) => fmt.lyd(v.costs.summary.purchase_lyd)], ['منها الجمارك', (v) => fmt.lyd(v.costs.summary.customs_lyd)]] : []),
  ];
  const textOf = (x) => (x && x.s !== undefined ? x.s : String(x));
  render(el, html`<div class="compare" style="grid-template-columns:${cols}">
    <div class="c-cell c-label">الصورة</div>${items.map((v, i) => html`<div class="c-cell"><img src="${imgUrl(v.id, v.images[0]?.id)}" alt="" data-img="${i}"><a href="#/vehicles/${v.id}"><b>${v.stock_no}</b></a></div>`)}
    ${rows.map(([label, get, best, numOf]) => {
      const vals = items.map(get);
      const differs = new Set(vals.map(textOf)).size > 1;
      let bestIdx = -1;
      if (best && differs) {
        const nums = items.map(numOf || ((v) => Number(get(v))));
        const target = best === 'max' ? Math.max(...nums) : Math.min(...nums);
        bestIdx = nums.indexOf(target);
      }
      return html`<div class="c-cell c-label">${label}</div>${vals.map((val, i) => html`<div class="c-cell ${differs ? 'diff' : ''} ${i === bestIdx ? 'best' : ''}">${val}</div>`)}`;
    })}
    <div class="c-cell c-label">الصور</div>${items.map((v, i) => html`<div class="c-cell"><button class="btn btn-sm" data-gal="${i}">${icon('zoom')} عرض ${v.images.length} صور</button></div>`)}
  </div><p class="faint">الخلايا المظللة تختلف بين السيارات، والأخضر هو الأفضل في البند.</p>`);
  const open = (i) => openLightbox(items[i].images, (im) => imgUrl(items[i].id, im.id), 0, `${items[i].year} ${items[i].make} ${items[i].model}`);
  $$('[data-gal]', el).forEach((b) => b.addEventListener('click', () => open(Number(b.dataset.gal))));
  $$('[data-img]', el).forEach((b) => b.addEventListener('click', () => open(Number(b.dataset.img))));
}
