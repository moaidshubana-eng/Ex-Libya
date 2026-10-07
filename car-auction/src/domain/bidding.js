// قواعد المزايدة — دوال نقية (بلا قاعدة بيانات) لتكون قابلة للاختبار بدقة.
import { toMillis, fromMillis } from './money.js';

// جدول الزيادة الدنيا بالدينار حسب السعر الحالي
export const INCREMENT_TIERS = [
  { below: 10_000, step: 100 },
  { below: 50_000, step: 250 },
  { below: 100_000, step: 500 },
  { below: Infinity, step: 1_000 },
];

export function minIncrement(price) {
  const p = Number(price);
  return INCREMENT_TIERS.find((t) => p < t.below).step;
}

/** أقل مبلغ مقبول للمزايدة التالية */
export function nextMinimumBid(lot) {
  if (!lot.bid_count || lot.current_price == null) return fromMillis(toMillis(lot.starting_price));
  return fromMillis(toMillis(lot.current_price) + toMillis(minIncrement(lot.current_price)));
}

export class BidRejected extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * التحقق من مزايدة يدوية. يرمي BidRejected برمز مفهوم للواجهة.
 * @param {object} p
 * @param {object} p.lot صف auction_lots (بعد قفله FOR UPDATE)
 * @param {string} p.amount
 * @param {string} p.customerId
 * @param {object|null} p.registration صف bidder_registrations
 * @param {Date} p.now وقت الخادم (لا وقت العميل أبدًا)
 */
export function validateBid({ lot, amount, customerId, registration, now }) {
  if (lot.status !== 'OPEN') throw new BidRejected('LOT_NOT_OPEN', 'المزاد على هذه السيارة غير مفتوح');
  if (now < new Date(lot.starts_at)) throw new BidRejected('LOT_NOT_STARTED', 'لم يبدأ المزاد بعد');
  if (now >= new Date(lot.ends_at)) throw new BidRejected('LOT_ENDED', 'انتهى وقت المزاد');
  if (!registration) throw new BidRejected('NOT_REGISTERED', 'العميل غير مسجل في هذا المزاد');
  if (registration.deposit_status !== 'HELD')
    throw new BidRejected('DEPOSIT_REQUIRED', 'يجب إيداع التأمين واعتماده قبل المزايدة');
  if (lot.leading_customer_id === customerId)
    throw new BidRejected('ALREADY_LEADING', 'أنت صاحب أعلى مزايدة حاليًا — استخدم المزايدة الآلية لرفع حدك');
  let a;
  try {
    a = toMillis(amount);
  } catch {
    throw new BidRejected('INVALID_AMOUNT', 'مبلغ غير صالح');
  }
  if (a % 1000n !== 0n) throw new BidRejected('INVALID_AMOUNT', 'المزايدة بالدينار الصحيح فقط');
  const min = nextMinimumBid(lot);
  if (a < toMillis(min)) throw new BidRejected('BELOW_MINIMUM', `أقل مزايدة مقبولة ${Number(min).toLocaleString('en-US')} د.ل`, { minimum: min });
  // حماية من الأخطاء المطبعية (صفر زائد): رفض ما يزيد عن 10 أضعاف السعر الحالي
  const ref = toMillis(lot.current_price ?? lot.starting_price);
  if (a > ref * 10n) throw new BidRejected('AMOUNT_TOO_HIGH', 'المبلغ أعلى من المعقول — تأكد من عدد الأصفار');
}

/**
 * منع "القنص" في اللحظة الأخيرة: إن وصلت مزايدة خلال آخر windowSec ثانية،
 * يُمدَّد الوقت ليصبح extensionSec ثانية من لحظة المزايدة.
 */
export function extendForAntiSnipe(endsAt, now, windowSec, extensionSec) {
  const end = new Date(endsAt).getTime();
  const t = now.getTime();
  if (windowSec > 0 && end - t <= windowSec * 1000) {
    return new Date(Math.max(end, t + extensionSec * 1000));
  }
  return new Date(end);
}

