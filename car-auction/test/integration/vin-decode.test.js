import { resetDb, startApp, stopApp, client } from './_setup.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

resetDb();
const { mapVpic } = await import('../../src/services/vin-decode.js');
const { server, base } = await startApp();
after(() => { globalThis.fetch = realFetch; return stopApp(server); });
const realFetch = globalThis.fetch;

// شكل رد vPIC الحقيقي (حقول مختارة)
const HONDA = { Results: [{ ModelYear: '2021', Make: 'HONDA', Model: 'Accord', Trim: 'EX-L', Series: '', BodyClass: 'Sedan/Saloon', DisplacementL: '1.4999999', EngineCylinders: '4',
  EngineModel: 'L15BE', FuelTypePrimary: 'Gasoline', TransmissionStyle: 'Continuously Variable Transmission (CVT)', DriveType: 'FWD/Front-Wheel Drive', PlantCountry: 'UNITED STATES (USA)', ErrorCode: '0' }] };
const EMPTY = { Results: [{ ModelYear: '', Make: '', Model: '', BodyClass: '', ErrorCode: '7,11' }] };

describe('تحويل رد NHTSA', () => {
  test('يحوّل الحقول ويطبّع الماركة والهيكل', () => {
    const m = mapVpic(HONDA.Results[0]);
    assert.deepEqual([m.year, m.make, m.model, m.trim, m.bodyStyle, m.cylinders], [2021, 'Honda', 'Accord', 'EX-L', 'SEDAN', 4]);
    assert.equal(m.engine, '1.5L 4 cyl L15BE');
    assert.equal(mapVpic({ ModelYear: '2022', Make: 'FORD', Model: 'F-150', BodyClass: 'Pickup' }).bodyStyle, 'PICKUP');
    assert.equal(mapVpic({ BodyClass: 'Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)' }).bodyStyle, 'SUV');
    assert.equal(mapVpic(EMPTY.Results[0]).make, null);
  });
});

describe('مسار فك الـVIN', () => {
  let ops, viewer;
  before(async () => {
    ops = client(base); assert.equal((await ops.login('ops@auction.ly')).status, 200);
    viewer = client(base); assert.equal((await viewer.login('viewer@auction.ly')).status, 200);
  });
  const stub = (fn) => { globalThis.fetch = (url, opts) => (String(url).includes('vpic.nhtsa.dot.gov') ? fn(url, opts) : realFetch(url, opts)); };
  const json = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }));

  test('نجاح: يعيد المواصفات، والنتيجة الناجحة تُخزَّن مؤقتًا (طلب واحد لـNHTSA)', async () => {
    let calls = 0;
    stub((url) => { calls++; assert.match(String(url), /DecodeVinValues\/1HGCM82633A004352\?format=json$/); return json(HONDA); });
    const r = await ops.get('/api/vin/1HGCM82633a004352/decode');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.make, r.data.model, r.data.year, r.data.found, r.data.source], ['Honda', 'Accord', 2021, true, 'NHTSA']);
    await ops.get('/api/vin/1HGCM82633A004352/decode');
    assert.equal(calls, 1);
  });

  test('VIN خاطئ يُرفض قبل أي اتصال خارجي، والصلاحيات تُفرض', async () => {
    let calls = 0; stub(() => { calls++; return json(HONDA); });
    assert.equal((await ops.get('/api/vin/1HGCM82633A004353/decode')).data.error.code, 'BAD_VIN');
    assert.equal((await ops.get('/api/vin/SHORT/decode')).status, 422);
    assert.equal((await viewer.get('/api/vin/1HGCM82633A004352/decode')).status, 403);
    assert.equal((await client(base).get('/api/vin/1HGCM82633A004352/decode')).status, 401);
    assert.equal(calls, 0);
  });

  test('VIN سليم بلا بيانات: found=false ولا يُخزَّن', async () => {
    let calls = 0; stub(() => { calls++; return json(EMPTY); });
    const vin = '2T1BURHE8JC034566';
    assert.equal((await ops.get(`/api/vin/${vin}/decode`)).data.found, false);
    await ops.get(`/api/vin/${vin}/decode`);
    assert.equal(calls, 2);
  });

  test('عطل NHTSA (خطأ 500 / انقطاع / رد تالف) يعطي 502 برسالة عربية بلا انهيار', async () => {
    const vin = '3VWFE21C04M000001';
    stub(() => json({}, 500));
    assert.equal((await ops.get(`/api/vin/${vin}/decode`)).data.error.code, 'VIN_LOOKUP_UNAVAILABLE');
    stub(() => Promise.reject(new Error('ECONNRESET')));
    assert.equal((await ops.get(`/api/vin/${vin}/decode`)).status, 502);
    stub(() => Promise.resolve(new Response('<html>oops</html>', { status: 200 })));
    assert.equal((await ops.get(`/api/vin/${vin}/decode`)).status, 502);
    stub(() => json({ Results: [] }));
    assert.equal((await ops.get(`/api/vin/${vin}/decode`)).status, 502);
  });
});
