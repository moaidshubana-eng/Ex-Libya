// مزادات أمريكا: لوتات Copart/IAAI نتابعها قبل الشراء (السعر، موعد المزاد، الولاية والمدينة)، ثم «اشتريناها» تحوّلها لسيارة.
import { html, render, $, $$, api, fmt, state, toast, modal, icon } from './core.js';
import { dealFields, loadCustomers } from './views-accounts.js';
import { mountPhotos, compress } from './photos.js';
import { openLightbox } from './gallery.js';
import { estimateLot, loadSettings } from './calc.js';
import { watchVin } from './views-vehicles.js';
import { bookmarkletHref, decodeImport } from './lot-grabber.js';

/** نافذة تثبيت «زر الاستيراد من المزاد» في شريط المفضلة */
async function grabberDialog() {
  const p = modal({ title: '⭐ زر الاستيراد من صفحة المزاد', submitLabel: 'تم', body: html`
    <p style="margin-top:0">زر تحطه مرة وحدة في شريط المفضلة في متصفحك. تفتح صفحة أي سيارة في <b>IAAI</b> أو <b>Copart</b> أو <b>bid.cars</b>، تضغطه، فتنفتح المنظومة ونافذة «إضافة لوت» معبّية: العداد، الضرر، الملكية، المفتاح، الموعد، السعر، الولاية والمدينة.</p>
    <div style="text-align:center;margin:16px 0">
      <a class="btn btn-accent" style="font-size:17px;padding:12px 22px;cursor:grab" draggable="true" data-bm href="${bookmarkletHref(location.origin)}">⭐ استيراد لـ Golden Gate</a>
      <div class="faint" style="font-size:12.5px;margin-top:6px">اسحب هذا الزر بالماوس لشريط المفضلة ↑ (ما تضغطوش هني)</div>
    </div>
    <ol style="margin:0;padding-inline-start:20px;line-height:1.9">
      <li>أظهر شريط المفضلة: <b class="mono">Ctrl+Shift+B</b></li>
      <li>اسحب الزر الذهبي فوق وأفلته في الشريط</li>
      <li>افتح صفحة سيارة في IAAI أو Copart أو bid.cars، واضغط الزر من الشريط</li>
      <li>تنفتح المنظومة بنافذة معبّية — راجعها واضغط «إضافة»</li>
    </ol>
    <p class="faint" style="font-size:12.5px;margin:12px 0 0">الزر يقرا النص الظاهر في الصفحة اللي فاتحها أنت بس، وما يبعت أي طلب لموقع المزاد. رقم الهيكل في IAAI وCopart يبان ناقص لو مش داخل بحسابك؛ bid.cars يعطيه كامل. الصور حطها بـ«📋 لصق صورة».</p>` });
  $('dialog [data-bm]')?.addEventListener('click', (e) => { e.preventDefault(); toast('اسحب الزر لشريط المفضلة بالماوس، وبعدين اضغطه من هناك وأنت في صفحة المزاد'); });
  await p;
}

