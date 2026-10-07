import { html, render, $, $$, api, fmt, LABELS, state, imgUrl, toast, icon } from './core.js';
import { galleryTemplate, mountGallery } from './gallery.js';

// فرق الساعة بين المتصفح والخادم: العد التنازلي يعتمد وقت الخادم لا وقت جهاز المستخدم
let clockSkew = 0;

function remaining(endsAt) {
  return new Date(endsAt).getTime() - (Date.now() + clockSkew);
}
function fmtCountdown(ms) {
  if (ms <= 0) return 'انتهى';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function tickCountdowns(root) {
  $$('[data-ends]', root).forEach((c) => {
    const ms = remaining(c.dataset.ends);
    c.textContent = fmtCountdown(ms);
    c.classList.toggle('urgent', ms > 0 && ms < 120_000);
  });
}

// ======================================================================= قائمة المزادات
export async function auctionsView(el) {
  const { events } = await api('/auctions');
  const load = async () => {
    const fresh = await api('/auctions');
    draw(fresh.events);
  };
  const draw = (evs) => {
    render(el, html`${evs.map((e) => html`<section class="card" style="margin-bottom:18px">
      <div class="card-h">${e.status === 'LIVE' ? html`<span class="live-dot" aria-hidden="true"></span>` : ''}<h2>${e.title}</h2>
        <span class="badge">${{ LIVE: 'مباشر الآن', SCHEDULED: 'مجدول', CLOSED: 'منتهٍ', CANCELLED: 'ملغى' }[e.status]}</span>
        <span style="flex:1"></span><span class="faint">${fmt.dt(e.starts_at)} ← ${fmt.dt(e.ends_at)} · تأمين ${fmt.lyd(e.deposit_required_lyd)}</span></div>
      <div class="card-b">${e.lots.length ? html`<div class="vgrid">${e.lots.map(lotCard)}</div>` : html`<div class="empty">لم تُدرج سيارات بعد</div>`}</div>
    </section>`)}`);
    tickCountdowns(el);
  };
  draw(events);
  const timer = setInterval(() => tickCountdowns(el), 1000);
  // تحديث فوري لأي مزايدة على أي لوت
  const es = new EventSource('/api/auctions/stream');
  let pending = null;
  es.addEventListener('bid', () => { clearTimeout(pending); pending = setTimeout(load, 300); });
  es.addEventListener('closed', () => load());
  return () => { clearInterval(timer); es.close(); };
}

function lotCard(l) {
  const open = l.status === 'OPEN';
  return html`<article class="card vcard lot-card">
    <a class="img" href="#/lots/${l.id}">${l.image_id ? html`<img src="${imgUrl(l.vehicle_id, l.image_id)}" alt="" loading="lazy">` : ''}
      <span class="badge">لوت ${l.lot_no}</span></a>
    <div class="body">
      <h3><a href="#/lots/${l.id}" style="color:inherit">${l.year} ${l.make} ${l.model}</a></h3>
      <div class="meta"><span>${fmt.odo(l.odometer, l.odometer_unit)}</span><span>${LABELS.title[l.title_type]}</span><span>${l.primary_damage || ''}</span></div>
      <div class="row" style="justify-content:space-between;margin-top:4px">
        <div><div class="faint">${l.bid_count ? `السعر الحالي · ${l.bid_count} مزايدة` : 'سعر الافتتاح'}</div><div class="price num">${fmt.lyd(l.current_price ?? l.starting_price)}</div></div>
        ${open ? html`<div style="text-align:end"><div class="faint">${icon('clock')} متبقٍ</div><div class="countdown" data-ends="${l.ends_at}"></div></div>`
          : html`<span class="badge">${{ CLOSED_SOLD: 'بيعت', CLOSED_UNSOLD: 'لم تُبع', PENDING: 'لم يبدأ', CANCELLED: 'ملغى' }[l.status]}</span>`}
      </div>
      <div class="foot">
        ${l.is_leading ? html`<span class="badge" style="color:var(--success)"><span class="dot"></span>أنت الأعلى</span>` : html`<span class="faint">${l.reserve_met ? 'تجاوز الحد الأدنى' : 'لم يبلغ الحد الأدنى'}</span>`}
        ${open ? html`<a class="btn btn-sm btn-accent" href="#/lots/${l.id}">زايد الآن</a>` : ''}
      </div>
    </div>
  </article>`;
}

// ======================================================================= صفحة اللوت والمزايدة الحية
export async function lotView(el, { params, setTitle }) {
  let lot = await api(`/lots/${params.id}`);
  clockSkew = new Date(lot.server_time).getTime() - Date.now();
  const v = await api(`/vehicles/${lot.vehicle_id}`);
  const title = `${v.year} ${v.make} ${v.model} ${v.trim || ''}`.trim();
  setTitle(`لوت ${lot.lot_no} — ${title}`, lot.event_title);
  const isBidder = state.user.role === 'BIDDER';
  const canBid = ['BIDDER', 'SALES', 'ADMIN'].includes(state.user.role);
  let customers = [];
  if (!isBidder && canBid) customers = (await api('/customers')).items;
  const urlOf = (im) => imgUrl(v.id, im.id);

  render(el, html`<div class="detail">
    <div class="stack">
      ${galleryTemplate(v.images, urlOf, title)}
      <div class="card">
        <div class="card-h"><h3>المواصفات</h3></div>
        <div class="card-b"><dl class="specs" style="margin:0">
          ${[['VIN', v.vin], ['العداد', fmt.odo(v.odometer, v.odometer_unit)], ['المحرك', v.engine], ['الدفع', v.drive_type], ['الملكية', LABELS.title[v.title_type]],
            ['الضرر الرئيسي', v.primary_damage], ['الضرر الثانوي', v.secondary_damage || '—'], ['المفاتيح', v.has_keys ? 'متوفرة' : 'لا'], ['تعمل وتسير', v.run_and_drive ? 'نعم' : 'لا'],
            ['اللون', LABELS.color[v.exterior_color] || v.exterior_color], ['التقييم', v.condition_grade ? `${v.condition_grade} / 5` : '—'], ['المصدر', v.listings[0] ? `${v.listings[0].source} ${v.listings[0].lot_number}` : '—']]
            .map(([k, val]) => html`<div><dt>${k}</dt><dd>${val ?? '—'}</dd></div>`)}
        </dl></div>
      </div>
    </div>
    <aside class="stack bid-panel">
      <div class="card card-b stack" style="gap:12px" data-panel></div>
      <div class="card"><div class="card-h"><h3>سجل المزايدات</h3><span style="flex:1"></span><span class="faint" data-live>${icon('clock')} مباشر</span></div>
        <ul class="bids-list card-b" style="padding-top:0;padding-bottom:0" data-bids></ul></div>
    </aside>
  </div>`);
  mountGallery(el, v.images, urlOf, title);

  const panel = $('[data-panel]', el);
  const drawPanel = () => {
    const open = lot.status === 'OPEN' && remaining(lot.ends_at) > 0;
    const reg = lot.registration;
    const inc = Number(lot.increment);
    const min = Number(lot.next_minimum);
    render(panel, html`
      <div class="row" style="justify-content:space-between"><span class="badge">لوت ${lot.lot_no}</span>${open ? html`<span><span class="live-dot"></span> مباشر</span>` : html`<span class="badge">انتهى</span>`}</div>
      <div><div class="faint">${lot.bid_count ? 'أعلى مزايدة' : 'سعر الافتتاح'}</div><div class="big num" data-price>${fmt.lyd(lot.current_price ?? lot.starting_price)}</div>
        <div class="faint">${lot.bid_count} مزايدة ${lot.leader_paddle ? `· القائد: مزايد #${lot.leader_paddle}` : ''} · ${lot.reserve_met ? 'تجاوز الحد الأدنى للبيع' : 'لم يبلغ الحد الأدنى للبيع بعد'}</div></div>
      <div class="status-line"><span class="muted">${icon('clock')} الوقت المتبقي</span><span class="countdown" style="font-size:22px" data-ends="${lot.ends_at}"></span></div>
      ${lot.ends_at !== lot.original_ends_at ? html`<div class="faint">مُدِّد الوقت تلقائيًا بسبب مزايدة في الدقائق الأخيرة (حماية من القنص)</div>` : ''}
      ${isBidder && lot.bid_count ? html`<div class="lead-banner ${lot.is_leading ? 'win' : 'lose'}">${lot.is_leading ? 'أنت صاحب أعلى مزايدة' : 'تم تجاوز مزايدتك — أو لم تزايد بعد'}</div>` : ''}
      ${!canBid ? '' : !open ? html`<div class="alert">المزايدة مغلقة على هذا اللوت</div>`
        : isBidder && (!reg || reg.deposit_status !== 'HELD') ? html`<div class="alert danger">يجب التسجيل في المزاد وإيداع التأمين (${fmt.lyd(lot.deposit_required_lyd)}) قبل المزايدة</div>`
        : html`<form class="stack" style="gap:10px" data-bid>
          ${!isBidder ? html`<label class="field">مزايدة نيابة عن العميل (مزاد هجين)<select class="input" name="customerId" required><option value="">اختر العميل…</option>${customers.map((c) => html`<option value="${c.id}">${c.code} — ${c.full_name}</option>`)}</select></label>` : ''}
          <div class="quick">${[1, 2, 5].map((k) => html`<button type="button" class="btn" data-quick="${min + inc * (k - 1)}"><span class="num">${fmt.n(min + inc * (k - 1))}</span><small>${k === 1 ? 'الحد الأدنى' : `+${fmt.n(inc * (k - 1))}`}</small></button>`)}</div>
          <div class="row"><input class="input num" name="amount" inputmode="numeric" pattern="\\d+" value="${min}" aria-label="مبلغ المزايدة" style="flex:1;font-size:18px;font-weight:700"><button class="btn btn-accent" style="min-width:120px">${icon('gavel')} زايد</button></div>
          <div class="faint">أقل زيادة ${fmt.lyd(inc)} · المبالغ بالدينار الليبي</div>
        </form>
        <details><summary style="cursor:pointer;font-weight:600">المزايدة الآلية (حد أقصى سري)</summary>
          <form class="stack" style="gap:8px;margin-top:8px" data-proxy>
            <p class="faint" style="margin:0">يزايد النظام عنك تلقائيًا بأقل زيادة لازمة حتى حدك الأقصى، ولا يظهر حدك لأحد.</p>
            ${lot.my_proxy ? html`<div class="alert">حدك الحالي: <b class="num">${fmt.lyd(lot.my_proxy)}</b></div>` : ''}
            <div class="row"><input class="input num" name="maxAmount" inputmode="numeric" pattern="\\d+" placeholder="مثلًا ${min + inc * 10}" style="flex:1" required><button class="btn">تفعيل</button></div>
          </form></details>`}`);
    tickCountdowns(panel);
    const form = $('[data-bid]', panel);
    if (form) {
      $$('[data-quick]', form).forEach((b) => b.addEventListener('click', () => { form.amount.value = b.dataset.quick; form.requestSubmit(); }));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const amount = form.amount.value.trim();
        const btns = $$('button', form);
        btns.forEach((b) => { b.disabled = true; });
        try {
          // مفتاح عدم التكرار: إعادة الإرسال بسبب الشبكة لا تُسجل مزايدة مرتين
          const r = await api(`/lots/${lot.id}/bids`, { method: 'POST', body: { amount, idempotencyKey: crypto.randomUUID(), ...(form.customerId ? { customerId: form.customerId.value } : {}) } });
          toast(r.outbidByProxy ? 'سُجلت مزايدتك لكن تجاوزتها مزايدة آلية لعميل آخر' : 'تم تسجيل مزايدتك — أنت الأعلى الآن', r.outbidByProxy ? '' : 'ok');
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          await refresh();
        }
      });
    }
    $('[data-proxy]', panel)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/lots/${lot.id}/proxy`, { method: 'PUT', body: { maxAmount: e.target.maxAmount.value.trim(), ...(form?.customerId ? { customerId: form.customerId.value } : {}) } });
        toast(r.leading ? 'تم تفعيل المزايدة الآلية — أنت الأعلى' : 'تم تفعيل المزايدة الآلية', 'ok');
      } catch (err) { toast(err.message, 'err'); }
      await refresh();
    });
  };

  const bidsEl = $('[data-bids]', el);
  const drawBids = (newIds = new Set()) => {
    render(bidsEl, lot.bids.length ? html`${lot.bids.map((b, i) => html`<li class="${i === 0 ? 'top' : ''} ${newIds.has(b.id) ? 'new' : ''}">
      <span>${b.mine ? html`<b>أنت</b>` : b.customer ? b.customer : `مزايد #${b.paddle ?? '—'}`} ${b.kind === 'PROXY' ? html`<span class="badge">آلية</span>` : ''}</span>
      <span class="row" style="gap:12px"><span class="faint">${fmt.dt(b.placed_at)}</span><b class="num">${fmt.lyd(b.amount)}</b></span></li>`)}` : html`<li class="empty">لا مزايدات بعد — كن الأول</li>`);
  };

  const refresh = async (newIds) => {
    lot = await api(`/lots/${params.id}`);
    clockSkew = new Date(lot.server_time).getTime() - Date.now();
    const focusedAmount = document.activeElement?.name === 'amount' || document.activeElement?.name === 'maxAmount';
    if (!focusedAmount) drawPanel();
    else { $('[data-price]', panel).textContent = fmt.lyd(lot.current_price ?? lot.starting_price); $('[data-ends]', panel).dataset.ends = lot.ends_at; }
    drawBids(newIds);
  };

  drawPanel();
  drawBids();
  const timer = setInterval(() => tickCountdowns(panel), 250);
  const es = new EventSource(`/api/lots/${lot.id}/stream`);
  es.addEventListener('bid', (m) => {
    const evt = JSON.parse(m.data);
    refresh(new Set(evt.bids.map((b) => b.id)));
  });
  es.addEventListener('closed', (m) => {
    const evt = JSON.parse(m.data);
    toast(evt.sold ? 'انتهى المزاد على هذا اللوت — تم البيع' : 'انتهى المزاد دون بلوغ الحد الأدنى');
    refresh();
  });
  es.onerror = () => { $('[data-live]', el).textContent = 'إعادة الاتصال…'; };
  es.onopen = () => { $('[data-live]', el).textContent = '● مباشر'; };
  return () => { clearInterval(timer); es.close(); };
}
