import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLotText, bookmarkletHref, decodeImport } from '../../public/js/lot-grabber.js';

// نصوص حقيقية مختصرة كما يعرضها المتصفح (innerText) في صفحات السيارات
const IAAI = {
  host: 'iaai.com', href: 'https://www.iaai.com/vehicledetail/46860885~US', title: '2013 MERCEDES-BENZ GL 450 4MATIC for Auction - IAA', h1: '2013 MERCEDES-BENZ GL 450 4MATIC',
  now: Date.parse('2026-11-01T10:00:00Z'),
  text: `VEHICLE INFORMATION
Stock #:
46360606
Selling Branch:
Long Island (NY)
VIN (Status):
4JGDF7CE5DA****** (OK)
Primary Damage:
Normal Wear & Tear
Title/Sale Doc:
CLEAR (New York)
Start Code:
Stationary
Key:
Present
Odometer:
125,506 mi (Actual)
Exterior/Interior:
Gray/ Unknown
Model:
GL 450
Series:
4MATIC
Buy Now Price:
$2,325
Auction Date and Time:
Tue Nov 3, 8:30am (CST)
Actual Cash Value:
$4,650 USD`,
};

const COPART = {
  host: 'copart.com', href: 'https://www.copart.com/lot/69512996/salvage-2016-kia-forte-lx-ny-rochester', title: '2016 KIA FORTE LX | Run and Drive | Nov 02, 2026 | NY - ROCHESTER | Copart', h1: '2016 KIA FORTE LX',
  text: `Current bid
$0
2016 KIA FORTE LX
Run and Drive
VIN:KNAFK4A64G5******
Lot number:69512996
Location:
NY - ROCHESTER
Engine starts
Title code:
NY -
Mv-907a Salvage Certificate
Odometer:
76,003 mi
Not Actual
Primary damage:
Vandalism
Estimated retail value:
$6,738.00USD
Color:
Blue
Has key:
Yes
Sale date:
Mon. Nov 02, 2026 05:00 PM GMT+2
Highlights:
Run and Drive`,
};

const BIDCARS = {
  host: 'bid.cars', href: 'https://bid.cars/en/lot/0-46464939/2017-BMW-X6-5UXKU2C59H0N85266', title: '2017 BMW X6, Xdrive35I | 5UXKU2C59H0N85266 | Bid History | BidCars', h1: '5UXKU2C59H0N85266',
  text: `2017 BMW X6, XDRIVE35I
5UXKU2C59H0N85266
0-46464939
IAAI
Location:
Avenel New Jersey (NJ)
Sale Document:
Clear (New jersey)
Auction Date Lot # Final bid Odometer Status Seller
IAAI 2026-11-02 0-46464939 $5,100 116 106 mi Sold Wheelzy`,
};

describe('قارئ صفحة المزاد (زر الاستيراد)', () => {
  test('IAAI: كل الحقول، والموعد CST يتحوّل لـ UTC', () => {
    const d = parseLotText(IAAI);
    assert.equal(d.source, 'IAAI');
    assert.equal(d.lot_number, '46360606');
    assert.equal(d.vin, '4JGDF7CE5DA******');
    assert.deepEqual([d.year, d.make, d.model, d.trim], [2013, 'MERCEDES-BENZ', 'GL 450', '4MATIC']);
    assert.equal(d.odometer, 125506);
    assert.equal(d.primary_damage, 'Normal Wear & Tear');
    assert.equal(d.title_doc, 'CLEAR (New York)');
    assert.equal(d.run_status, 'STATIONARY');
    assert.equal(d.has_keys, true);
    assert.deepEqual([d.us_state, d.city, d.branch], ['NY', 'Long Island', 'Long Island (NY)']);
    assert.equal(d.auction_at, '2026-11-03T14:30:00.000Z'); // 8:30 CST = 14:30 UTC
    assert.equal(d.buy_now_usd, '2325');
    assert.equal(d.est_value_usd, '4650');
    assert.match(d.notes, /اللون: Gray/);
  });

  test('Copart: الملكية على سطرين، العداد غير المؤكد، وGMT+2', () => {
    const d = parseLotText(COPART);
    assert.equal(d.source, 'COPART');
    assert.equal(d.lot_number, '69512996');
    assert.equal(d.vin, 'KNAFK4A64G5******');
    assert.deepEqual([d.year, d.make, d.model, d.trim], [2016, 'KIA', 'FORTE', 'LX']);
    assert.equal(d.odometer, 76003);
    assert.equal(d.title_doc, 'NY - Mv-907a Salvage Certificate');
    assert.equal(d.primary_damage, 'Vandalism');
    assert.equal(d.run_status, 'RUN_DRIVE');
    assert.equal(d.has_keys, true);
    assert.deepEqual([d.us_state, d.city], ['NY', 'ROCHESTER']);
    assert.equal(d.auction_at, '2026-11-02T15:00:00.000Z'); // 17:00 GMT+2
    assert.equal(d.est_value_usd, '6738');
    assert.equal(d.current_bid_usd, undefined); // $0 يعني لا مزايدة
    assert.match(d.notes, /غير مؤكد/);
  });

  test('bid.cars: رقم الهيكل كاملًا، والمزاد من بادئة اللوت، والعداد بمسافات', () => {
    const d = parseLotText(BIDCARS);
    assert.equal(d.source, 'IAAI');
    assert.equal(d.lot_number, '46464939');
    assert.equal(d.vin, '5UXKU2C59H0N85266');
    assert.deepEqual([d.year, d.make, d.model, d.trim], [2017, 'BMW', 'X6', 'XDRIVE35I']);
    assert.equal(d.odometer, 116106);
    assert.equal(d.us_state, 'NJ');
    assert.equal(d.title_doc, 'Clear (New jersey)');
  });

  test('صفحة غير مدعومة أو بلا لوت', () => {
    assert.match(parseLotText({ host: 'example.com', text: 'x' }).error, /IAAI/);
    assert.match(parseLotText({ host: 'iaai.com', text: 'nothing here' }).error, /اللوت/);
  });

  test('الـBookmarklet: رابط javascript قابل للتنفيذ، والبيانات ترجع سليمة بالعربي', () => {
    const href = bookmarkletHref('https://golden-gate-motors.onrender.com');
    assert.match(href, /^javascript:/);
    const code = decodeURIComponent(href.slice('javascript:'.length));
    assert.doesNotThrow(() => new Function(code)); // صياغته سليمة
    assert.match(code, /golden-gate-motors\.onrender\.com/);
    // ترميز/فك base64url لنص عربي (كما يفعل الزر والمنظومة)
    const obj = { notes: 'اللون: رمادي — العداد غير مؤكد', lot_number: '46360606' };
    const b = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');
    assert.deepEqual(decodeImport(b), obj);
  });
});