const can = (...roles) => roles.includes(state.user.role);
const WRITERS = ['ADMIN', 'OPERATIONS', 'SALES'];
const STATUS = {
  WATCHING: ['قيد المتابعة', '#0284c7'], WON: ['فزنا بها', '#16a34a'], LOST: ['خسرناها', '#94a3b8'],
  DROPPED: ['مستبعدة', '#94a3b8'], PURCHASED: ['اشتريناها', '#c9a96a'],
};
const RUN = [['RUN_DRIVE', 'تمشي'], ['STARTS', 'تشتغل وما تمشيش'], ['STATIONARY', 'واقفة'], ['UNKNOWN', 'غير معروف']];
const SOURCES = [['IAAI', 'IAAI'], ['COPART', 'Copart'], ['OTHER', 'مزاد آخر']];
const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'],
  ['DE', 'Delaware'], ['DC', 'Washington DC'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'],
  ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
// المزادات تكتب الموعد بتوقيت أمريكا (IAAI بالتوقيت المركزي غالبًا)، فنحوّله عند الحفظ
const ZONES = [['Africa/Tripoli', 'توقيت ليبيا'], ['America/Chicago', 'المركزي CST/CDT (IAAI)'], ['America/New_York', 'الشرقي EST/EDT'],
  ['America/Denver', 'الجبلي MST/MDT'], ['America/Los_Angeles', 'الباسيفيكي PST/PDT']];

const opts = (list, cur, blank = false) => html`${blank ? html`<option value="">—</option>` : ''}${list.map(([v, l]) => html`<option value="${v}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${l}</option>`)}`;
const usd = (v) => (v == null ? '—' : `${fmt.n(v)} $`);
const photoUrl = (w) => (im) => `/api/media/watch/${w.id}/${im.id}`;
let settings = loadSettings(); // إعدادات الحاسبة (سعر الصرف وأسعار الشحن) لتقدير التكلفة في البطاقات
const stateName = (c) => US_STATES.find(([k]) => k === c)?.[1] || c;

/** فرق المنطقة الزمنية عن UTC بالدقائق في لحظة معينة */
function tzOffset(zone, ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms) / 60000;
}
/** "2026-11-03T09:30" بتوقيت zone → ISO بالـUTC */
function wallToIso(local, zone) {
  const [d, t] = local.split('T');
  const [y, m, day] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, h, mi);
  let ms = guess - tzOffset(zone, guess) * 60000;
  ms = guess - tzOffset(zone, ms) * 60000; // تصحيح عند تغيّر التوقيت الصيفي
  return new Date(ms).toISOString();
}
/** ISO → "YYYY-MM-DDTHH:mm" بتوقيت zone (لتعبئة خانة التعديل) */
function isoToWall(iso, zone) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() + tzOffset(zone, new Date(iso).getTime()) * 60000;
  return new Date(ms).toISOString().slice(0, 16);
}
const usTime = (iso, zone = 'America/Chicago') => new Date(iso).toLocaleString('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function until(iso) {
  if (!iso) return { text: 'الموعد غير محدد', cls: 'faint' };
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return { text: s > -6 * 3600 ? 'بدأ المزاد' : 'انتهى الموعد', cls: 'faint' };
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  const text = d ? `بعد ${d} يوم${h ? ` و${h} س` : ''}` : h ? `بعد ${h} س${m ? ` و${m} د` : ''}` : `بعد ${m} د`;
  return { text, cls: s < 3 * 3600 ? 'countdown urgent' : s < 86400 ? 'neg' : 'pos' };
}

function badge(status) {
  const [l, c] = STATUS[status] || [status, '#64748b'];
  return html`<span class="badge" style="color:${c}"><span class="dot"></span><span style="color:var(--text)">${l}</span></span>`;
}

