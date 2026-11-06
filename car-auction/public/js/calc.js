// حاسبة التكلفة الكاملة لسيارة من مزاد أمريكي حتى ليبيا (عبر الوسيط).
// دوال صافية بلا واجهة: تستعملها شاشة الحاسبة وبطاقات «مزادات أمريكا».
// الجداول بالدولار: [الحد الأعلى للشريحة، الرسم]. تُراجع عند تغيّر رسوم المزادات أو أسعار الوسيط.
import { COPART_YARDS, IAAI_YARDS } from './calc-yards.js';

const tier = (table, bid) => (table.find(([max]) => bid <= max) || [0, 0])[1];

// عمولة المشتري (Buyer fee) حتى 14,999.99$؛ فوق ذلك نسبة من السعر
const BUYER_NONCLEAN = [[99.99, 1], [199.99, 25], [299.99, 60], [349.99, 85], [399.99, 100], [449.99, 125], [499.99, 135], [549.99, 145],
  [599.99, 155], [699.99, 170], [799.99, 195], [899.99, 215], [999.99, 230], [1199.99, 250], [1299.99, 270], [1399.99, 285], [1499.99, 300],
  [1599.99, 315], [1699.99, 330], [1799.99, 350], [1999.99, 370], [2399.99, 390], [2499.99, 425], [2999.99, 460], [3499.99, 505], [3999.99, 555],
  [4499.99, 600], [4999.99, 625], [5499.99, 650], [5999.99, 675], [6499.99, 700], [6999.99, 720], [7499.99, 755], [7999.99, 775], [8499.99, 800],
  [9999.99, 820], [11499.99, 850], [11999.99, 860], [12499.99, 875], [14999.99, 890]];
const BUYER_CLEAN_COPART = [[99.99, 1], [199.99, 25], [299.99, 50], [399.99, 75], [499.99, 110], [549.99, 125], [599.99, 130], [699.99, 140],
  [799.99, 155], [899.99, 170], [999.99, 185], [1199.99, 200], [1299.99, 225], [1399.99, 240], [1499.99, 250], [1599.99, 260], [1699.99, 275],
  [1799.99, 285], [1999.99, 300], [2399.99, 325], [2499.99, 335], [2999.99, 350], [3499.99, 400], [3999.99, 455], [4499.99, 600], [5999.99, 625],
  [7499.99, 675], [7999.99, 690], [9999.99, 715], [14999.99, 720]];
// رسوم المزايدة الإلكترونية: مسبقة (Pre-bid) أو مباشرة (Live)
const BID_FEE_STEPS = [499.99, 999.99, 1499.99, 1999.99, 3999.99, 5999.99, 7999.99, Infinity];
const BID_FEE = {
  clean: { pre: [39, 49, 69, 79, 89, 99, 119, 129], live: [49, 59, 79, 89, 99, 109, 139, 149] }, // Copart نظيفة
  nonclean: { pre: [40, 55, 75, 85, 100, 110, 125, 140], live: [50, 65, 85, 95, 110, 125, 145, 160] }, // Copart بأضرار، وIAAI دائمًا
};

export const PORTS = {
  GA: { label: 'جورجيا (Savannah)', quad: 1050, triple: 1400, loading: 1700 },
  NJ: { label: 'نيوجيرسي (Newark)', quad: 1050, triple: 1400, loading: 1700 },
  TX: { label: 'هيوستن (Houston)', quad: 1150, triple: 1530, loading: 1850 },
  CA: { label: 'لوس أنجلوس (Long Beach)', quad: 1600, triple: 2130, loading: 2650 },
};
export const SHIP_TYPES = { quad: 'رباعي (4 بالحاوية)', triple: 'ثلاثي (3 بالحاوية)', loading: 'تحميل' };
// الجمرك بالدينار، ثابت لا يتأثر بسعر الصرف
export const CUSTOMS = [
  ['ساحلي · 4 بالحاوية — موديل 2022 وأقدم', 1800], ['ساحلي · 3 بالحاوية — موديل 2022 وأقدم', 2235], ['رباعي · 3 بالحاوية — موديل 2022 وأقدم', 2535],
  ['ساحلي · 4 بالحاوية — موديل 2023 وأحدث', 2800], ['ساحلي · 3 بالحاوية — موديل 2023 وأحدث', 3200], ['رباعي · 3 بالحاوية — موديل 2023 وأحدث', 4585],
];
export const defaultCustomsIdx = (year) => (year >= 2023 ? 3 : 0);

// ------------------------------------------------------------ الإعدادات (لكل مستخدم في متصفحه)
const KEY = 'ggm_calc_settings';
/** أسعار الشركة الافتراضية — وهي نفسها في الحاسبة العامة (/calc) التي لا يغيّرها الزائر */
export const defaultSettings = () => ({ exchange: 8.4, transferPct: 3, wire: 3, ports: structuredClone(PORTS) });
export function loadSettings() {
  const s = defaultSettings();
  try { Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* التخزين غير متاح */ }
  return s;
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* */ }
}

