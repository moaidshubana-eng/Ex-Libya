// محاكي تغذيات Copart / IAAI / تتبع الحاويات — لبيئة التطوير والعرض والاختبار فقط.
// يحاكي ما يحدث فعلًا في الإنتاج: صفحات متعددة، حالات لوجستية تتقدم مع الوقت،
// أخطاء عابرة (503/429) بنسبة قابلة للضبط، وعناصر تالفة تذهب إلى طابور الأخطاء.
// لا يُفعَّل في الإنتاج (MOCK_FEEDS=false افتراضيًا عند NODE_ENV=production).
import express from 'express';
import { CATALOG, COLORS, DAMAGES, YARDS, rng } from './catalog.js';
import { makeVin, yearCode } from '../domain/vin.js';

const START = Date.now();
const minutesElapsed = () => (Date.now() - START) / 60_000;

export const mockState = { faultRate: Number(process.env.MOCK_FAULT_RATE ?? 0.15), extraLots: 0 };

function buildLots(seed, count) {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const m = r.pick(CATALOG);
    const year = r.int(2016, 2024);
    const color = r.pick(COLORS);
    const yard = r.pick(YARDS);
    const price = Math.round(r.int(m.price[0], m.price[1]) / 25) * 25;
    return {
      i, m, year, color, yard, price,
      vin: makeVin(m.prefix, yearCode(year), r.pick(['A', 'C', 'K', 'U', '0', '1', '5']), 100000 + r.int(0, 899999)),
      odometer: r.int(18000, 125000),
      damage: r.pick(DAMAGES),
      secondary: r.bool(0.4) ? r.pick(DAMAGES) : null,
      keys: r.bool(0.85),
      runDrive: r.bool(0.6),
      title: r.bool(0.8) ? 'SALVAGE' : 'CLEAN',
      phaseOffset: r.int(0, 3),
      soldDaysAgo: r.int(1, 6),
    };
  });
}

// المرحلة اللوجستية تتقدم كل دقيقتين في المحاكي: 0 مدفوعة؟ لا، 1 مدفوعة، 2 سُحبت، 3 وصلت المستودع
function phase(lot) {
  return Math.min(3, lot.phaseOffset + Math.floor(minutesElapsed() / 2));
}

function maybeFault(req, res) {
  if (req.query.nofault === '1') return false;
  const x = Math.random();
  if (x < mockState.faultRate / 2) {
    res.status(503).json({ error: 'Service temporarily unavailable' });
    return true;
  }
  if (x < mockState.faultRate) {
    res.set('Retry-After', '1').status(429).json({ error: 'Too many requests' });
    return true;
  }
  return false;
}