function lotForm(w = {}) {
  const zone = 'Africa/Tripoli';
  return html`
    <div class="grid g3"><label class="field">المزاد<select class="input" name="source" required>${opts(SOURCES, w.source || 'IAAI')}</select></label>
      <label class="field">رقم اللوت / المخزون<input class="input num" name="lotNumber" required minlength="3" maxlength="20" pattern="[0-9A-Za-z\\-]+" value="${w.lot_number || ''}"></label>
      <label class="field">رقم الهيكل (VIN)<input class="input mono" name="vin" maxlength="17" style="text-transform:uppercase" placeholder="ولو ناقص" value="${w.vin || ''}"></label></div>
    <div class="faint" data-vinstatus aria-live="polite" style="min-height:1.4em;margin-top:-6px">اكتب رقم الهيكل كاملًا (17 خانة) وتُعبَّأ السنة والماركة والطراز تلقائيًا.</div>
    <label class="field">رابط صفحة اللوت<input class="input" name="lotUrl" type="url" maxlength="500" placeholder="https://www.iaai.com/..." value="${w.lot_url || ''}"></label>
    <div class="grid g3"><label class="field">سنة الصنع<input class="input num" name="year" inputmode="numeric" pattern="\\d{4}" value="${w.year || ''}"></label>
      <label class="field">الماركة<input class="input" name="make" maxlength="60" list="makes-list" value="${w.make || ''}"></label>
      <label class="field">الطراز<input class="input" name="model" maxlength="80" value="${w.model || ''}"></label></div>
    <datalist id="makes-list">${(state.meta.makes || []).map((m) => html`<option value="${m}">`)}</datalist>
    <div class="grid g3"><label class="field">الفئة (Trim)<input class="input" name="trim" maxlength="80" value="${w.trim || ''}"></label>
      <label class="field">العداد (ميل)<input class="input num" name="odometer" inputmode="numeric" pattern="\\d+" value="${w.odometer ?? ''}"></label>
      <label class="field">الضرر<input class="input" name="primaryDamage" maxlength="80" placeholder="FRONT END" value="${w.primary_damage || ''}"></label></div>
    <div class="grid g3"><label class="field">الملكية<input class="input" name="titleDoc" maxlength="80" placeholder="SALVAGE (TX)" value="${w.title_doc || ''}"></label>
      <label class="field">الحالة<select class="input" name="runStatus">${opts(RUN, w.run_status, true)}</select></label>
      <label class="field">المفاتيح<select class="input" name="hasKeys">${opts([['true', 'موجودة'], ['false', 'لا']], w.has_keys == null ? '' : String(w.has_keys), true)}</select></label></div>
    <div class="alert" style="font-size:13px">مكان السيارة وموعد المزاد</div>
    <div class="grid g3"><label class="field">الولاية<select class="input" name="usState">${opts(US_STATES.map(([k, n]) => [k, `${n} (${k})`]), w.us_state, true)}</select></label>
      <label class="field">المدينة<input class="input" name="city" maxlength="80" placeholder="Lubbock" value="${w.city || ''}"></label>
      <label class="field">الفرع / الساحة<input class="input" name="branch" maxlength="80" value="${w.branch || ''}"></label></div>
    <div class="grid g2"><label class="field">موعد المزاد<input class="input" type="datetime-local" name="auctionAt" value="${isoToWall(w.auction_at, zone)}"></label>
      <label class="field">الموعد مكتوب بتوقيت<select class="input" name="zone">${opts(ZONES, zone)}</select></label></div>
    <div class="alert" style="font-size:13px">الأسعار بالدولار</div>
    <div class="grid g4"><label class="field">المزايدة الحالية<input class="input num" name="currentBidUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.current_bid_usd ? Number(w.current_bid_usd) : ''}"></label>
      <label class="field">شراء فوري (Buy Now)<input class="input num" name="buyNowUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.buy_now_usd ? Number(w.buy_now_usd) : ''}"></label>
      <label class="field">القيمة التقديرية (ACV)<input class="input num" name="estValueUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.est_value_usd ? Number(w.est_value_usd) : ''}"></label>
      <label class="field">أقصى سعر نقبل به<input class="input num" name="maxBidUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.max_bid_usd ? Number(w.max_bid_usd) : ''}"></label></div>
    <label class="field">ملاحظات<input class="input" name="notes" maxlength="1000" value="${w.notes || ''}"></label>`;
}

/** قيم النموذج → جسم الطلب. عند التعديل تُرسل الخانات الفارغة null لتفريغها */
function toBody(r, editing) {
  const b = {};
  const zone = r.zone; delete r.zone;
  for (const [k, v] of Object.entries(r)) {
    if (v === '') { if (editing && !['source', 'lotNumber'].includes(k)) b[k] = null; continue; }
    if (['year', 'odometer'].includes(k)) b[k] = Number(v);
    else if (k === 'hasKeys') b[k] = v === 'true';
    else if (k === 'auctionAt') b[k] = wallToIso(v, zone);
    else if (k === 'usState' || k === 'vin') b[k] = v.trim().toUpperCase();
    else b[k] = v.trim();
  }
  return b;
}

/** prefill: بيانات من «زر الاستيراد» (صفحة المزاد) تُعبّأ في نافذة إضافة جديدة يراجعها المستخدم */
async function lotDialog(w, reload, prefill = null) {
  const stopWatching = watchVin();
  let r;
  const title = w ? `تعديل اللوت ${w.lot_number}` : prefill ? 'إضافة لوت — من صفحة المزاد (راجع البيانات قبل الحفظ)' : 'إضافة لوت من مزاد أمريكي';
  try { r = await modal({ title, submitLabel: w ? 'حفظ التعديل' : 'إضافة', body: lotForm(w || prefill || {}) }); } finally { stopWatching(); }
  if (!r) return;
  try {
    if (w) await api(`/watchlist/${w.id}`, { method: 'PATCH', body: toBody(r, true) });
    else await api('/watchlist', { method: 'POST', body: toBody(r, false) });
    toast(w ? 'تم حفظ التعديل' : 'أُضيف اللوت', 'ok');
    reload();
  } catch (e) { toast(e.message, 'err'); }
}

