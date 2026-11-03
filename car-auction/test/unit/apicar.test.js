import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mapApicar, publicCar, lookupVin, apicarEnabled } from '../../src/services/apicar.js';
import { config } from '../../src/config.js';

// عيّنات حقيقية من شكل ردّ apicar (current_lots و history_vin)
const LOT = {
  lot_id: '51423593', auction: 'copart', odometer: 97461, price_buynow: 0, cost_priced: 20519, cost_repair: 20856, year: '2020',
  auction_date: '2023-07-07T17:00:00.000Z', cylinders: '4', state: 'MI', make: 'Mazda', model: 'CX-5', series: 'GRAND TOURING',
  loss: 'COLLISION', damage_first: 'ROLLOVER', damage_second: null, status: 'ENHANCED VEHICLES', keys: 'Yes', odobrand: 'ACTUAL',
  fuel: 'GAS', drive: 'All wheel drive', transmission: 'AUTOMATIC', color: 'BLACK', title: '2020 MAZDA CX-5 GRAND TOURING',
  vin: 'JM3KFBDM8L0729469', engine: '2.5L  4', location: 'MI - IONIA', document: 'MI - SCRAP CERTIFICATE OF TITLE',
  seller: 'State Farm Insurance', images: ['https://cs.copart.com/a.jpg', 'https://cs.copart.com/b.jpg'],
};
const HIST = {
  lot_id: '54560333', auction: 'iaai', odometer: 56934, year: '2016', make: 'Audi', model: 'A4', series: 'PREMIUM',
  loss: 'CDS VEHICLE', damage_first: 'SIDE', damage_second: 'REAR END', keys: 'NO', odobrand: 'ACTUAL', color: 'BLACK',
  title: '2016 Audi A4 PREMIUM', engine: '2.0L  4', vin: 'WAUFFAFL7GN004606', location: 'MO - COLUMBIA', document: 'MI - CERTIFICATE OF TITLE (P)',
  seller: null, link_img_hd: ['https://api.apicar.store/api/car-photos/AAA', 'https://api.apicar.store/api/car-photos/BBB', 'https://api.apicar.store/api/car-photos/CCC'],
};

describe('تطبيع بيانات apicar', () => {
  test('لوت حالي (صور مباشرة)', () => {
    const c = mapApicar(LOT);
    assert.equal(c.source, 'auction');
    assert.equal(c.auction, 'COPART');
    assert.equal(c.vin, 'JM3KFBDM8L0729469');
    assert.equal(c.year, 2020);
    assert.equal(c.make, 'Mazda');
    assert.equal(c.odometer, 97461);
    assert.equal(c.damage, 'ROLLOVER'); // الثانوي null فلا يظهر
    assert.equal(c.titleDoc, 'MI - SCRAP CERTIFICATE OF TITLE');
    assert.equal(c.priceBuyNow, null); // 0 يعني لا شراء فوري
    assert.equal(c.estRetail, 20519);
    assert.equal(c.imageCount, 2);
    assert.equal(c._images[0], 'https://cs.copart.com/a.jpg');
  });

  test('سجل بالـVIN (صور عبر وسيط apicar) و IAA', () => {
    const c = mapApicar(HIST);
    assert.equal(c.auction, 'IAAI');
    assert.equal(c.damage, 'SIDE / REAR END');
    assert.equal(c.seller, null);
    assert.equal(c.imageCount, 3);
    assert.equal(c.keys, 'NO');
  });

  test('publicCar يحذف روابط الصور الداخلية', () => {
    const c = mapApicar(LOT);
    assert.ok(c._images);
    assert.equal(publicCar(c)._images, undefined);
    assert.equal(publicCar(c).imageCount, 2);
    assert.equal(publicCar(null), null);
  });

  test('قيم فارغة/غير متوفرة تصير null', () => {
    const c = mapApicar({ vin: 'X', make: 'null', model: 'N/A', odometer: 'abc', year: '', images: [] });
    assert.equal(c.make, null);
    assert.equal(c.model, null);
    assert.equal(c.odometer, null);
    assert.equal(c.year, null);
    assert.equal(c.imageCount, 0);
  });
});

describe('lookupVin: بناء الطلب والمفتاح والذاكرة المؤقتة', () => {
  const realFetch = globalThis.fetch;
  const realKey = config.apicar.key;
  afterEach(() => { globalThis.fetch = realFetch; config.apicar.key = realKey; });

  test('بلا مفتاح: lookupVin يرجع null بلا أي طلب', async () => {
    config.apicar.key = null;
    globalThis.fetch = async () => { throw new Error('يجب ألا يُطلب'); };
    assert.equal(apicarEnabled(), false);
    assert.equal(await lookupVin('WAUFFAFL7GN004606'), null);
  });

  test('يرسل api-key و vin، ويطبّع الردّ، ويخزّنه مؤقتًا', async () => {
    config.apicar.key = 'test-key-123';
    const calls = [];
    globalThis.fetch = async (u, opts) => {
      calls.push({ url: String(u), key: opts.headers['api-key'] });
      return { ok: true, status: 200, json: async () => ({ status: true, data: HIST }) };
    };
    const a = await lookupVin('wauffafl7gn004606');
    assert.equal(a.auction, 'IAAI');
    assert.equal(a.vin, 'WAUFFAFL7GN004606');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/cars\/vin\?vin=WAUFFAFL7GN004606$/);
    assert.equal(calls[0].key, 'test-key-123');
    await lookupVin('WAUFFAFL7GN004606'); // من الذاكرة، بلا طلب جديد
    assert.equal(calls.length, 1);
    assert.equal(apicarEnabled(), true);
  });

  test('يسقط إلى sale-histories/vin لو cars/vin رجع 404، و«غير موجود» يرجع null بلا خطأ', async () => {
    config.apicar.key = 'k';
    const paths = [];
    globalThis.fetch = async (u) => {
      const p = new URL(String(u)).pathname; paths.push(p);
      if (p.endsWith('/cars/vin')) return { ok: false, status: 404, json: async () => null };
      if (p.endsWith('/sale-histories/vin')) return { ok: true, status: 200, json: async () => ({ data: HIST }) };
      return { ok: false, status: 404, json: async () => null };
    };
    const a = await lookupVin('JH4KA8260MC000111');
    assert.equal(a.make, 'Audi');
    assert.deepEqual(paths.map((p) => p.split('/api')[1] || p), ['/cars/vin', '/sale-histories/vin']);
    // سيارة غير موجودة في الاثنين → null (لا 502)
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => null });
    assert.equal(await lookupVin('WBA3A5C50DF000222'), null);
  });

  test('مفتاح غير صالح (401) يرمي خطأ واضح', async () => {
    config.apicar.key = 'bad';
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => null });
    await assert.rejects(() => lookupVin('WBA3A5C50DF000333'), (e) => e.code === 'AUCTION_KEY');
  });

  test('رقم هيكل غير صالح يُرفض', async () => {
    config.apicar.key = 'k';
    await assert.rejects(() => lookupVin('ABC'), /17/);
  });
});
