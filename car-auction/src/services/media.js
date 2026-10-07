// مولّد صور توضيحية للسيارات (SVG متجهي — حاد عند أي مستوى تكبير).
// في الإنتاج تُخدَم الصور الحقيقية المنزّلة من Copart/IAAI ومن تصوير المعرض عبر
// التخزين الكائني (S3/MinIO) وشبكة CDN بأحجام متعددة؛ هذا المولّد يتيح للنموذج
// الأولي العمل دون الاعتماد على صور خارجية محمية بحقوق نشر.
import { COLORS } from '../sync/catalog.js';

const W = 1600, H = 1000;

function colorHex(name) {
  return (COLORS.find((c) => c.name === String(name || '').toUpperCase()) || COLORS[2]).hex;
}

function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (pct < 0 ? c : 255 - c) * pct)));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map(f).map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const SHAPES = {
  SEDAN: {
    body: 'M215 700 L210 615 Q214 565 290 548 L560 512 Q640 410 760 392 L1030 392 Q1150 398 1250 498 L1370 515 Q1408 524 1412 585 L1410 700 Z',
    glass: 'M590 512 Q660 425 765 410 L885 408 L885 512 Z M905 408 L1025 408 Q1120 414 1205 505 L905 512 Z',
    beltY: 540,
  },
  SUV: {
    body: 'M205 705 L200 600 Q205 545 300 528 L575 500 Q650 360 720 335 L1290 332 Q1360 336 1385 420 L1405 520 L1410 705 Z',
    glass: 'M600 500 Q660 375 728 352 L900 350 L900 500 Z M920 350 L1110 350 L1110 500 L920 500 Z M1130 350 L1280 350 Q1335 356 1352 420 L1360 500 L1130 500 Z',
    beltY: 530,
  },
  PICKUP: {
    body: 'M205 705 L200 600 Q205 545 300 528 L585 500 Q645 365 715 340 L960 338 Q985 345 990 420 L992 505 L1410 505 L1415 705 Z',
    glass: 'M610 500 Q660 380 722 357 L830 355 L830 500 Z M850 355 L955 355 Q968 362 970 420 L972 500 L850 500 Z',
    beltY: 530,
  },
};

function shapeFor(body) {
  const b = String(body || '').toUpperCase();
  if (b.includes('PICK')) return SHAPES.PICKUP;
  if (b.includes('SUV') || b.includes('UTIL') || b.includes('WAGON')) return SHAPES.SUV;
  return SHAPES.SEDAN;
}

function wheel(cx, cy) {
  const spokes = Array.from({ length: 5 }, (_, i) => {
    const a = (i * 72 * Math.PI) / 180;
    return `<path d="M${cx} ${cy} L${cx + Math.cos(a - 0.18) * 58} ${cy + Math.sin(a - 0.18) * 58} L${cx + Math.cos(a + 0.18) * 58} ${cy + Math.sin(a + 0.18) * 58} Z" fill="#c9ced6"/>`;
  }).join('');
  return `<circle cx="${cx}" cy="${cy}" r="98" fill="#16181d"/><circle cx="${cx}" cy="${cy}" r="92" fill="#22252c"/>
    <circle cx="${cx}" cy="${cy}" r="64" fill="url(#rim)"/>${spokes}<circle cx="${cx}" cy="${cy}" r="16" fill="#8a919c"/>`;
}

function damageMarks(where, color) {
  const x = where === 'FRONT' ? 300 : where === 'REAR' ? 1330 : 880;
  const dark = shade(color, -0.45);
  return `<g opacity="0.92">
    <path d="M${x - 70} 570 l30 -18 l22 26 l28 -30 l20 34 l34 -16 l-6 40 l-40 22 l-30 -10 l-34 18 l-30 -22 Z" fill="${dark}" stroke="#2a2a2a" stroke-width="3"/>
    <path d="M${x - 110} 600 l220 -8 M${x - 90} 625 l170 6 M${x - 60} 648 l120 -4" stroke="#e5e7eb" stroke-width="3" stroke-linecap="round" opacity="0.7"/>
  </g>`;
}