// ------------------------------------------------------------ الساحات
// هامش الشركة على سعر النقل الداخلي في ملحق الوسيط
export const TOWING_MARGIN = 50;
const yardObj = (platform) => ([state, port, city, name, towing]) => ({ platform, state, port, city, name, towing: towing + TOWING_MARGIN });
export const YARDS = { COPART: COPART_YARDS.map(yardObj('COPART')), IAAI: IAAI_YARDS.map(yardObj('IAAI')) };

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|—.*$|\b(iaa|iaai|copart)\b/g, '').replace(/^[a-z]{2}\s*-\s*/, '').replace(/[^a-z]/g, '');
/** يطابق ساحة اللوت: باسم الفرع أولًا، ثم المدينة داخل الولاية */
export function findYard(platform, { usState, city, branch } = {}) {
  const list = YARDS[platform === 'COPART' ? 'COPART' : 'IAAI'];
  const b = norm(branch), c = norm(city);
  return (b && list.find((y) => norm(y.name) === b))
    || list.find((y) => (!usState || y.state === usState) && c && (norm(y.city) === c || norm(y.name) === c))
    || null;
}

export const isCleanTitle = (doc) => /CLEAN|CLEAR|ORIGINAL|CERTIFICATE OF TITLE/i.test(doc || '') && !/SALVAGE|REBUILD|PARTS|JUNK/i.test(doc || '');

// ------------------------------------------------------------ الحساب
/**
 * i: { platform: 'COPART'|'IAAI', clean, live, bid, towing, port, shipType, customsLYD, sublot, titleIssue }
 * s: الإعدادات { exchange, transferPct, wire, ports }
 */
export function estimate(i, s) {
  const bid = Number(i.bid) || 0;
  const copart = i.platform === 'COPART';
  const cleanFees = copart && i.clean;
  const buyerFee = bid <= 0 ? 0 : bid >= 15000 ? Math.round(bid * (cleanFees ? 0.0575 : 0.06)) : tier(cleanFees ? BUYER_CLEAN_COPART : BUYER_NONCLEAN, bid);
  const bidFee = bid < 100 ? 0 : BID_FEE[cleanFees ? 'clean' : 'nonclean'][i.live ? 'live' : 'pre'][BID_FEE_STEPS.findIndex((m) => bid <= m)];
  const gateFee = copart ? (i.clean ? 79 : 95) : 105;
  const envFee = 15, titleFee = 20, brokerFee = copart ? 0 : 50;
  const commission = bid <= 0 ? 0 : bid <= 10000 ? 100 : bid <= 20000 ? 150 : Math.round(bid * 0.01);
  const pct = (Number(s.transferPct) || 0) / 100;

  // المرحلة 1: يُدفع عند الشراء
  const auctionBill = bid + buyerFee + bidFee + gateFee + envFee + titleFee + brokerFee;
  const invoiceTransfer = auctionBill * pct;
  const payNow = auctionBill + commission + (Number(s.wire) || 0) + invoiceTransfer;
  // المرحلة 2: يُدفع عند وصول السيارة لميناء الوسيط
  const shipping = (s.ports[i.port] || PORTS[i.port] || {})[i.shipType] || 0;
  const shippingTotal = (Number(i.towing) || 0) + shipping + (Number(i.sublot) || 0) + (Number(i.titleIssue) || 0);
  const shipTransfer = shippingTotal * pct;
  const shipUSD = shippingTotal + shipTransfer;
  const exchange = Number(s.exchange) || 0;
  const customsLYD = Number(i.customsLYD) || 0;
  const totalUSD = payNow + shipUSD;
  return {
    bid, buyerFee, bidFee, gateFee, envFee, titleFee, brokerFee, auctionBill, commission, wire: Number(s.wire) || 0, invoiceTransfer, payNow,
    towing: Number(i.towing) || 0, shipping, sublot: Number(i.sublot) || 0, titleIssue: Number(i.titleIssue) || 0, shipTransfer, shipUSD,
    customsLYD, exchange, totalUSD, totalLYD: totalUSD * exchange + customsLYD, onArrivalLYD: shipUSD * exchange + customsLYD,
  };
}

/** تقدير سريع للوت في «مزادات أمريكا» بسعر معيّن، بدون جمرك (الافتراضيات: مزايدة مسبقة، حاوية رباعية) */
export function estimateLot(w, bid, s = loadSettings()) {
  const platform = w.source === 'COPART' ? 'COPART' : 'IAAI';
  const yard = findYard(platform, { usState: w.us_state, city: w.city, branch: w.branch });
  const e = estimate({ platform, clean: isCleanTitle(w.title_doc), live: false, bid, towing: yard?.towing || 0, port: yard?.port || 'NJ', shipType: 'quad', customsLYD: 0 }, s);
  return { ...e, yard };
}
