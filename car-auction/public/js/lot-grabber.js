// «زر الاستيراد من المزاد» (Bookmarklet): يُسحب إلى شريط المفضلة، ويُضغط في صفحة سيارة على IAAI أو Copart أو bid.cars
// يفتحها المستخدم بنفسه. يقرأ النص الظاهر في الصفحة فقط (لا يرسل أي طلب للمزاد)، ثم يفتح «مزادات أمريكا» في المنظومة
// ونافذة «إضافة لوت» معبّأة؛ المستخدم يراجع ويحفظ من جلسته.
//
// parseLotText دالة صافية (نص → بيانات) تُختبر وحدها، وتُضمَّن نصًا داخل الـBookmarklet، فلا تعتمد على أي متغير خارجها.

/** { host, href, title, h1, text } → حقول اللوت (بأسماء أعمدة watch_lots) أو { error } */
export function parseLotText(page) {
  const lines = String(page.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const low = (s) => String(s || '').toLowerCase();
  // قيمة الحقل: «الاسم:» في سطر والقيمة في السطر التالي، أو «الاسم:القيمة» في نفس السطر
  const get = (...labels) => {
    for (const label of labels) {
      const L = low(label) + ':';
      for (let i = 0; i < lines.length; i++) {
        const l = low(lines[i]);
        if (l === L) { const v = lines[i + 1]; if (v && !v.endsWith(':')) return v; }
        else if (l.startsWith(L) && lines[i].length > L.length) return lines[i].slice(L.length).trim();
      }
    }
    return null;
  };
  const after = (label) => { const i = lines.findIndex((l) => low(l) === low(label)); return i >= 0 ? lines[i + 1] || null : null; };
  const money = (s) => { const m = String(s || '').replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/); return m && Number(m[1]) > 0 ? String(Math.round(Number(m[1]))) : null; };
  const int = (s) => { const m = String(s || '').replace(/[,\s](?=\d{3}\b)/g, '').match(/\d+/); return m ? Number(m[0]) : null; };
  const nz = (s) => (s && !/^[-–—]$|^n\/?a$|^none$|^unknown$/i.test(s.trim()) ? s.trim() : null);
  const cut = (s, n) => (s ? String(s).slice(0, n) : null);
  const state = (s) => { const m = String(s || '').match(/\(([A-Z]{2})\)|^([A-Z]{2})\s*-/); return m ? m[1] || m[2] : null; };
  const runOf = (s) => { const x = low(s); return /run.*drive/.test(x) ? 'RUN_DRIVE' : /stationary/.test(x) ? 'STATIONARY' : /start/.test(x) ? 'STARTS' : null; };
  const keyOf = (s) => { const x = low(s); return /^(present|yes|y)\b/.test(x) ? true : /^(missing|no|n|not present)\b/.test(x) ? false : null; };
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const TZ = { CST: -6, CDT: -5, EST: -5, EDT: -4, MST: -7, MDT: -6, PST: -8, PDT: -7 };
  const h24 = (h, ap) => { h = Number(h) % 12; return /p/i.test(ap) ? h + 12 : h; };
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  // «2017 BMW X6 XDRIVE35I» → سنة + بقية
  const ymm = (s) => { const m = String(s || '').match(/^\s*(\d{4})\s+(.+)$/); return m ? { year: Number(m[1]), rest: m[2].trim() } : null; };
  const host = low(page.host);
  const out = { lot_url: cut(page.href, 500) };

  if (/iaai\.com$/.test(host)) {
    out.source = 'IAAI';
    out.lot_number = nz(get('Stock #'));
    out.vin = nz((get('VIN (Status)', 'VIN') || '').split(/\s/)[0]);
    const t = ymm(page.h1 || String(page.title || '').replace(/ for Auction.*$/i, ''));
    out.model = nz(get('Model')); out.trim = nz(get('Series'));
    if (t) {
      out.year = t.year;
      let mk = t.rest;
      for (const p of [out.trim, out.model]) if (p && mk.toUpperCase().endsWith(' ' + p.toUpperCase())) mk = mk.slice(0, -p.length - 1);
      out.make = mk.trim() || null;
    }
    const odo = get('Odometer'); out.odometer = int(odo);
    out.primary_damage = cut([nz(get('Primary Damage')), nz(get('Secondary Damage'))].filter(Boolean).join(' / ') || null, 80);
    out.title_doc = cut(nz(get('Title/Sale Doc')), 80);
    out.run_status = runOf(get('Start Code'));
    out.has_keys = keyOf(get('Key'));
    const br = nz(get('Selling Branch'));
    out.branch = cut(br, 80); out.us_state = state(br); out.city = cut(br && br.replace(/\s*\([A-Z]{2}\)\s*$/, ''), 80);
    const d = String(get('Auction Date and Time') || '').match(/(\w{3})\s+(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*\((\w{3})\)/i);
    if (d && MON[low(d[1])] != null) {
      const now = new Date(page.now || Date.now()); let y = now.getUTCFullYear();
      const at = (yy) => Date.UTC(yy, MON[low(d[1])], Number(d[2]), h24(d[3], d[5]), Number(d[4])) - (TZ[d[6].toUpperCase()] ?? -6) * 3600000;
      if (at(y) < now.getTime() - 180 * 86400000) y++; // موعد يناير والصفحة في ديسمبر
      out.auction_at = iso(at(y));
    }
    out.est_value_usd = money(get('Actual Cash Value'));
    out.buy_now_usd = money(get('Buy Now Price'));
    out.current_bid_usd = money(get('Current Bid'));
    const color = nz((get('Exterior/Interior') || '').split('/')[0]);
    out.notes = cut([color && `اللون: ${color}`, /actual/i.test(odo || '') ? null : odo && `العداد: ${odo}`].filter(Boolean).join(' — ') || null, 1000);
  } else if (/copart\.com$/.test(host)) {
    out.source = 'COPART';
    out.lot_number = nz((get('Lot number', 'Lot #') || '').replace(/\D/g, ''));
    out.vin = nz((get('VIN') || '').split(/\s/)[0]);
    const t = ymm(page.h1 || String(page.title || '').split('|')[0]);
    if (t) { const p = t.rest.split(/\s+/); out.year = t.year; out.make = p[0] || null; out.model = p[1] || null; out.trim = p.slice(2).join(' ') || null; }
    const odo = get('Odometer'); out.odometer = int(odo);
    const odoNote = after(odo || '\u0000');
    out.primary_damage = cut([nz(get('Primary damage')), nz(get('Secondary damage'))].filter(Boolean).join(' / ') || null, 80);
    let td = get('Title code');
    if (td && /-\s*$/.test(td)) { const i = lines.findIndex((l) => l === td); if (i >= 0 && lines[i + 1]) td = `${td} ${lines[i + 1]}`; }
    out.title_doc = cut(nz(td), 80);
    out.run_status = runOf(get('Highlights')) || (/engine starts/i.test(page.text) ? 'STARTS' : null);
    out.has_keys = keyOf(get('Has key', 'Keys'));
    const loc = nz(get('Location', 'Sale name'));
    out.branch = cut(loc, 80); out.us_state = state(loc); out.city = cut(loc && loc.replace(/^[A-Z]{2}\s*-\s*/, ''), 80);
    const d = String(get('Sale date') || '').match(/(\w{3})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*GMT([+-]\d{1,2})/i);
    if (d && MON[low(d[1])] != null) out.auction_at = iso(Date.UTC(Number(d[3]), MON[low(d[1])], Number(d[2]), h24(d[4], d[6]), Number(d[5])) - Number(d[7]) * 3600000);
    out.est_value_usd = money(get('Estimated retail value'));
    out.current_bid_usd = money(after('Current bid'));
    out.buy_now_usd = money(get('Buy it now price', 'Buy it now'));
    const color = nz(get('Color'));
    out.notes = cut([color && `اللون: ${color}`, odoNote && /not actual|exempt/i.test(odoNote) ? `العداد غير مؤكد (${odoNote})` : null].filter(Boolean).join(' — ') || null, 1000);
  } else if (/bid\.cars$/.test(host)) {
    const lm = String(page.text || '').match(/\b([01])-(\d{6,10})\b/);
    out.source = lm ? (lm[1] === '1' ? 'COPART' : 'IAAI') : 'OTHER';
    out.lot_number = lm ? lm[2] : null;
    const vm = String(page.h1 || page.title || '').match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
    out.vin = vm ? vm[1] : null;
    const t = ymm(String(page.title || '').split('|')[0]);
    if (t) {
      const [name, tr] = t.rest.split(',');
      const p = name.trim().split(/\s+/);
      out.year = t.year; out.make = p[0] ? p[0].toUpperCase() : null; out.model = p.slice(1).join(' ').toUpperCase() || null; out.trim = tr ? tr.trim().toUpperCase() : null;
    }
    // العداد قبل «mi» مباشرة، والآلاف مفصولة بمسافة أو فاصلة (لا يبدأ بعد رقم أو $ حتى لا يلتصق بالسعر قبله)
    const om = String(page.text || '').match(/(?<![\d,.$])(\d{1,3}(?: \d{3})+|\d{1,3}(?:,\d{3})+|\d{2,6})\s*mi\b/i);
    out.odometer = om ? int(om[1]) : null;
    const loc = nz(get('Location'));
    out.branch = cut(loc, 80); out.us_state = state(loc); out.city = cut(loc && loc.replace(/\s*\([A-Z]{2}\)\s*$/, ''), 80);
    out.title_doc = cut(nz(get('Sale Document', 'Sale doc.')), 80);
    out.primary_damage = cut(nz(get('Damage')), 80);
    out.run_status = runOf(get('Status'));
    out.current_bid_usd = money(after('Current Bid') || after('Current bid'));
    out.buy_now_usd = money(get('Buy Now', 'Fast Buy Price'));
  } else {
    return { error: 'افتح صفحة سيارة في IAAI أو Copart أو bid.cars ثم اضغط الزر' };
  }
  if (!out.lot_number && !out.vin) return { error: 'ما لقيتش رقم اللوت ولا رقم الهيكل في الصفحة. تأكد إنك فاتح صفحة سيارة وحدة' };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

/** نص الـBookmarklet الجاهز للسحب (origin = عنوان المنظومة) */
export function bookmarkletHref(origin) {
  const body = `(function(ORIGIN){
  var parse=${parseLotText.toString()};
  var d=parse({host:location.hostname.replace(/^www\\./,''),href:location.href,title:document.title,h1:(document.querySelector('h1')||{}).innerText||'',text:(document.querySelector('main')||document.body).innerText,now:Date.now()});
  if(d.error){alert('Golden Gate Motors: '+d.error);return;}
  var b=btoa(unescape(encodeURIComponent(JSON.stringify(d)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  window.open(ORIGIN+'/#/watchlist?import='+b,'_blank');
})(${JSON.stringify(origin)})`;
  return `javascript:${encodeURIComponent(body)}`;
}

/** فك بيانات الاستيراد من الرابط (base64url → كائن) */
export function decodeImport(b64) {
  const s = String(b64 || '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(s + '==='.slice((s.length + 3) % 4)))));
}
