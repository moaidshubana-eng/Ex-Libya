// كتالوج طرازات شائعة الاستيراد من أمريكا إلى ليبيا — يُستخدم للبيانات التجريبية
// (البذرة ومحاكي التغذية) فقط. prefix = أول 8 خانات من VIN (WMI + VDS) بصيغة واقعية.
export const CATALOG = [
  { make: 'Toyota', model: 'Camry', trim: 'SE', body: 'SEDAN', engine: '2.5L I4', cyl: 4, drive: 'FWD', prefix: '4T1G11AK', price: [6500, 14000] },
  { make: 'Toyota', model: 'Corolla', trim: 'LE', body: 'SEDAN', engine: '1.8L I4', cyl: 4, drive: 'FWD', prefix: '2T1BURHE', price: [4500, 9000] },
  { make: 'Toyota', model: 'RAV4', trim: 'XLE', body: 'SUV', engine: '2.5L I4', cyl: 4, drive: 'AWD', prefix: '2T3P1RFV', price: [9000, 17000] },
  { make: 'Toyota', model: 'Highlander', trim: 'XLE', body: 'SUV', engine: '3.5L V6', cyl: 6, drive: 'AWD', prefix: '5TDJZRFH', price: [12000, 22000] },
  { make: 'Hyundai', model: 'Sonata', trim: 'SEL', body: 'SEDAN', engine: '2.5L I4', cyl: 4, drive: 'FWD', prefix: '5NPEL4JA', price: [5000, 11000] },
  { make: 'Hyundai', model: 'Elantra', trim: 'SEL', body: 'SEDAN', engine: '2.0L I4', cyl: 4, drive: 'FWD', prefix: '5NPLM4AG', price: [4000, 8500] },
  { make: 'Hyundai', model: 'Tucson', trim: 'SEL', body: 'SUV', engine: '2.5L I4', cyl: 4, drive: 'AWD', prefix: 'KM8JBCAE', price: [7500, 15000] },
  { make: 'Hyundai', model: 'Santa Fe', trim: 'SEL', body: 'SUV', engine: '2.5L I4', cyl: 4, drive: 'AWD', prefix: '5NMS2DAJ', price: [8000, 16000] },
  { make: 'Kia', model: 'K5', trim: 'GT-Line', body: 'SEDAN', engine: '1.6L I4 Turbo', cyl: 4, drive: 'FWD', prefix: '5XXG64J2', price: [6000, 13000] },
  { make: 'Kia', model: 'Sportage', trim: 'LX', body: 'SUV', engine: '2.4L I4', cyl: 4, drive: 'FWD', prefix: 'KNDPM3AC', price: [5500, 11000] },
  { make: 'Kia', model: 'Sorento', trim: 'S', body: 'SUV', engine: '2.5L I4', cyl: 4, drive: 'AWD', prefix: '5XYRLDLC', price: [8500, 16000] },
  { make: 'Nissan', model: 'Altima', trim: '2.5 SV', body: 'SEDAN', engine: '2.5L I4', cyl: 4, drive: 'FWD', prefix: '1N4BL4DV', price: [4500, 9500] },
  { make: 'Nissan', model: 'Rogue', trim: 'SV', body: 'SUV', engine: '2.5L I4', cyl: 4, drive: 'AWD', prefix: '5N1AT2MV', price: [6000, 12000] },
  { make: 'Honda', model: 'Accord', trim: 'Sport', body: 'SEDAN', engine: '1.5L I4 Turbo', cyl: 4, drive: 'FWD', prefix: '1HGCV1F3', price: [7000, 14500] },
  { make: 'Honda', model: 'CR-V', trim: 'EX', body: 'SUV', engine: '1.5L I4 Turbo', cyl: 4, drive: 'AWD', prefix: '2HKRW2H5', price: [8000, 15500] },
  { make: 'Ford', model: 'F-150', trim: 'XLT', body: 'PICKUP', engine: '3.5L V6 EcoBoost', cyl: 6, drive: '4WD', prefix: '1FTFW1E8', price: [13000, 26000] },
  { make: 'Ford', model: 'Explorer', trim: 'XLT', body: 'SUV', engine: '2.3L I4 Turbo', cyl: 4, drive: '4WD', prefix: '1FMSK8DH', price: [10000, 19000] },
  { make: 'Chevrolet', model: 'Malibu', trim: 'LT', body: 'SEDAN', engine: '1.5L I4 Turbo', cyl: 4, drive: 'FWD', prefix: '1G1ZD5ST', price: [4500, 9000] },
  { make: 'Chevrolet', model: 'Tahoe', trim: 'LT', body: 'SUV', engine: '5.3L V8', cyl: 8, drive: '4WD', prefix: '1GNSKCKD', price: [18000, 34000] },
  { make: 'GMC', model: 'Yukon', trim: 'SLT', body: 'SUV', engine: '5.3L V8', cyl: 8, drive: '4WD', prefix: '1GKS2BKC', price: [19000, 36000] },
  { make: 'Jeep', model: 'Grand Cherokee', trim: 'Limited', body: 'SUV', engine: '3.6L V6', cyl: 6, drive: '4WD', prefix: '1C4RJFBG', price: [10000, 20000] },
  { make: 'Lexus', model: 'ES 350', trim: 'Base', body: 'SEDAN', engine: '3.5L V6', cyl: 6, drive: 'FWD', prefix: '58ABZ1B1', price: [12000, 22000] },
  { make: 'Lexus', model: 'RX 350', trim: 'Base', body: 'SUV', engine: '3.5L V6', cyl: 6, drive: 'AWD', prefix: '2T2BZMCA', price: [14000, 26000] },
  { make: 'Mercedes-Benz', model: 'C 300', trim: '4MATIC', body: 'SEDAN', engine: '2.0L I4 Turbo', cyl: 4, drive: 'AWD', prefix: '55SWF8EB', price: [9000, 18000] },
  { make: 'BMW', model: 'X5', trim: 'xDrive40i', body: 'SUV', engine: '3.0L I6 Turbo', cyl: 6, drive: 'AWD', prefix: '5UXCR6C0', price: [17000, 32000] },
  { make: 'Dodge', model: 'Charger', trim: 'SXT', body: 'SEDAN', engine: '3.6L V6', cyl: 6, drive: 'RWD', prefix: '2C3CDXBG', price: [7000, 14000] },
];