async function convertDialog(w) {
  let customers = [];
  try { customers = await loadCustomers(true); } catch { /* دور بلا صلاحية قراءة العملاء */ }
  const today = new Date().toISOString().slice(0, 10);
  const price = w.final_price_usd || w.current_bid_usd;
  const full = /^[A-HJ-NPR-Z0-9]{17}$/.test(w.vin || '');
  const r = await modal({ title: `اشتريناها: ${w.year || ''} ${w.make || ''} ${w.model || ''}`, submitLabel: 'تحويل لسيارة', body: html`
    <p class="faint" style="margin-top:0">تُنشأ سيارة جديدة في «السيارات» ببيانات اللوت${w.images?.length ? ` وصوره (${w.images.length})` : ''}، وتُسجَّل تكاليف الشراء بالدولار بسعر صرف يوم الشراء.</p>
    <label class="field">رقم الهيكل (VIN) كامل — 17 خانة<input class="input mono" name="vin" required minlength="17" maxlength="17" pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{17}" style="text-transform:uppercase" value="${full ? w.vin : ''}" placeholder="${full ? '' : w.vin || ''}"></label>
    <div class="grid g2"><label class="field">تاريخ الشراء<input class="input" type="date" name="purchaseDate" value="${today}" max="${today}"></label>
      <label class="field">ميناء الوصول<select class="input" name="destinationPort">${opts(state.meta.ports.filter((p) => p.country === 'LY').map((p) => [p.code, p.name_ar]), 'LYMRA')}</select></label></div>
    <div class="grid g3"><label class="field">سعر الشراء ($)<input class="input num" name="purchasePriceUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${price ? Number(price) : ''}"></label>
      <label class="field">رسوم المشتري ($)<input class="input num" name="buyerFeeUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?"></label>
      <label class="field">رسوم أخرى ($)<input class="input num" name="otherFeesUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?"></label></div>
    ${dealFields(customers)}` });
  if (!r) return;
  if (!r.customerId) { delete r.customerPrice; delete r.customerCurrency; }
  if (!r.customerPrice) delete r.customerCurrency;
  const body = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '').map(([k, v]) => [k, k === 'vin' ? v.trim().toUpperCase() : v]));
  try {
    const v = await api(`/watchlist/${w.id}/convert`, { method: 'POST', body });
    toast(`أُضيفت السيارة ${v.stock_no}`, 'ok');
    location.hash = `#/vehicles/${v.id}`;
  } catch (e) { toast(e.message, 'err'); }
}