function sideView(v, { mirrored = false, zoomDamage = false } = {}) {
  const color = colorHex(v.exterior_color);
  const s = shapeFor(v.body_style);
  const dmg = String(v.primary_damage || '').toUpperCase();
  const where = dmg.includes('FRONT') ? 'FRONT' : dmg.includes('REAR') ? 'REAR' : dmg.includes('SIDE') || dmg.includes('DENT') || dmg.includes('ALL') || dmg.includes('HAIL') ? 'SIDE' : null;
  const car = `
    <ellipse cx="810" cy="800" rx="700" ry="38" fill="#000" opacity="0.28" filter="url(#blur)"/>
    <path d="${s.body}" fill="url(#paint)" stroke="${shade(color, -0.35)}" stroke-width="4"/>
    <path d="${s.glass}" fill="url(#glass)" stroke="#111" stroke-width="3"/>
    <path d="M230 ${s.beltY + 70} L1400 ${s.beltY + 70}" stroke="${shade(color, -0.25)}" stroke-width="5" opacity="0.6"/>
    <path d="M895 ${s.beltY - 30} L885 690 M600 ${s.beltY - 10} L600 690" stroke="${shade(color, -0.4)}" stroke-width="3" opacity="0.7"/>
    <rect x="${s === SHAPES.PICKUP ? 760 : 720}" y="${s.beltY + 20}" width="62" height="14" rx="7" fill="${shade(color, -0.3)}"/>
    <rect x="1000" y="${s.beltY + 20}" width="62" height="14" rx="7" fill="${shade(color, -0.3)}"/>
    <path d="M220 600 Q240 570 300 562 L330 590 Q270 600 222 625 Z" fill="#fff8d6" stroke="#999" stroke-width="2"/>
    <path d="M1405 560 L1408 615 L1370 610 L1372 560 Z" fill="#c1121f"/>
    <path d="M560 515 l-40 -32 l46 -6 Z" fill="${shade(color, -0.2)}"/>
    <path d="M300 545 Q700 505 1250 498" stroke="#fff" stroke-width="6" opacity="0.18" fill="none"/>
    ${where ? damageMarks(where, color) : ''}
    ${wheel(440, 705)}${wheel(1180, 705)}`;
  const tx = mirrored ? `translate(${W},0) scale(-1,1)` : '';
  const zoom = zoomDamage && where
    ? `translate(${W / 2},${H / 2}) scale(2.2) translate(${-(where === 'FRONT' ? 330 : where === 'REAR' ? 1300 : 880)},-600)`
    : '';
  return `<g transform="${zoom}"><g transform="${tx}">${car}</g></g>`;
}

function frontView(v, rear = false) {
  const color = colorHex(v.exterior_color);
  const tall = shapeFor(v.body_style) !== SHAPES.SEDAN;
  const top = tall ? 300 : 360;
  return `<ellipse cx="800" cy="805" rx="470" ry="34" fill="#000" opacity="0.3" filter="url(#blur)"/>
    <rect x="420" y="660" width="120" height="140" rx="22" fill="#16181d"/><rect x="1060" y="660" width="120" height="140" rx="22" fill="#16181d"/>
    <path d="M400 760 L392 560 Q400 500 470 480 L560 ${top + 40} Q800 ${top - 10} 1040 ${top + 40} L1130 480 Q1200 500 1208 560 L1200 760 Z" fill="url(#paint)" stroke="${shade(color, -0.35)}" stroke-width="4"/>
    <path d="M590 ${top + 60} Q800 ${top + 20} 1010 ${top + 60} L1070 470 L530 470 Z" fill="url(#glass)" stroke="#111" stroke-width="3"/>
    ${rear
      ? `<rect x="430" y="540" width="200" height="54" rx="14" fill="#c1121f"/><rect x="970" y="540" width="200" height="54" rx="14" fill="#c1121f"/>
         <rect x="700" y="610" width="200" height="70" rx="8" fill="#f8fafc" stroke="#333" stroke-width="3"/><text x="800" y="657" font-size="34" text-anchor="middle" font-family="monospace" fill="#111">${esc(v.title_state || 'TX')}</text>`
      : `<path d="M430 545 L620 555 L610 600 L440 595 Z" fill="#fff8d6" stroke="#999" stroke-width="2"/><path d="M1170 545 L980 555 L990 600 L1160 595 Z" fill="#fff8d6" stroke="#999" stroke-width="2"/>
         <rect x="650" y="560" width="300" height="90" rx="20" fill="#1f2228"/><path d="M670 590 H930 M670 615 H930" stroke="#5b6270" stroke-width="5"/>`}
    <rect x="410" y="700" width="780" height="40" rx="12" fill="${shade(color, -0.3)}"/>`;
}

