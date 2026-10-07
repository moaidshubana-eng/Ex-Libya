import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toMillis, fromMillis, convert, allocate, sum } from '../../src/domain/money.js';
import { minIncrement, nextMinimumBid, validateBid, extendForAntiSnipe, resolveProxyBids, closingOutcome, BidRejected } from '../../src/domain/bidding.js';
import { canTransition, manualNextStatuses, forwardPath, TRANSITIONS, STATUS_CODES } from '../../src/domain/status.js';
import { checkDigit, vinError, makeVin } from '../../src/domain/vin.js';

describe('money — حساب نقدي دقيق', () => {
  test('لا أخطاء تقريب عشري (0.1 + 0.2)', () => {
    assert.equal(sum(['0.1', '0.2']), '0.300');
  });
  test('التحويل يطابق round(amount*fx, 3) في PostgreSQL', () => {
    assert.equal(convert('8450', '5.5321'), '46746.245');
    assert.equal(convert('0.005', '1'), '0.005');
    assert.equal(convert('1.0005', '1'), '1.001'); // تقريب نصف لأعلى
  });
  test('toMillis/fromMillis ذهابًا وإيابًا', () => {
    assert.equal(fromMillis(toMillis('12345.678')), '12345.678');
    assert.equal(fromMillis(toMillis('-3.5')), '-3.500');
    assert.throws(() => toMillis('12abc'));
  });
  test('التوزيع بالتساوي: مجموع الحصص = الإجمالي بالضبط', () => {
    const shares = allocate('4999.999', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    assert.equal(sum(shares.map((s) => s.amount)), '4999.999');
    const amounts = shares.map((s) => toMillis(s.amount));
    assert.ok(amounts.every((a) => a >= 1666666n && a <= 1666667n));
  });
  test('التوزيع حسب القيمة يحترم الأوزان', () => {
    const shares = allocate('1000', [{ id: 'a', weight: '30000' }, { id: 'b', weight: '10000' }], 'BY_PURCHASE_VALUE');
    assert.deepEqual(shares, [{ id: 'a', amount: '750.000' }, { id: 'b', amount: '250.000' }]);
  });
  test('التوزيع يرفض قائمة فارغة وأوزانًا صفرية', () => {
    assert.throws(() => allocate('100', []));
    assert.throws(() => allocate('100', [{ id: 'a', weight: 0 }], 'BY_PURCHASE_VALUE'));
  });
});

describe('bidding — قواعد المزايدة', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const baseLot = {
    status: 'OPEN', starts_at: '2026-10-07T10:00:00Z', ends_at: '2026-10-07T13:00:00Z',
    starting_price: '20000.000', current_price: '25000.000', bid_count: 3, leading_customer_id: 'X', reserve_price: '30000.000',
  };
  const reg = { deposit_status: 'HELD' };
  const reject = (fn, code) => assert.throws(fn, (e) => e instanceof BidRejected && e.code === code);

  test('جدول الزيادة الدنيا', () => {
    assert.equal(minIncrement(9_999), 100);
    assert.equal(minIncrement(10_000), 250);
    assert.equal(minIncrement(50_000), 500);
    assert.equal(minIncrement(150_000), 1000);
  });
  test('أول مزايدة = سعر الافتتاح، وما بعدها = السعر + الزيادة', () => {
    assert.equal(nextMinimumBid({ ...baseLot, bid_count: 0, current_price: null }), '20000.000');
    assert.equal(nextMinimumBid(baseLot), '25250.000');
  });
  test('قبول مزايدة صحيحة', () => {
    assert.doesNotThrow(() => validateBid({ lot: baseLot, amount: '25250', customerId: 'Y', registration: reg, now }));
  });
  test('رفض: أقل من الحد الأدنى', () => reject(() => validateBid({ lot: baseLot, amount: '25249', customerId: 'Y', registration: reg, now }), 'BELOW_MINIMUM'));
  test('رفض: كسور الدينار', () => reject(() => validateBid({ lot: baseLot, amount: '25300.5', customerId: 'Y', registration: reg, now }), 'INVALID_AMOUNT'));
  test('رفض: صاحب أعلى مزايدة يزايد على نفسه', () => reject(() => validateBid({ lot: baseLot, amount: '26000', customerId: 'X', registration: reg, now }), 'ALREADY_LEADING'));
  test('رفض: بلا تسجيل أو بلا تأمين', () => {
    reject(() => validateBid({ lot: baseLot, amount: '26000', customerId: 'Y', registration: null, now }), 'NOT_REGISTERED');
    reject(() => validateBid({ lot: baseLot, amount: '26000', customerId: 'Y', registration: { deposit_status: 'PENDING' }, now }), 'DEPOSIT_REQUIRED');
  });
  test('رفض: بعد انتهاء الوقت أو لوت مغلق', () => {
    reject(() => validateBid({ lot: baseLot, amount: '26000', customerId: 'Y', registration: reg, now: new Date('2026-10-07T13:00:00Z') }), 'LOT_ENDED');
    reject(() => validateBid({ lot: { ...baseLot, status: 'CLOSED_SOLD' }, amount: '26000', customerId: 'Y', registration: reg, now }), 'LOT_NOT_OPEN');
  });
  test('رفض: مبلغ مبالغ فيه (صفر زائد)', () => reject(() => validateBid({ lot: baseLot, amount: '2525000', customerId: 'Y', registration: reg, now }), 'AMOUNT_TOO_HIGH'));

  test('منع القنص: مزايدة في آخر دقيقتين تمدد الوقت', () => {
    const end = '2026-10-07T12:01:00Z';
    assert.equal(extendForAntiSnipe(end, now, 120, 120).toISOString(), '2026-10-07T12:02:00.000Z');
    assert.equal(extendForAntiSnipe('2026-10-07T12:30:00Z', now, 120, 120).toISOString(), '2026-10-07T12:30:00.000Z');
  });

  test('المزايدة الآلية: المنافس الآلي يتجاوز القائد بأقل زيادة', () => {
    const auto = resolveProxyBids({ lot: baseLot, proxies: [{ customer_id: 'P', max_amount: '40000', created_at: now }] });
    assert.deepEqual(auto, [{ customer_id: 'P', amount: '25250.000' }]);
  });
  test('المزايدة الآلية: حدّان آليان — الأعلى يفوز بسعر الثاني + زيادة', () => {
    const auto = resolveProxyBids({
      lot: baseLot,
      proxies: [{ customer_id: 'P', max_amount: '40000', created_at: '2026-10-07T11:00:00Z' }, { customer_id: 'Q', max_amount: '32000', created_at: '2026-10-07T11:05:00Z' }],
    });
    assert.deepEqual(auto, [{ customer_id: 'Q', amount: '32000.000' }, { customer_id: 'P', amount: '32250.000' }]);
  });
  test('المزايدة الآلية: التساوي في الحد يفوز فيه الأسبق دون مزايدة مكررة', () => {
    const auto = resolveProxyBids({
      lot: baseLot,
      proxies: [{ customer_id: 'Q', max_amount: '30000', created_at: '2026-10-07T11:05:00Z' }, { customer_id: 'P', max_amount: '30000', created_at: '2026-10-07T11:00:00Z' }],
    });
    assert.deepEqual(auto, [{ customer_id: 'P', amount: '30000.000' }]);
  });
  test('المزايدة الآلية: حد القائد يرد على منافس آلي', () => {
    const auto = resolveProxyBids({
      lot: baseLot,
      proxies: [{ customer_id: 'X', max_amount: '35000', created_at: '2026-10-07T10:30:00Z' }, { customer_id: 'Q', max_amount: '28000', created_at: '2026-10-07T11:05:00Z' }],
    });
    assert.deepEqual(auto, [{ customer_id: 'Q', amount: '28000.000' }, { customer_id: 'X', amount: '28250.000' }]);
  });
  test('المزايدة الآلية: حد أقل من المطلوب لا يُنتج مزايدة', () => {
    assert.deepEqual(resolveProxyBids({ lot: baseLot, proxies: [{ customer_id: 'P', max_amount: '25100', created_at: now }] }), []);
  });
  test('المزايدة الآلية: لوت بلا مزايدات يبدأ بسعر الافتتاح', () => {
    const lot = { ...baseLot, bid_count: 0, current_price: null, leading_customer_id: null };
    assert.deepEqual(resolveProxyBids({ lot, proxies: [{ customer_id: 'P', max_amount: '30000', created_at: now }] }), [{ customer_id: 'P', amount: '20000.000' }]);
  });
  test('المزايدات الآلية الناتجة متصاعدة بصرامة', () => {
    for (let i = 0; i < 300; i++) {
      const price = 5000 + Math.floor(Math.random() * 90000);
      const lot = { ...baseLot, current_price: String(price), starting_price: '5000', leading_customer_id: 'L' };
      const proxies = ['A', 'B', 'C', 'L'].map((c, k) => ({ customer_id: c, max_amount: String(price + Math.floor(Math.random() * 20000) - 5000), created_at: new Date(1000 + k) })).filter((p) => Number(p.max_amount) > 0);
      const auto = resolveProxyBids({ lot, proxies });
      let last = price;
      for (const b of auto) {
        assert.ok(Number(b.amount) > last, `غير متصاعد: ${JSON.stringify({ price, proxies, auto })}`);
        last = Number(b.amount);
        const p = proxies.find((x) => x.customer_id === b.customer_id);
        assert.ok(!p || Number(b.amount) <= Number(p.max_amount) || b.customer_id === 'L', 'تجاوز الحد الأقصى');
      }
    }
  });

  test('إغلاق اللوت: الحد الأدنى السري', () => {
    assert.equal(closingOutcome(baseLot).reason, 'RESERVE_NOT_MET');
    assert.equal(closingOutcome({ ...baseLot, current_price: '30000' }).sold, true);
    assert.equal(closingOutcome({ ...baseLot, bid_count: 0, current_price: null }).reason, 'NO_BIDS');
    assert.equal(closingOutcome({ ...baseLot, reserve_price: null }).sold, true);
  });
});