/**
 * حل المزايدات الآلية (Proxy) بعد أي تغيير في السعر — منطق "ثاني أعلى سعر + زيادة":
 * الفائز هو صاحب أعلى حد، ويدفع أقل مبلغ يكفي لتجاوز ثاني أعلى منافس.
 * عند التساوي في الحد يفوز الأسبق تسجيلًا.
 *
 * @param {object} p
 * @param {object} p.lot { starting_price, current_price, bid_count, leading_customer_id }
 * @param {{customer_id:string, max_amount:string, created_at:string|Date}[]} p.proxies
 * @returns {{customer_id:string, amount:string}[]} المزايدات الآلية الواجب تسجيلها بالترتيب
 */
export function resolveProxyBids({ lot, proxies }) {
  const hasBids = lot.bid_count > 0 && lot.current_price != null;
  const price = hasBids ? toMillis(lot.current_price) : null;
  const leader = hasBids ? lot.leading_customer_id : null;

  // سقف كل مشارك: حد المزايدة الآلية، والقائد الحالي سقفه على الأقل سعره الحالي
  const ceil = new Map();
  for (const p of proxies) ceil.set(p.customer_id, { max: toMillis(p.max_amount), at: new Date(p.created_at).getTime() });
  if (leader) {
    const c = ceil.get(leader);
    if (!c || c.max < price) ceil.set(leader, { max: price, at: -Infinity }); // صاحب السعر الحالي أسبق من أي حد لاحق
  }

  const ranked = [...ceil.entries()]
    .map(([customer_id, v]) => ({ customer_id, ...v }))
    .sort((a, b) => (b.max > a.max ? 1 : b.max < a.max ? -1 : a.at - b.at));
  if (!ranked.length) return [];

  const required = hasBids ? price + toMillis(minIncrement(fromMillis(price))) : toMillis(lot.starting_price);
  const winner = ranked[0];
  const runner = ranked[1];

  if (!hasBids) {
    // لا مزايدات بعد: يبدأ الفائز بالسعر الابتدائي أو بما يكفي لتجاوز المنافس الثاني
    if (winner.max < required) return [];
    let amount = required;
    const out = [];
    if (runner && runner.max >= required) {
      const beat = runner.max + toMillis(minIncrement(fromMillis(runner.max)));
      amount = beat < winner.max ? beat : winner.max;
      if (runner.max < amount) out.push({ customer_id: runner.customer_id, amount: fromMillis(runner.max) });
    }
    out.push({ customer_id: winner.customer_id, amount: fromMillis(amount) });
    return out;
  }

  if (winner.customer_id === leader) {
    // القائد يبقى قائدًا؛ يرتفع سعره فقط إن كان هناك منافس آلي يتجاوز السعر الحالي
    if (!runner || runner.max < required) return [];
    const beat = runner.max + toMillis(minIncrement(fromMillis(runner.max)));
    const amount = beat < winner.max ? beat : winner.max;
    const out = [];
    if (runner.max > price && runner.max < amount) out.push({ customer_id: runner.customer_id, amount: fromMillis(runner.max) });
    if (amount > price) out.push({ customer_id: winner.customer_id, amount: fromMillis(amount) });
    return out;
  }

  // منافس آلي يتفوق على القائد الحالي
  if (winner.max < required) return [];
  const runnerMax = runner ? runner.max : price;
  const beat = runnerMax + toMillis(minIncrement(fromMillis(runnerMax)));
  let amount = beat < winner.max ? beat : winner.max;
  if (amount < required) amount = required;
  const out = [];
  if (runner && runner.customer_id !== leader && runner.max > price && runner.max < amount)
    out.push({ customer_id: runner.customer_id, amount: fromMillis(runner.max) });
  else if (runner && runner.customer_id === leader && runner.max > price && runner.max < amount)
    out.push({ customer_id: leader, amount: fromMillis(runner.max) });
  out.push({ customer_id: winner.customer_id, amount: fromMillis(amount) });
  return out;
}

/** نتيجة إغلاق اللوت عند انتهاء الوقت */
export function closingOutcome(lot) {
  if (!lot.bid_count || lot.current_price == null) return { sold: false, reason: 'NO_BIDS' };
  if (lot.reserve_price != null && toMillis(lot.current_price) < toMillis(lot.reserve_price))
    return { sold: false, reason: 'RESERVE_NOT_MET' };
  return { sold: true, reason: 'SOLD', winner: lot.leading_customer_id, price: lot.current_price };
}