export function mockFeedsRouter() {
  const router = express.Router();
  const copartLots = buildLots(2026_10, 9);
  const iaaiLots = buildLots(2026_11, 8);

  router.get('/copart/purchases', (req, res) => {
    if (maybeFault(req, res)) return;
    const size = Math.min(50, Number(req.query.size) || 50);
    const page = Math.max(1, Number(req.query.page) || 1);
    const all = copartLots.map((l) => {
      const ph = phase(l);
      const soldAt = START - l.soldDaysAgo * 86_400_000;
      return {
        lotNumber: String(61_200_000 + l.i * 137),
        vin: l.vin,
        year: l.year, make: l.m.make.toUpperCase(), modelGroup: l.m.model, trim: l.m.trim, bodyStyle: l.m.body,
        color: l.color.name, engineType: l.m.engine, cylinders: l.m.cyl, fuel: 'GAS', transmission: 'AUTOMATIC', drive: l.m.drive,
        odometer: l.odometer, odometerBrand: 'A', titleGroup: l.title, titleState: l.yard.state,
        damageDescription: l.damage, secondaryDamage: l.secondary, hasKeys: l.keys ? 'YES' : 'NO',
        highlights: l.runDrive ? ['RUN_AND_DRIVE'] : [],
        yardName: `${l.yard.state} - ${l.yard.name.toUpperCase()}`, locationState: l.yard.state, locationZip: l.yard.zip,
        saleDate: soldAt, saleStatus: 'SOLD',
        acv: Math.round(l.price * 2.1), repairCost: Math.round(l.price * 1.4),
        purchase: {
          price: l.price, buyerFee: Math.round(l.price * 0.08 + 250), otherFees: 159,
          paymentDue: new Date(soldAt + 3 * 86_400_000).toISOString(),
          pickupDeadline: new Date(soldAt + 5 * 86_400_000).toISOString(),
          paidAt: ph >= 1 ? new Date(soldAt + 86_400_000).toISOString() : null,
          pickedUpAt: ph >= 2 ? new Date(soldAt + 2 * 86_400_000).toISOString() : null,
          deliveredAt: ph >= 3 ? new Date(soldAt + 4 * 86_400_000).toISOString() : null,
        },
        imageUrls: [1, 2, 3, 4, 5, 6].map((n) => `https://cs.copart.com/v1/AUTH_svc.pdoc00001/lpp/${l.i}/img_${n}${n === 3 ? '_interior' : n === 5 ? '_engine' : n === 6 ? '_damage' : ''}.jpg`),
        lastUpdated: new Date(START + Math.floor(minutesElapsed() / 2) * 120_000).toISOString(),
      };
    });
    // عنصر تالف عمدًا (VIN بطول خاطئ) لإثبات مسار طابور الأخطاء
    all.push({ lotNumber: '61299999', vin: '1HGCM82633A00435', year: 2019, make: 'HONDA', modelGroup: 'ACCORD', purchase: { price: 5000 } });
    const items = all.slice((page - 1) * size, page * size);
    res.json({ lots: items, page, hasMore: page * size < all.length, serverTime: new Date().toISOString() });
  });

  router.get('/iaai/buyer/purchases', (req, res) => {
    if (maybeFault(req, res)) return;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(50, Number(req.query.limit) || 50);
    const all = iaaiLots.map((l) => {
      const ph = phase(l);
      const soldAt = START - l.soldDaysAgo * 86_400_000;
      return {
        stockNumber: String(38_400_000 + l.i * 211), VIN: l.vin, Year: l.year, Make: l.m.make, Model: l.m.model, Series: l.m.trim,
        BodyStyle: l.m.body, ExteriorColor: l.color.name, EngineSize: l.m.engine, Cylinders: l.m.cyl, FuelType: 'Gasoline',
        Transmission: 'Automatic', DriveLineType: l.m.drive,
        Odometer: { value: l.odometer, unit: 'MI', brand: 'Actual' },
        TitleBrand: l.title, TitleState: l.yard.state, PrimaryDamage: l.damage, SecondaryDamage: l.secondary,
        Keys: l.keys, StartCode: l.runDrive ? 'Run & Drive' : 'Stationary',
        Branch: { name: l.yard.name, state: l.yard.state, zip: l.yard.zip },
        AuctionDateTime: new Date(soldAt).toISOString(), Status: 'Sold', ACV: Math.round(l.price * 2), RepairCost: Math.round(l.price * 1.3),
        Purchase: {
          SalePrice: l.price, Fees: { Buyer: Math.round(l.price * 0.085 + 200), Other: 135 },
          PaymentStatus: ph >= 1 ? 'Paid' : 'Unpaid', PickupStatus: ph >= 3 ? 'Delivered' : ph >= 2 ? 'Picked Up' : 'Pending',
          PaymentDue: new Date(soldAt + 3 * 86_400_000).toISOString(), PickupBy: new Date(soldAt + 5 * 86_400_000).toISOString(),
        },
        Images: [['Exterior', 1], ['Exterior', 2], ['Interior', 3], ['Exterior', 4], ['Engine', 5], ['Damage', 6]].map(([Type, n]) => ({ Type, Url: `https://vis.iaai.com/resizer?imageKeys=${l.i}~SID~I${n}` })),
        LastModified: new Date(START + Math.floor(minutesElapsed() / 2) * 120_000).toISOString(),
      };
    });
    all.push({ stockNumber: '38499999', VIN: 'INVALIDVIN0000000', Year: 2020, Make: 'Kia', Model: 'Soul' });
    res.json({ Vehicles: all.slice(offset, offset + limit), Total: all.length, AsOf: new Date().toISOString() });
  });

  router.get('/tracking/containers/:no', (req, res) => {
    if (maybeFault(req, res)) return;
    const no = req.params.no;
    if (!/^[A-Z]{4}\d{7}$/.test(no)) return res.status(404).json({ error: 'Unknown container' });
    const h = [...no].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const day = 86_400_000;
    const gateIn = Date.now() - (10 + (h % 28)) * day;
    // كل دقيقة حقيقية = يوم في المحاكي، فتتقدم الشحنات أثناء العرض
    const horizon = Date.now() + minutesElapsed() * day;
    const plan = [
      ['GTIN', 'Gate in at origin terminal', 0], ['LOAD', 'Loaded on vessel', 2], ['DEPA', 'Vessel departure', 3],
      ['TRSH', 'Transshipment', 14], ['ARRI', 'Vessel arrival', 26], ['DISC', 'Discharged at destination', 27],
    ];
    const events = plan.filter(([, , d]) => gateIn + d * day <= horizon).map(([code, desc, d]) => ({
      eventID: `${no}-${code}`, eventCode: code, description: desc,
      location: d < 14 ? 'Houston, US' : d < 26 ? 'Algeciras, ES' : 'Misrata, LY',
      eventDateTime: new Date(gateIn + d * day).toISOString(),
    }));
    res.json({ equipmentReference: no, vesselName: ['MSC AURORA', 'MAERSK KENTUCKY', 'CMA CGM TIGRIS'][h % 3], voyageNumber: `V${(h % 900) + 100}E`, estimatedArrival: new Date(gateIn + 26 * day).toISOString(), events });
  });

  return router;
}