function interiorView() {
  return `<rect x="0" y="0" width="${W}" height="${H}" fill="#2b2f36"/>
    <path d="M0 520 Q800 380 1600 520 L1600 1000 L0 1000 Z" fill="#1c1f24"/>
    <rect x="620" y="420" width="360" height="200" rx="18" fill="#0b0d10" stroke="#3a3f48" stroke-width="6"/>
    <rect x="645" y="445" width="310" height="150" rx="10" fill="#1e3a5f"/><path d="M660 560 L720 520 L780 540 L860 480 L940 500" stroke="#7dd3fc" stroke-width="5" fill="none"/>
    <circle cx="420" cy="640" r="190" fill="none" stroke="#0e1013" stroke-width="44"/><circle cx="420" cy="640" r="60" fill="#0e1013"/>
    <path d="M250 640 H590" stroke="#0e1013" stroke-width="36"/>
    <path d="M1080 760 Q1150 560 1340 560 Q1480 570 1500 760 Z" fill="#3b3128"/><path d="M180 1000 Q260 820 420 830 Q560 840 600 1000 Z" fill="#3b3128"/>
    <rect x="700" y="660" width="200" height="240" rx="24" fill="#15171b"/><circle cx="800" cy="740" r="30" fill="#2e333b"/>`;
}

function engineView(v) {
  const color = colorHex(v.exterior_color);
  return `<rect x="0" y="0" width="${W}" height="${H}" fill="${shade(color, -0.55)}"/>
    <rect x="120" y="140" width="1360" height="740" rx="40" fill="#24272d"/>
    <rect x="480" y="300" width="640" height="400" rx="30" fill="#3b3f47" stroke="#555" stroke-width="6"/>
    <rect x="540" y="340" width="520" height="90" rx="16" fill="#111"/><text x="800" y="400" font-size="42" text-anchor="middle" fill="#b0b6c0" font-family="sans-serif">${esc(v.engine || 'ENGINE')}</text>
    ${[0, 1, 2, 3].map((i) => `<circle cx="${590 + i * 140}" cy="560" r="44" fill="#565b64" stroke="#2a2d33" stroke-width="8"/>`).join('')}
    <rect x="200" y="220" width="200" height="140" rx="14" fill="#111"/><rect x="230" y="200" width="40" height="30" fill="#c1121f"/><rect x="330" y="200" width="40" height="30" fill="#333"/>
    <rect x="1200" y="220" width="200" height="300" rx="20" fill="#1d4ed8" opacity="0.6"/><path d="M400 760 Q800 820 1200 760" stroke="#111" stroke-width="22" fill="none"/>`;
}

/**
 * @param {object} v صف السيارة (exterior_color, body_style, primary_damage, engine, stock_no, year, make, model)
 * @param {number} index ترتيب الصورة
 */
export function renderVehicleSvg(v, index) {
  const color = colorHex(v.exterior_color);
  const view = index % 7;
  let content;
  let studio = true;
  if (view === 0) content = sideView(v);
  else if (view === 1) content = frontView(v);
  else if (view === 2) { content = interiorView(); studio = false; }
  else if (view === 3) content = frontView(v, true);
  else if (view === 4) { content = engineView(v); studio = false; }
  else if (view === 5) content = sideView(v, { zoomDamage: true });
  else content = sideView(v, { mirrored: true });

  const labels = ['جانبي', 'أمامي', 'داخلي', 'خلفي', 'المحرك', 'الضرر', 'جانبي أيمن'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${v.year} ${v.make} ${v.model} — ${labels[view]}`)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef1f5"/><stop offset="0.72" stop-color="#d9dee6"/><stop offset="0.72" stop-color="#c3c9d2"/><stop offset="1" stop-color="#aab1bc"/></linearGradient>
    <linearGradient id="paint" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(color, 0.28)}"/><stop offset="0.45" stop-color="${color}"/><stop offset="1" stop-color="${shade(color, -0.35)}"/></linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3c4a5c"/><stop offset="0.5" stop-color="#1b2330"/><stop offset="1" stop-color="#0f141b"/></linearGradient>
    <radialGradient id="rim"><stop offset="0" stop-color="#e5e7eb"/><stop offset="1" stop-color="#6b7280"/></radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="12"/></filter>
  </defs>
  ${studio ? `<rect width="${W}" height="${H}" fill="url(#bg)"/>` : ''}
  ${content}
  <g font-family="sans-serif" fill="#fff"><rect x="24" y="${H - 70}" width="420" height="46" rx="10" fill="#000" opacity="0.45"/>
  <text x="40" y="${H - 38}" font-size="24">${esc(v.stock_no)} · ${esc(v.year)} ${esc(v.make)} ${esc(v.model)}</text></g>
</svg>`;
}
