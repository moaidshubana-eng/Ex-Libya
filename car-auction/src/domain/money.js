// حساب نقدي دقيق: كل المبالغ تُعالج داخليًا كأعداد صحيحة بوحدة "المِلّيم"
// (1/1000 دينار) لتجنب أخطاء التقريب في الأعداد العشرية (0.1 + 0.2).

const SCALE = 1000n;

/** يحوّل قيمة نصية/رقمية إلى BigInt بوحدة 1/1000 */
export function toMillis(value) {
  if (typeof value === 'bigint') return value * SCALE;
  const s = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`مبلغ غير صالح: ${value}`);
  const neg = s.startsWith('-');
  const [int, frac = ''] = s.replace('-', '').split('.');
  // تقريب نصف لأعلى على المنزلة الرابعة
  const f4 = (frac + '0000').slice(0, 4);
  let m = BigInt(int) * SCALE + BigInt(f4.slice(0, 3));
  if (Number(f4[3]) >= 5) m += 1n;
  return neg ? -m : m;
}

export function fromMillis(m) {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const s = `${a / SCALE}.${String(a % SCALE).padStart(3, '0')}`;
  return neg ? `-${s}` : s;
}

/** amount × rate مقربًا إلى 3 منازل (يطابق round(amount*fx,3) في PostgreSQL) */
export function convert(amount, rate) {
  const a = toMillis(amount); // ×1000
  const r = toRate(rate); // ×1e6
  const prod = a * r; // ×1e9
  const q = prod / 1_000_000n;
  const rem = prod % 1_000_000n;
  const absRem = rem < 0n ? -rem : rem;
  const rounded = absRem * 2n >= 1_000_000n ? q + (prod < 0n ? -1n : 1n) : q;
  return fromMillis(rounded);
}

function toRate(rate) {
  const s = String(rate);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`سعر صرف غير صالح: ${rate}`);
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

export function sum(values) {
  return fromMillis(values.reduce((acc, v) => acc + toMillis(v), 0n));
}

/**
 * توزيع تكلفة مشتركة (أجرة حاوية مثلًا) على عدة سيارات بدقة تامة:
 * مجموع الحصص يساوي الإجمالي بالضبط، والفرق الناتج عن التقريب يذهب
 * للسيارات ذات الكسر الأكبر (طريقة الباقي الأكبر — Largest remainder).
 * @param {string|number} total
 * @param {{id:string, weight?:string|number}[]} items
 * @param {'EQUAL'|'BY_PURCHASE_VALUE'} method
 * @returns {{id:string, amount:string}[]}
 */
export function allocate(total, items, method = 'EQUAL') {
  if (!items.length) throw new Error('لا توجد سيارات للتوزيع عليها');
  const t = toMillis(total);
  const weights = items.map((it) => (method === 'EQUAL' ? 1n : toMillis(it.weight ?? 0)));
  const wSum = weights.reduce((a, b) => a + b, 0n);
  if (wSum <= 0n) throw new Error('مجموع الأوزان صفر — لا يمكن التوزيع حسب القيمة');
  const base = weights.map((w) => (t * w) / wSum);
  const rema = weights.map((w, i) => ({ i, r: (t * w) % wSum }));
  let left = t - base.reduce((a, b) => a + b, 0n);
  rema.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (let k = 0; left > 0n; k++, left--) base[rema[k % rema.length].i] += 1n;
  return items.map((it, i) => ({ id: it.id, amount: fromMillis(base[i]) }));
}

export function cmp(a, b) {
  const x = toMillis(a), y = toMillis(b);
  return x === y ? 0 : x > y ? 1 : -1;
}
