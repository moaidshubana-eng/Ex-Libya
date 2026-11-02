import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, findYard, isCleanTitle, estimateLot, PORTS } from '../../public/js/calc.js';

const S = { exchange: 8.4, transferPct: 3, wire: 3, ports: PORTS };
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} ≠ ${b}`);

describe('حاسبة التكلفة حتى ليبيا', () => {
  test('Copart بأضرار، مزايدة مسبقة 2,150$، نقل 675$، نيوجيرسي رباعي، جمرك 2,800', () => {
    const e = estimate({ platform: 'COPART', clean: false, live: false, bid: 2150, towing: 675, port: 'NJ', shipType: 'quad', customsLYD: 2800 }, S);
    assert.deepEqual([e.buyerFee, e.bidFee, e.gateFee, e.brokerFee, e.commission], [390, 100, 95, 0, 100]);
    assert.equal(e.auctionBill, 2770);
    near(e.payNow, 2956.1);
    near(e.shipUSD, 1776.75);
    near(e.totalUSD, 4732.85);
    near(e.totalLYD, 42555.94);
  });

  test('IAAI شراء فوري 3,575$ من Orlando-North (جورجيا)، جمرك 1,800', () => {
    const e = estimate({ platform: 'IAAI', bid: 3575, towing: 400, port: 'GA', shipType: 'quad', customsLYD: 1800 }, S);
    assert.deepEqual([e.buyerFee, e.bidFee, e.gateFee, e.brokerFee], [555, 100, 105, 50]);
    assert.equal(e.auctionBill, 4420);
    near(e.payNow, 4655.6);
    near(e.totalLYD, 53452.44);
  });

  test('الأسعار الكبيرة: نسبة عمولة، رسوم Live، عمولة المزايدة 150', () => {
    const e = estimate({ platform: 'COPART', clean: true, live: true, bid: 16000, port: 'TX', shipType: 'triple' }, S);
    assert.deepEqual([e.buyerFee, e.bidFee, e.gateFee, e.commission, e.shipping], [920, 149, 79, 150, 1530]);
    assert.equal(estimate({ platform: 'IAAI', bid: 50 }, S).bidFee, 0);
    assert.equal(estimate({ platform: 'IAAI', bid: 0 }, S).buyerFee, 0);
  });

  test('مطابقة الساحة من بيانات اللوت', () => {
    assert.equal(findYard('IAAI', { usState: 'FL', city: 'Orlando', branch: 'Orlando-North (FL)' }).name, 'Orlando-North IAA');
    assert.equal(findYard('COPART', { usState: 'NY', city: 'Rochester', branch: 'NY - Rochester — Lane A-48' }).towing, 525);
    assert.equal(findYard('IAAI', { usState: 'TX', city: 'Lubbock', branch: 'Lubbock (TX) — Lane A-93' }).port, 'TX');
    assert.equal(findYard('COPART', { usState: 'IN', city: 'Fort Wayne', branch: 'IN - Fort Wayne' }).towing, 675);
    assert.equal(findYard('IAAI', { usState: 'ZZ', city: 'Nowhere' }), null);
  });

  test('نوع الملكية والتقدير السريع للوت', () => {
    assert.equal(isCleanTitle('CLEAN - CERTIFICATE OF TITLE (MI)'), true);
    assert.equal(isCleanTitle('SALVAGE (TX)'), false);
    assert.equal(isCleanTitle('REBUILDABLE (FL)'), false);
    const e = estimateLot({ source: 'COPART', us_state: 'IN', city: 'Fort Wayne', branch: 'IN - Fort Wayne', title_doc: 'CLEAN - CERTIFICATE OF TITLE (MI)', year: 2023 }, 2150, S);
    assert.equal(e.yard.name, 'Fort Wayne Copart');
    assert.equal(e.customsLYD, 0); // تقدير البطاقات بدون جمرك
    near(e.totalLYD, e.totalUSD * 8.4);
    assert.equal(e.gateFee, 79);
  });
});