describe('status — دورة حياة السيارة', () => {
  test('انتقالات المسار الطبيعي مسموحة', () => {
    assert.ok(canTransition('PURCHASED', 'AWAITING_PICKUP'));
    assert.ok(canTransition('IN_CUSTOMS', 'CUSTOMS_CLEARED'));
    assert.ok(canTransition('SOLD', 'DELIVERED'));
  });
  test('القفز والرجوع ممنوعان', () => {
    assert.ok(!canTransition('PURCHASED', 'IN_STOCK'));
    assert.ok(!canTransition('IN_CUSTOMS', 'AT_PORT_LIBYA'));
    assert.ok(!canTransition('DELIVERED', 'SOLD'));
  });
  test('التعليق ورفعه يعيد للحالة السابقة فقط', () => {
    assert.ok(canTransition('IN_CUSTOMS', 'ON_HOLD'));
    assert.ok(!canTransition('SOLD', 'ON_HOLD'));
    assert.ok(canTransition('ON_HOLD', 'IN_CUSTOMS', 'IN_CUSTOMS'));
    assert.ok(!canTransition('ON_HOLD', 'IN_STOCK', 'IN_CUSTOMS'));
  });
  test('الأزرار اليدوية لا تتضمن حالات النظام (مزايدة/بيع)', () => {
    assert.deepEqual(manualNextStatuses('IN_STOCK'), ['ON_HOLD']);
    assert.ok(!manualNextStatuses('IN_TRANSIT_SEA').includes('SOLD'));
  });
  test('المسار الأمامي للمزامنة يمر بكل الخطوات الوسيطة', () => {
    assert.deepEqual(forwardPath('PURCHASED', 'AT_US_WAREHOUSE'), ['AWAITING_PICKUP', 'US_INLAND_TRANSIT', 'AT_US_WAREHOUSE']);
    assert.equal(forwardPath('IN_STOCK', 'PURCHASED'), null);
  });
  test('كل الحالات معرّفة في جدول الانتقالات', () => {
    for (const s of STATUS_CODES) assert.ok(s in TRANSITIONS, s);
  });
});

describe('vin — رقم الهيكل', () => {
  test('خانة التحقق لـ VIN حقيقي معروف', () => {
    assert.equal(checkDigit('1M8GDM9AXKP042788'), 'X');
    assert.equal(vinError('1M8GDM9AXKP042788'), null);
  });
  test('رفض الأحرف الممنوعة والطول الخاطئ وخانة التحقق الخاطئة', () => {
    assert.match(vinError('1HGCM82633A00435'), /صيغة/);
    assert.match(vinError('INVALIDVIN0000000'), /صيغة/);
    assert.match(vinError('1M8GDM9A1KP042788'), /خانة التحقق/);
  });
  test('المولّد التجريبي ينتج VIN صالحًا دائمًا', () => {
    for (let i = 0; i < 200; i++) assert.equal(vinError(makeVin('4T1G11AK', 'K', '5', 100000 + i * 37)), null);
  });
});
