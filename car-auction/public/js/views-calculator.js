// حاسبة التكلفة: من سعر المزايدة في أمريكا إلى التكلفة الواصلة في ليبيا، مع عرض سعر قابل للطباعة.
// تُفتح فارغة، أو من لوت في «مزادات أمريكا» (#/calculator?lot=<id>) فتُعبّأ ببياناته.
import { html, render, $, $$, api, fmt, toast } from './core.js';
import { estimate, loadSettings, saveSettings, defaultSettings, YARDS, findYard, isCleanTitle, PORTS, SHIP_TYPES, CUSTOMS, defaultCustomsIdx } from './calc.js';

const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const lyd = (v) => `${Math.round(v).toLocaleString('en-US')} د.ل`;
const seg = (name, opts, cur) => html`<div class="seg" role="radiogroup">${opts.map(([v, l]) => html`<label><input type="radio" name="${name}" value="${v}" ${v === cur ? 'checked' : ''}><span>${l}</span></label>`)}</div>`;

/** publicMode: الصفحة العامة (/calc) — بلا تسجيل دخول، والإعدادات ثابتة على أسعار الشركة لا يغيّرها الزائر */
export async function calculatorView(el, { query = {}, setTitle = () => {}, publicMode = false }) {
  const s = publicMode ? defaultSettings() : loadSettings();
  const st = { platform: 'COPART', clean: false, live: false, bid: '', yard: null, towing: '', port: 'NJ', shipType: 'quad', customsIdx: 0,
    sublot: '', titleIssue: '', customer: '', title: '' };
  if (query.lot && !publicMode) {
    try {
      const w = await api(`/watchlist/${query.lot}`);
      st.platform = w.source === 'COPART' ? 'COPART' : 'IAAI';
      st.clean = isCleanTitle(w.title_doc);
      st.bid = String(Number(w.max_bid_usd || w.current_bid_usd || '') || '');
      st.yard = findYard(st.platform, { usState: w.us_state, city: w.city, branch: w.branch });
      if (st.yard) st.port = st.yard.port;
      st.customsIdx = defaultCustomsIdx(w.year);
      st.title = `${[w.year, w.make, w.model, w.trim].filter(Boolean).join(' ')} — ${w.source} ${w.lot_number}`;
      setTitle('حاسبة التكلفة', st.title);
    } catch (e) { toast(e.message, 'err'); }
  }

  render(el, html`
    <div class="calc">
      <div class="calc-in">
        <div class="card card-b">
          <h3 class="calc-h">1 · المزاد والسعر</h3>
          <div class="grid g2">
            <div class="field">المنصة${seg('platform', [['COPART', 'Copart'], ['IAAI', 'IAAI']], st.platform)}</div>
            <div class="field">نوع الملكية${seg('clean', [['0', 'بأضرار (Non-Clean)'], ['1', 'نظيفة (Clean)']], st.clean ? '1' : '0')}</div>
          </div>
          <div class="grid g2">
            <div class="field">نوع المزايدة${seg('live', [['0', 'مسبقة (Pre-bid)'], ['1', 'مباشرة (Live)']], st.live ? '1' : '0')}</div>
            <label class="field">سعر المزايدة ($)<input class="input num calc-bid" name="bid" inputmode="decimal" placeholder="0" value="${st.bid}"></label>
          </div>
        </div>
        <div class="card card-b">
          <h3 class="calc-h">2 · الساحة والنقل الداخلي</h3>
          <label class="field">ابحث عن الساحة (المدينة، الاسم أو الولاية)<input class="input" name="yardq" autocomplete="off" placeholder="مثلًا: Lubbock أو TX" value="${st.yard ? `${st.yard.name} — ${st.yard.city}, ${st.yard.state}` : ''}"></label>
          <div class="calc-yards" data-yards></div>
          <label class="field">أو اكتب سعر النقل الداخلي ($)<input class="input num" name="towing" inputmode="decimal" placeholder="${st.yard ? st.yard.towing : '0'}"></label>
        </div>
        <div class="card card-b">
          <h3 class="calc-h">3 · الشحن البحري والجمرك</h3>
          <label class="field">ميناء الشحن<select class="input" name="port">${Object.entries(PORTS).map(([k, p]) => html`<option value="${k}" ${k === st.port ? 'selected' : ''}>${p.label}</option>`)}</select></label>
          <div class="field">نوع الحاوية<div data-ships></div></div>
          <label class="calc-check"><input type="checkbox" name="customsOn"> <span><b>إضافة الجمرك</b> <span class="faint">— اختياري؛ بدونه الفاتورة بدون جمرك</span></span></label>
          <div class="grid g2" data-customs hidden>
            <label class="field">نوع الجمرك<select class="input" name="customs">${CUSTOMS.map(([l, v], i) => html`<option value="${i}" ${i === st.customsIdx ? 'selected' : ''}>${l} — ${v.toLocaleString('en-US')}</option>`)}<option value="custom">مبلغ آخر</option></select></label>
            <label class="field">مبلغ الجمرك (د.ل) — تقدر تعدّله<input class="input num" name="customsLYD" inputmode="decimal" value="${CUSTOMS[st.customsIdx][1]}"></label>
          </div>
          <div class="grid g2">
            <label class="field">سابلت ($) — اختياري<input class="input num" name="sublot" inputmode="decimal" placeholder="0"></label>
            <label class="field">إصدار تايتل ($) — اختياري<input class="input num" name="titleIssue" inputmode="decimal" placeholder="0"></label>
          </div>
        </div>
        <details class="card card-b" ${publicMode ? 'hidden' : ''}>
          <summary><b>الإعدادات</b> <span class="faint">— سعر الصرف، فرق الحوالة، أسعار الشحن (تُحفظ في متصفحك)</span></summary>
          <div class="grid g3" style="margin-top:10px">
            <label class="field">سعر الصرف (د.ل للدولار)<input class="input num" name="exchange" inputmode="decimal" value="${s.exchange}"></label>
            <label class="field">فرق الحوالة (%)<input class="input num" name="transferPct" inputmode="decimal" value="${s.transferPct}"></label>
            <label class="field">الواير ($)<input class="input num" name="wire" inputmode="decimal" value="${s.wire}"></label>
          </div>
          <div class="table-wrap"><table class="t"><thead><tr><th>الميناء</th>${Object.values(SHIP_TYPES).map((l) => html`<th class="n">${l}</th>`)}</tr></thead>
            <tbody>${Object.entries(PORTS).map(([k, p]) => html`<tr><td>${p.label}</td>${Object.keys(SHIP_TYPES).map((t) => html`<td class="n"><input class="input num" style="width:90px" data-ship="${k}:${t}" inputmode="decimal" value="${s.ports[k]?.[t] ?? p[t]}"></td>`)}</tr>`)}</tbody></table></div>
          <button type="button" class="btn btn-sm" data-reset>إرجاع الأسعار الافتراضية</button>
        </details>
        <div class="card card-b">
          <h3 class="calc-h">عرض السعر (اختياري)</h3>
          <div class="grid g2"><label class="field">اسم الزبون<input class="input" name="customer" maxlength="80"></label>
            <label class="field">السيارة / رقم اللوت<input class="input" name="title" maxlength="120" value="${st.title}"></label></div>
        </div>
      </div>
      <div class="calc-out" data-out></div>
    </div>`);

  const f = (n) => $(`[name="${n}"]`, el);
  const radio = (n) => $(`[name="${n}"]:checked`, el)?.value;

  const drawShips = () => {
    const rates = s.ports[f('port').value] || PORTS[f('port').value];
    render($('[data-ships]', el), seg('shipType', Object.entries(SHIP_TYPES).map(([k, l]) => [k, `${l.split(' ')[0]} · $${rates[k]}`]), st.shipType));
  };

  const drawYards = () => {
    const q = f('yardq').value.trim().toLowerCase();
    const box = $('[data-yards]', el);
    if (!q || (st.yard && f('yardq').value === `${st.yard.name} — ${st.yard.city}, ${st.yard.state}`)) { render(box, ''); return; }
    const list = YARDS[radio('platform')].filter((y) => `${y.name} ${y.city} ${y.state}`.toLowerCase().includes(q)).slice(0, 8);
    render(box, list.length ? html`${list.map((y, i) => html`<button type="button" data-yard="${i}"><b>${y.name}</b> <span class="faint">${y.city}, ${y.state}</span><span class="num">$${y.towing} → ${y.port}</span></button>`)}`
      : html`<div class="faint" style="padding:8px">لا توجد ساحة بهذا الاسم — اكتب سعر النقل يدويًا</div>`);
    $$('[data-yard]', box).forEach((b) => b.addEventListener('click', () => {
      st.yard = list[Number(b.dataset.yard)];
      f('yardq').value = `${st.yard.name} — ${st.yard.city}, ${st.yard.state}`;
      f('towing').value = ''; f('towing').placeholder = st.yard.towing;
      f('port').value = st.yard.port; st.port = st.yard.port;
      drawShips(); drawYards(); compute();
    }));
  };

  const compute = () => {
    st.shipType = radio('shipType') || st.shipType;
    const towing = f('towing').value !== '' ? Number(f('towing').value) : st.yard?.towing || 0;
    const e = estimate({ platform: radio('platform'), clean: radio('clean') === '1', live: radio('live') === '1', bid: f('bid').value,
      towing, port: f('port').value, shipType: st.shipType, customsLYD: f('customsOn').checked ? f('customsLYD').value : 0, sublot: f('sublot').value, titleIssue: f('titleIssue').value }, s);
    const withCustoms = f('customsOn').checked;
    const out = $('[data-out]', el);
    if (!e.bid) { render(out, html`<div class="card card-b calc-empty"><div style="font-size:40px">🧮</div>اكتب سعر المزايدة باش تطلع التكلفة الكاملة</div>`); return; }
    const row = (l, v, cls = '') => html`<div class="calc-row ${cls}"><span>${l}</span><b class="num">${v}</b></div>`;
    const copart = radio('platform') === 'COPART';
    const customer = f('customer').value.trim(), title = f('title').value.trim();
    render(out, html`<div class="card calc-res">
      <div class="calc-total">
        <img src="/brand/ggm-logo-official.png" alt="Golden Gate Motors" class="calc-logo">
        <div class="faint" style="color:#c6d3e3">التكلفة حتى ليبيا</div>
        <div class="calc-big">${lyd(e.totalLYD)}</div>
        <div class="calc-badge ${withCustoms ? 'on' : ''}">${withCustoms ? `شامل الجمرك ${lyd(e.customsLYD)}` : 'الفاتورة بدون جمرك'}</div>
        <div style="color:#c6d3e3">${usd(e.totalUSD)}${withCustoms ? ` + جمرك ${lyd(e.customsLYD)}` : ''} · صرف ${e.exchange}</div>
      </div>
      <div class="card-b">
        ${customer || title ? html`<div class="calc-meta">${title ? html`<div><span class="faint">السيارة:</span> <b>${title}</b></div>` : ''}${customer ? html`<div><span class="faint">الزبون:</span> <b>${customer}</b></div>` : ''}
          <div class="faint">${fmt.date(new Date())}</div></div>` : ''}
        <div class="calc-stage">يُدفع عند الشراء</div>
        ${row('سعر المزايدة', usd(e.bid))}
        ${row(`عمولة المشتري (${copart ? `Copart ${radio('clean') === '1' ? 'Clean' : 'Non-Clean'}` : 'IAAI'})`, usd(e.buyerFee))}
        ${row(`رسوم المزايدة (${radio('live') === '1' ? 'Live' : 'Pre-bid'})`, usd(e.bidFee))}
        ${row(copart ? 'رسوم البوابة' : 'رسوم الخدمة', usd(e.gateFee))}
        ${row('رسوم بيئية', usd(e.envFee))}${row('رسوم التايتل', usd(e.titleFee))}
        ${e.brokerFee ? row('رسوم الوسيط', usd(e.brokerFee)) : ''}
        ${row('فاتورة المزاد', usd(e.auctionBill), 'sub')}
        ${row('عمولة المزايدة', usd(e.commission))}${row('الواير', usd(e.wire))}
        ${row(`فرق حوالة الفاتورة (${s.transferPct}%)`, usd(e.invoiceTransfer))}
        ${row('المجموع الآن', usd(e.payNow), 'tot')}
        <div class="calc-stage">يُدفع عند وصول السيارة لميناء الوسيط</div>
        ${e.towing ? row(`النقل الداخلي${st.yard && f('towing').value === '' ? ` (${st.yard.name})` : ''}`, usd(e.towing)) : row('النقل الداخلي', html`<span class="neg">لم يُحدد</span>`)}
        ${row(`الشحن البحري (${(s.ports[f('port').value] || PORTS[f('port').value]).label} · ${SHIP_TYPES[st.shipType].split(' ')[0]})`, usd(e.shipping))}
        ${e.sublot ? row('سابلت', usd(e.sublot)) : ''}${e.titleIssue ? row('إصدار تايتل', usd(e.titleIssue)) : ''}
        ${row(`فرق حوالة الشحن (${s.transferPct}%)`, usd(e.shipTransfer))}
        ${withCustoms ? row('الجمرك', lyd(e.customsLYD)) : row('الجمرك', html`<span class="faint">غير محسوب</span>`)}
        ${row(`المجموع عند الوصول${withCustoms ? '' : ' (بدون جمرك)'}`, lyd(e.onArrivalLYD), 'tot')}
        <div class="row no-print" style="gap:8px;margin-top:12px"><button type="button" class="btn btn-primary" data-print>طباعة عرض السعر / PDF</button></div>
        ${withCustoms ? '' : html`<p style="font-size:12.5px;margin:10px 0 0"><b>ملاحظة:</b> هذه الفاتورة <b>بدون جمرك</b>؛ الجمرك يُدفع منفصلًا في ليبيا.</p>`}
        <p class="faint" style="font-size:12px;margin:10px 0 0">تقدير حسب جداول رسوم المزادات وأسعار الوسيط الحالية؛ قد يختلف المبلغ النهائي.</p>
      </div></div>`);
    $('[data-print]', out).addEventListener('click', () => window.print());
  };

  const saveAndCompute = () => {
    s.exchange = Number(f('exchange').value) || s.exchange;
    s.transferPct = Number(f('transferPct').value) || 0;
    s.wire = Number(f('wire').value) || 0;
    $$('[data-ship]', el).forEach((i) => { const [k, t] = i.dataset.ship.split(':'); s.ports[k] = { ...s.ports[k], [t]: Number(i.value) || 0 }; });
    if (!publicMode) saveSettings(s);
    drawShips(); compute();
  };

  el.addEventListener('input', (e) => {
    if (e.target.name === 'yardq') { st.yard = null; f('towing').placeholder = '0'; drawYards(); compute(); return; }
    if (e.target.matches('[data-ship], [name=exchange], [name=transferPct], [name=wire]')) return saveAndCompute();
    if (e.target.name === 'customsLYD') f('customs').value = CUSTOMS.findIndex(([, v]) => v === Number(e.target.value)) >= 0 ? String(CUSTOMS.findIndex(([, v]) => v === Number(e.target.value))) : 'custom';
    compute();
  });
  el.addEventListener('change', (e) => {
    if (e.target.name === 'customsOn') $('[data-customs]', el).hidden = !e.target.checked;
    if (e.target.name === 'customs' && e.target.value !== 'custom') f('customsLYD').value = CUSTOMS[e.target.value][1];
    if (e.target.name === 'platform') { st.yard = null; f('yardq').value = ''; f('towing').placeholder = '0'; drawYards(); }
    if (e.target.name === 'port') drawShips();
    compute();
  });
  $('[data-reset]', el).addEventListener('click', () => {
    s.ports = structuredClone(PORTS); if (!publicMode) saveSettings(s);
    $$('[data-ship]', el).forEach((i) => { const [k, t] = i.dataset.ship.split(':'); i.value = PORTS[k][t]; });
    drawShips(); compute();
  });

  drawShips(); compute();
  if (!query.lot) f('bid').focus();
  return () => {};
}