export const COLORS = [
  { name: 'WHITE', ar: 'أبيض', hex: '#f4f5f7' },
  { name: 'BLACK', ar: 'أسود', hex: '#1d1f24' },
  { name: 'SILVER', ar: 'فضي', hex: '#b8bec7' },
  { name: 'GRAY', ar: 'رمادي', hex: '#6b7280' },
  { name: 'BLUE', ar: 'أزرق', hex: '#1e4fa3' },
  { name: 'RED', ar: 'أحمر', hex: '#b91c1c' },
  { name: 'BURGUNDY', ar: 'عنابي', hex: '#6d1a2c' },
  { name: 'BEIGE', ar: 'بيج', hex: '#cdb891' },
  { name: 'GREEN', ar: 'أخضر', hex: '#2f5d46' },
];

export const DAMAGES = ['FRONT END', 'REAR END', 'SIDE', 'MINOR DENT/SCRATCHES', 'HAIL', 'ALL OVER', 'UNDERCARRIAGE', 'MECHANICAL', 'WATER/FLOOD', 'NORMAL WEAR', 'VANDALISM', 'BURN - ENGINE'];

export const YARDS = [
  { name: 'Houston North', state: 'TX', zip: '77073', port: 'USHOU' },
  { name: 'Dallas', state: 'TX', zip: '75051', port: 'USHOU' },
  { name: 'Atlanta East', state: 'GA', zip: '30058', port: 'USSAV' },
  { name: 'Savannah', state: 'GA', zip: '31408', port: 'USSAV' },
  { name: 'Newark', state: 'NJ', zip: '07114', port: 'USNYC' },
  { name: 'Long Island', state: 'NY', zip: '11980', port: 'USNYC' },
  { name: 'Los Angeles', state: 'CA', zip: '90058', port: 'USLAX' },
  { name: 'Baltimore', state: 'MD', zip: '21226', port: 'USBAL' },
  { name: 'Miami Central', state: 'FL', zip: '33054', port: 'USSAV' },
];

/** مولّد أرقام عشوائية حتمي (Mulberry32) لنتائج قابلة للتكرار */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
  };
}