function lotCard(w) {
  const title = [w.year, w.make, w.model, w.trim].filter(Boolean).join(' ') || `لوت ${w.lot_number}`;
  const u = until(w.auction_at);
  const place = [w.city, w.us_state && `${stateName(w.us_state)} (${w.us_state})`].filter(Boolean).join('، ');
  const price = (label, v, strong) => html`<div><div class="faint" style="font-size:11.5px">${label}</div><div class="num" style="font-weight:${strong ? 700 : 600}">${usd(v)}</div></div>`;
  const over = w.max_bid_usd && w.current_bid_usd && Number(w.current_bid_usd) > Number(w.max_bid_usd);
  const write = can(...WRITERS);
  const act = (key, label, cls = 'btn-ghost') => html`<button class="btn btn-sm ${cls}" data-act="${key}" data-id="${w.id}">${label}</button>`;
  const imgs = w.images || [];
  return html`<div class="card vcard" data-lot="${w.id}" style="${w.status === 'WATCHING' ? '' : 'opacity:.85'}">
    ${imgs.length ? html`<button type="button" class="img" data-view style="display:block;width:100%;border:0;padding:0;cursor:zoom-in" aria-label="عرض صور ${title}">
      <img src="${photoUrl(w)(imgs[0])}" alt="${title}" loading="lazy"><span class="badge">📷 ${imgs.length}</span></button>` : ''}
    <div class="body">
    <div class="row" style="justify-content:space-between;gap:8px;align-items:flex-start">
      <h3>${title}</h3>${badge(w.status)}</div>
    <div class="meta"><span><b>${w.source === 'OTHER' ? 'مزاد' : w.source}</b> <span class="mono">${w.lot_number}</span></span>
      ${w.lot_url ? html`<a href="${w.lot_url}" target="_blank" rel="noopener noreferrer">صفحة اللوت ↗</a>` : ''}
      ${w.vin ? html`<span class="mono">${w.vin}</span>` : ''}</div>
    <div class="meta"><span>📍 ${place || 'المكان غير محدد'}</span>${w.branch ? html`<span>${w.branch}</span>` : ''}</div>
    <div style="padding:8px 10px;border-radius:10px;background:var(--surface-2)">
      <div class="row" style="justify-content:space-between;gap:8px"><span>${icon('clock')} <b>${w.auction_at ? fmt.dt(w.auction_at) : '—'}</b> <span class="faint" style="font-size:12px">ليبيا</span></span>
        ${w.status === 'WATCHING' ? html`<span class="${u.cls}" data-until="${w.auction_at || ''}">${u.text}</span>` : ''}</div>
      ${w.auction_at ? html`<div class="faint" style="font-size:12px;direction:ltr;text-align:end">${usTime(w.auction_at)}</div>` : ''}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:6px">${price('المزايدة الحالية', w.current_bid_usd, true)}${price('شراء فوري', w.buy_now_usd)}${price('القيمة التقديرية', w.est_value_usd)}${price('أقصى سعر لنا', w.max_bid_usd)}</div>
    ${over ? html`<div class="neg" style="font-size:12.5px">المزايدة الحالية تجاوزت أقصى سعر حطيناه</div>` : ''}
    ${(() => {
      const bid = Number(w.final_price_usd || w.current_bid_usd) || 0;
      if (w.status === 'PURCHASED' || bid <= 0) return html`<a class="lot-cost" href="#/calculator?lot=${w.id}"><span>🧮 احسب التكلفة حتى ليبيا</span><span>←</span></a>`;
      const e = estimateLot(w, bid, settings);
      return html`<a class="lot-cost" href="#/calculator?lot=${w.id}" title="${e.yard ? `نقل من ${e.yard.name}: $${e.yard.towing}` : 'الساحة غير معروفة: النقل الداخلي غير محسوب'}">
        <span>🧮 حتى ليبيا بسعر ${usd(bid)}: <b class="num">${Math.round(e.totalLYD).toLocaleString('en-US')} د.ل</b> <span class="faint">بدون جمرك</span>${e.yard ? '' : ' *'}</span><span>←</span></a>`;
    })()}
    ${w.final_price_usd ? html`<div style="font-size:13px">السعر النهائي: <b class="num">${usd(w.final_price_usd)}</b></div>` : ''}
    <div class="meta">${[w.primary_damage, RUN.find(([k]) => k === w.run_status)?.[1], w.title_doc, w.odometer != null && fmt.odo(w.odometer, w.odometer_unit),
      w.has_keys === true ? 'المفاتيح موجودة' : w.has_keys === false ? 'بدون مفاتيح' : null].filter(Boolean).map((x) => html`<span>${x}</span>`)}</div>
    ${w.notes ? html`<div class="faint" style="font-size:12.5px">${w.notes}</div>` : ''}
    <div class="foot" style="flex-wrap:wrap;gap:6px">
      ${w.status === 'PURCHASED' ? html`<a class="btn btn-sm btn-primary" href="#/vehicles/${w.vehicle_id}">السيارة ${w.stock_no}</a>` : ''}
      ${write && ['WATCHING', 'WON'].includes(w.status) && can('ADMIN', 'OPERATIONS') ? act('convert', 'اشتريناها', 'btn-accent') : ''}
      ${write && w.status === 'WATCHING' ? html`${act('bid', 'تحديث السعر')}${act('edit', 'تعديل')}${act('WON', 'فزنا')}${act('LOST', 'خسرنا')}${act('DROPPED', 'استبعاد')}` : ''}
      ${write && w.status === 'WON' ? html`${act('edit', 'تعديل')}${act('LOST', 'خسرنا')}${act('WATCHING', 'رجوع للمتابعة')}` : ''}
      ${write && ['LOST', 'DROPPED'].includes(w.status) ? act('WATCHING', 'إعادة للمتابعة') : ''}
      ${write && w.status !== 'PURCHASED' ? html`<label class="btn btn-sm btn-ghost" style="cursor:pointer">📷 إضافة صور
        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/*" multiple hidden data-photo-input></label>
        ${act('paste', '📋 لصق صورة')}
        ${imgs.length ? html`<button type="button" class="btn btn-sm btn-ghost" data-photo-manage>إدارة الصور</button>` : ''}` : ''}
    </div></div></div>`;
}

let timer = null;
let onPaste = null;
let pasteTarget = null; // اللوت الذي ضُغط على «لصق صورة» فيه
export async function watchlistView(el, { query }) {
  clearInterval(timer); // إعادة التحميل بعد أي إجراء تستدعي العرض من جديد
  if (onPaste) document.removeEventListener('paste', onPaste);
  settings = loadSettings();
  const status = query.status || 'WATCHING';
  const q = query.q || '';
  const data = await api(`/watchlist?status=${encodeURIComponent(status)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const reload = () => watchlistView(el, { query: { status, q } });
  const go = (s, qq = q) => { location.hash = `#/watchlist?status=${s}${qq ? `&q=${encodeURIComponent(qq)}` : ''}`; };
  const total = Object.values(data.counts).reduce((a, n) => a + n, 0);
  const soon = data.items.filter((w) => w.status === 'WATCHING' && w.auction_at && new Date(w.auction_at) > new Date() && new Date(w.auction_at) - Date.now() < 86400000).length;
  const tabs = [...Object.entries(STATUS).map(([k, [l]]) => [k, l, data.counts[k] || 0]), ['ALL', 'الكل', total]];
  render(el, html`
    <form class="card filters" data-search style="margin-bottom:12px">
      <label class="field grow">بحث<input class="input" name="q" value="${q}" placeholder="رقم اللوت، VIN، الماركة، الطراز، المدينة…"></label>
      <button class="btn btn-primary">بحث</button>
      ${can(...WRITERS) ? html`<button type="button" class="btn btn-accent" data-add>${icon('plus')} إضافة لوت</button>
        <button type="button" class="btn" data-grabber>⭐ زر الاستيراد من المزاد</button>` : ''}
    </form>
    <div class="card" style="margin-bottom:14px"><div class="tabs">${tabs.map(([k, l, n]) => html`<button type="button" class="${k === status ? 'on' : ''}" data-tab="${k}">${l} <span class="faint">${n}</span></button>`)}</div>
      ${status === 'WATCHING' && soon ? html`<div class="card-b" style="padding:10px 16px"><b class="neg">${soon}</b> مزاد يبدا خلال 24 ساعة</div>` : ''}</div>
    ${data.items.length ? html`<div class="vgrid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${data.items.map(lotCard)}</div>`
      : html`<div class="card empty">${status === 'WATCHING' ? 'ما فيش سيارات قيد المتابعة. اضغط «إضافة لوت» وحط بيانات السيارة من صفحة المزاد.' : 'لا توجد لوتات هنا'}</div>`}`);
  $('[data-search]', el).addEventListener('submit', (e) => { e.preventDefault(); go(status, e.target.q.value.trim()); });
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  $('[data-add]', el)?.addEventListener('click', () => lotDialog(null, reload));
  $('[data-grabber]', el)?.addEventListener('click', grabberDialog);
  // فُتحت من «زر الاستيراد»: نافذة إضافة معبّأة، ثم نزيل البيانات من الرابط حتى لا تُفتح ثانية عند التحديث
  if (query.import) {
    let pre = null;
    try { pre = decodeImport(query.import); } catch { toast('بيانات الاستيراد غير صالحة', 'err'); }
    history.replaceState(null, '', `#/watchlist?status=${status}`);
    if (pre && can(...WRITERS)) lotDialog(null, reload, pre);
  }
  for (const w of data.items) {
    const card = $(`[data-lot="${w.id}"]`, el);
    if (!card) continue;
    const urlOf = photoUrl(w);
    mountPhotos(card, w, reload, { path: `/watchlist/${w.id}/images`, urlOf });
    $('[data-view]', card)?.addEventListener('click', () => openLightbox(w.images, urlOf, 0, [w.year, w.make, w.model].filter(Boolean).join(' ')));
  }
  $$('[data-act]', el).forEach((b) => b.addEventListener('click', async () => {
    const w = data.items.find((x) => x.id === b.dataset.id);
    const a = b.dataset.act;
    if (a === 'edit') return lotDialog(w, reload);
    if (a === 'convert') return convertDialog(w);
    if (a === 'paste') {
      pasteTarget = w;
      $$('.vcard', el).forEach((c) => { c.style.outline = c.dataset.lot === w.id ? '3px solid var(--brand)' : ''; });
      toast('انسخ الصورة من صفحة المزاد (زر يمين ← Copy image) ثم اضغط Ctrl+V هنا');
      return;
    }
    if (a === 'bid') {
      const r = await modal({ title: `تحديث سعر اللوت ${w.lot_number}`, body: html`
        <div class="grid g2"><label class="field">المزايدة الحالية ($)<input class="input num" name="currentBidUsd" required inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.current_bid_usd ? Number(w.current_bid_usd) : ''}"></label>
          <label class="field">شراء فوري ($)<input class="input num" name="buyNowUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.buy_now_usd ? Number(w.buy_now_usd) : ''}"></label></div>` });
      if (!r) return;
      try { await api(`/watchlist/${w.id}`, { method: 'PATCH', body: { currentBidUsd: r.currentBidUsd, buyNowUsd: r.buyNowUsd || null } }); toast('تم تحديث السعر', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); }
      return;
    }
    let finalPriceUsd;
    if (a === 'WON') {
      const r = await modal({ title: 'فزنا باللوت', submitLabel: 'تأكيد', body: html`<label class="field">السعر النهائي ($) — اختياري<input class="input num" name="finalPriceUsd" inputmode="decimal" pattern="\\d+(\\.\\d{1,3})?" value="${w.current_bid_usd ? Number(w.current_bid_usd) : ''}"></label>` });
      if (!r) return;
      finalPriceUsd = r.finalPriceUsd || undefined;
    }
    try {
      await api(`/watchlist/${w.id}/status`, { method: 'POST', body: { to: a, ...(finalPriceUsd ? { finalPriceUsd } : {}) } });
      toast(`صارت: ${STATUS[a][0]}`, 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  }));
  // لصق صورة (Ctrl+V) على اللوت المختار: تُرفع وتصير الصورة الرئيسية
  onPaste = async (e) => {
    if (e.target.closest?.('input, textarea, dialog')) return;
    const file = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    if (!file) return;
    e.preventDefault();
    const w = pasteTarget && data.items.find((x) => x.id === pasteTarget.id);
    if (!w) { toast('اضغط «📋 لصق صورة» على السيارة أولًا، ثم Ctrl+V', 'err'); return; }
    toast('جارٍ رفع الصورة…');
    try {
      const im = await api(`/watchlist/${w.id}/images`, { method: 'POST', body: await compress(file) });
      if (!im.is_primary) await api(`/watchlist/${w.id}/images/${im.id}/primary`, { method: 'POST', body: {} });
      pasteTarget = null;
      toast('أُضيفت الصورة الرئيسية', 'ok');
      reload();
    } catch (err) { toast(err.message, 'err'); }
  };
  document.addEventListener('paste', onPaste);
  // العدّ التنازلي يتحدث كل 30 ثانية دون إعادة تحميل الصفحة
  timer = setInterval(() => $$('[data-until]', el).forEach((s) => {
    const u = until(s.dataset.until || null);
    s.textContent = u.text; s.className = u.cls;
  }), 30_000);
  return () => { clearInterval(timer); document.removeEventListener('paste', onPaste); pasteTarget = null; };
}
