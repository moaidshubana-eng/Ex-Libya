// بيانات تجريبية واقعية متسقة: ~48 سيارة موزعة على كل مراحل دورة الحياة، مع
// المشتريات من Copart/IAAI، الشحنات والحاويات، الجمارك، التكاليف التفصيلية،
// المبيعات، ومزاد حي جارٍ الآن بمزايدات ومزايدات آلية.
// كل الأسماء والأرقام وهمية. أسعار الصرف والرسوم هنا للعرض فقط وليست مرجعًا رسميًا.
import pg from 'pg';
import { config } from '../src/config.js';
import { hashPassword, encrypt, lookupHash, sha256 } from '../src/security/crypto.js';
import { CATALOG, COLORS, DAMAGES, YARDS, rng } from '../src/sync/catalog.js';
import { makeVin, yearCode } from '../src/domain/vin.js';
import { allocate } from '../src/domain/money.js';
import { MAIN_PATH } from '../src/domain/status.js';

const r = rng(20261007);
const DAY = 86_400_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const dateOnly = (ms) => iso(ms).slice(0, 10);
const money = (n) => (Math.round(n * 1000) / 1000).toFixed(3);

const client = new pg.Client({ connectionString: config.databaseUrl, options: '-c search_path=auction,public' });
await client.connect();
const q = (sql, params) => client.query(sql, params);

export const DEMO_PASSWORD = 'Demo@2026pass';

try {
  await q('BEGIN');

  // ------------------------------------------------ أسعار الصرف (يومية لـ 200 يوم)
  let usd = 5.52;
  for (let d = 200; d >= 0; d--) {
    usd = Math.max(5.3, Math.min(5.8, usd + (r.next() - 0.5) * 0.02));
    await q(`INSERT INTO exchange_rates (currency, rate_to_lyd, effective_date, source) VALUES ('USD',$1,$2,'MANUAL'), ('EUR',$3,$2,'MANUAL')`,
      [usd.toFixed(4), dateOnly(now - d * DAY), (usd * 1.09).toFixed(4)]);
  }
  const fxAt = async (cur, ms) => (await q(`SELECT rate_to_lyd FROM exchange_rates WHERE currency=$1 AND effective_date <= $2 ORDER BY effective_date DESC LIMIT 1`, [cur, dateOnly(ms)])).rows[0].rate_to_lyd;

  // ------------------------------------------------ الجهات
  const vendor = async (name, type, country, contact = {}) =>
    (await q(`INSERT INTO vendors (name, vendor_type, country, contact) VALUES ($1,$2,$3,$4) RETURNING id`, [name, type, country, JSON.stringify(contact)])).rows[0].id;
  const V = {
    towTx: await vendor('Gulf Coast Auto Towing', 'TOWING', 'US'),
    towEast: await vendor('East Coast Car Haulers', 'TOWING', 'US'),
    forwarder: await vendor('Atlantic Export Logistics', 'FREIGHT_FORWARDER', 'US'),
    msc: await vendor('MSC', 'SHIPPING_LINE', 'CH'),
    maersk: await vendor('Maersk', 'SHIPPING_LINE', 'DK'),
    cma: await vendor('CMA CGM', 'SHIPPING_LINE', 'FR'),
    insurer: await vendor('Mediterranean Marine Insurance', 'INSURANCE', 'MT'),
    broker1: await vendor('مكتب الساحل للتخليص الجمركي', 'CUSTOMS_BROKER', 'LY'),
    broker2: await vendor('مكتب الواحة للتخليص الجمركي', 'CUSTOMS_BROKER', 'LY'),
    truck: await vendor('شركة الطريق السريع للنقل', 'INLAND_TRANSPORT', 'LY'),
    workshop: await vendor('ورشة النخبة للسمكرة والميكانيكا', 'WORKSHOP', 'LY'),
    port: await vendor('شركة خدمات الميناء', 'OTHER', 'LY'),
  };
  const lines = [V.msc, V.maersk, V.cma];
  const linePrefix = { [V.msc]: 'MSCU', [V.maersk]: 'MSKU', [V.cma]: 'CMAU' };

  const ports = Object.fromEntries((await q('SELECT id, code FROM ports')).rows.map((p) => [p.code, p.id]));
  const sources = Object.fromEntries((await q('SELECT id, code FROM external_sources')).rows.map((s) => [s.code, s.id]));

  // ------------------------------------------------ العملاء
  const cities = ['طرابلس', 'مصراتة', 'بنغازي', 'الزاوية', 'زليتن', 'الخمس', 'سبها', 'غريان'];
  const names = ['محمد الطاهر الزوي', 'أحمد علي المصراتي', 'سالم عمر الورفلي', 'خالد مفتاح الترهوني', 'عبدالله يوسف البرعصي', 'معرض الأمانة للسيارات',
    'علي حسين القماطي', 'شركة النجم الساطع لتجارة السيارات', 'إبراهيم سعيد الككلي', 'يوسف محمود الشريف', 'فرج عبدالسلام العبيدي', 'معرض الصفوة للسيارات'];
  const customers = [];
  for (const [i, name] of names.entries()) {
    const phone = `09${r.pick(['1', '2', '4', '5'])}${String(r.int(1000000, 9999999))}`;
    const nid = `1${String(r.int(10000000000, 99999999999))}`;
    const type = name.startsWith('معرض') || name.startsWith('شركة') ? 'DEALER' : 'INDIVIDUAL';
    const { rows } = await q(
      `INSERT INTO customers (code, full_name, customer_type, phone_enc, phone_hash, national_id_enc, national_id_hash, city, kyc_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [`C-${String(i + 1).padStart(5, '0')}`, name, type, encrypt(phone), lookupHash(phone), encrypt(nid), lookupHash(nid), r.pick(cities), i < 10 ? 'VERIFIED' : 'PENDING']);
    customers.push(rows[0].id);
  }

  // ------------------------------------------------ المستخدمون
  const pw = await hashPassword(DEMO_PASSWORD);
  const users = {};
  for (const [key, email, name, role, cust] of [
    ['admin', 'admin@auction.ly', 'مدير النظام', 'ADMIN', null],
    ['ops', 'ops@auction.ly', 'منسق العمليات والشحن', 'OPERATIONS', null],
    ['acc', 'accountant@auction.ly', 'المحاسب', 'ACCOUNTANT', null],
    ['sales', 'sales@auction.ly', 'مسؤول المبيعات والمزادات', 'SALES', null],
    ['viewer', 'viewer@auction.ly', 'المدير العام (اطلاع)', 'VIEWER', null],
    ['bidder1', 'bidder1@auction.ly', names[0], 'BIDDER', customers[0]],
    ['bidder2', 'bidder2@auction.ly', names[5], 'BIDDER', customers[5]],
    ['bidder3', 'bidder3@auction.ly', names[7], 'BIDDER', customers[7]],
  ]) {
    users[key] = (await q(`INSERT INTO users (email, full_name, password_hash, role, customer_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [email, name, pw, role, cust])).rows[0].id;
  }

  // ------------------------------------------------ توزيع السيارات على الحالات
  const plan = [
    ['PURCHASED', 3], ['AWAITING_PICKUP', 3], ['US_INLAND_TRANSIT', 2], ['AT_US_WAREHOUSE', 3], ['LOADED', 4],
    ['IN_TRANSIT_SEA', 8], ['AT_PORT_LIBYA', 4], ['IN_CUSTOMS', 4], ['CUSTOMS_CLEARED', 2], ['LY_INLAND_TRANSIT', 2],
    ['IN_STOCK', 5], ['IN_AUCTION', 8], ['SOLD', 4], ['DELIVERED', 4], ['ON_HOLD', 2],
  ];
  const vehicles = [];
  let lotSeq = 0;

  const addCost = async (vid, code, amount, cur, ms, extra = {}) => {
    const fx = cur === 'LYD' ? '1' : await fxAt(cur, ms);
    await q(`INSERT INTO vehicle_costs (vehicle_id, category_code, vendor_id, description, amount, currency, fx_rate_to_lyd, status, incurred_at, is_paid, invoice_ref, created_by, shared_cost_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [vid, code, extra.vendor || null, extra.desc || null, money(amount), cur, fx, extra.status || 'ACTUAL', dateOnly(ms), extra.paid ?? true,
        extra.ref || null, extra.by || users.acc, extra.shared || null]);
  };

  for (const [finalStatus, count] of plan) {
    for (let k = 0; k < count; k++) {
      const m = r.pick(CATALOG);
      const year = r.int(2017, 2024);
      const color = r.pick(COLORS);
      const yard = r.pick(YARDS);
      const effective = finalStatus === 'ON_HOLD' ? r.pick(['AT_PORT_LIBYA', 'IN_CUSTOMS']) : finalStatus;
      const idx = effective === 'IN_AUCTION' ? MAIN_PATH.indexOf('IN_STOCK') : MAIN_PATH.indexOf(effective);
      const boughtAt = now - (4 + idx * 5.5 + r.int(0, 4)) * DAY;
      const hammer = Math.round(r.int(m.price[0], m.price[1]) / 25) * 25;
      const isCopart = r.bool(0.55);
      const src = isCopart ? 'COPART' : 'IAAI';
      const lotNo = isCopart ? String(58_000_000 + r.int(0, 999_999)) : String(37_000_000 + r.int(0, 999_999));
      const vin = makeVin(m.prefix, yearCode(year), r.pick(['A', 'C', 'K', 'U', '0', '1', '5', '7']), 100000 + r.int(0, 899999));
      const damage = r.pick(DAMAGES);
      const statusChangedAt = now - r.int(1, 4) * DAY;

      const { rows: [v] } = await q(
        `INSERT INTO vehicles (stock_no, vin, year, make, model, trim, body_style, exterior_color, interior_color, engine, cylinders, fuel_type, transmission, drive_type,
            odometer, odometer_unit, odometer_brand, title_type, title_state, primary_damage, secondary_damage, has_keys, run_and_drive, condition_grade,
            status, status_changed_at, hold_reason, hold_return_status, destination_port_id, created_at)
         VALUES ('LY-' || to_char(now(),'YYYY') || '-' || lpad(nextval('stock_seq')::text, 4, '0'),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'GAS','AUTOMATIC',$11,$12,'mi','ACTUAL',$13,$14,$15,$16,$17,$18,$19,
                 $20,$21,$22,$23,$24,$25) RETURNING id, stock_no`,
        [vin, year, m.make, m.model, m.trim, m.body, color.name, r.pick(['BLACK', 'GRAY', 'BEIGE']), m.engine, m.cyl, m.drive,
          r.int(15000, 120000), r.bool(0.8) ? 'SALVAGE' : 'CLEAN', yard.state, damage, r.bool(0.4) ? r.pick(DAMAGES) : null, r.bool(0.85), r.bool(0.6),
          idx >= MAIN_PATH.indexOf('AT_PORT_LIBYA') ? (r.int(25, 45) / 10).toFixed(1) : null,
          finalStatus, iso(statusChangedAt), finalStatus === 'ON_HOLD' ? r.pick(['نقص في مستند الملكية (Title) — بانتظار نسخة من المصدر', 'فرق بين VIN في البيان والسيارة — قيد المراجعة']) : null,
          finalStatus === 'ON_HOLD' ? effective : null, ports[r.pick(['LYMRA', 'LYMRA', 'LYTIP', 'LYBEN', 'LYKHO'])], iso(boughtAt)]);
      vehicles.push({ id: v.id, stock: v.stock_no, finalStatus, effective, idx, boughtAt, hammer, yard, m, year });

      // سجل الحالات الكامل حتى الحالة الحالية
      const steps = MAIN_PATH.slice(0, idx + 1);
      if (effective === 'IN_AUCTION') steps.push('IN_AUCTION');
      let prev = null;
      for (const [si, s] of steps.entries()) {
        const at = si === steps.length - 1 ? statusChangedAt - (finalStatus === 'ON_HOLD' ? DAY : 0) : boughtAt + (si / Math.max(1, steps.length - 1)) * (statusChangedAt - boughtAt);
        await q(`INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, source, changed_by, occurred_at, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [v.id, prev, s, si <= 3 ? 'SYNC' : 'MANUAL', si <= 3 ? null : users.ops, iso(at), si === 0 ? `استيراد آلي من ${src} — لوت ${lotNo}` : null]);
        prev = s;
      }
      if (finalStatus === 'ON_HOLD')
        await q(`INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, source, changed_by, occurred_at, reason) VALUES ($1,$2,'ON_HOLD','MANUAL',$3,$4,'تعليق لحين استكمال المستندات')`,
          [v.id, effective, users.ops, iso(statusChangedAt)]);

      // بيانات المصدر
      const buyerFee = Math.round(hammer * 0.08 + 250);
      const raw = { lotNumber: lotNo, vin, year, make: m.make, model: m.model, purchase: { price: hammer, buyerFee } };
      await q(`INSERT INTO source_listings (vehicle_id, source_id, lot_number, listing_url, yard_name, yard_state, yard_zip, sale_date, sale_status, acv_usd, repair_estimate_usd,
                 purchase_price_usd, raw_payload, payload_hash, first_seen_at, last_synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SOLD',$9,$10,$11,$12,$13,$14,$14)`,
        [v.id, sources[src], lotNo, isCopart ? `https://www.copart.com/lot/${lotNo}` : `https://www.iaai.com/VehicleDetail/${lotNo}`,
          yard.name, yard.state, yard.zip, iso(boughtAt), Math.round(hammer * 2.1), Math.round(hammer * 1.4), hammer, JSON.stringify(raw), sha256(raw), iso(boughtAt)]);

      // الصور (7 لكل سيارة)
      const kinds = ['EXTERIOR', 'EXTERIOR', 'INTERIOR', 'EXTERIOR', 'ENGINE', 'DAMAGE', 'EXTERIOR'];
      const caps = ['جانبي', 'أمامي', 'المقصورة', 'خلفي', 'حجرة المحرك', 'تفاصيل الضرر', 'جانبي أيمن'];
      for (let i = 0; i < 7; i++) {
        await q(`INSERT INTO vehicle_images (vehicle_id, source_id, kind, storage_key, width, height, sha256, caption, sort_order, is_primary)
                 VALUES ($1,$2,$3,$4,1600,1000,$5,$6,$7,$8)`, [v.id, i < 6 ? sources[src] : null, kinds[i], `gen://${v.id}/${i}`, sha256(`${v.id}/${i}`), caps[i], i, i === 0]);
      }

      // تكاليف الشراء
      await addCost(v.id, 'HAMMER_PRICE', hammer, 'USD', boughtAt, { desc: `سعر الشراء — ${src} لوت ${lotNo}`, ref: `SRC-${lotNo}`, by: null });
      await addCost(v.id, 'AUCTION_BUYER_FEE', buyerFee, 'USD', boughtAt, { desc: 'رسوم المشتري', ref: `SRC-${lotNo}`, by: null });
      await addCost(v.id, 'AUCTION_OTHER_FEES', isCopart ? 159 : 135, 'USD', boughtAt, { desc: 'رسوم البوابة/البيئة/المزايدة الإلكترونية', by: null });
      await addCost(v.id, 'BROKER_FEE', 200, 'USD', boughtAt, { desc: 'عمولة حساب الوسيط', paid: idx > 1 });
      if (idx >= 2) await addCost(v.id, 'US_TOWING', r.int(250, 850), 'USD', boughtAt + 2 * DAY, { vendor: yard.state === 'TX' ? V.towTx : V.towEast, desc: `سحب من ${yard.name} إلى ميناء التصدير` });
      if (idx >= 1 && r.bool(0.2)) await addCost(v.id, 'US_STORAGE', r.int(40, 260), 'USD', boughtAt + 4 * DAY, { desc: 'رسوم تخزين لتأخر السحب', paid: idx > 2 });
      if (idx >= 3) await addCost(v.id, 'EXPORT_DOCS', 75, 'USD', boughtAt + 6 * DAY, { vendor: V.forwarder, desc: 'معالجة مستندات التصدير والملكية' });
    }
  }

  // ------------------------------------------------ الشحنات (حاويات 40HC بأربع سيارات)
  const shipStatus = (effective) => ({
    LOADED: 'LOADING', IN_TRANSIT_SEA: 'IN_TRANSIT', AT_PORT_LIBYA: 'DISCHARGED', IN_CUSTOMS: 'DISCHARGED',
  }[effective] || 'CLOSED');
  const shippable = vehicles.filter((v) => v.idx >= MAIN_PATH.indexOf('LOADED'));
  const groups = {};
  for (const v of shippable) (groups[shipStatus(v.effective)] ||= []).push(v);
  for (const [status, list] of Object.entries(groups)) {
    for (let i = 0; i < list.length; i += 4) {
      const cars = list.slice(i, i + 4);
      const line = r.pick(lines);
      const etdMs = Math.min(...cars.map((c) => c.boughtAt)) + 12 * DAY;
      const etaMs = etdMs + r.int(26, 34) * DAY;
      const pol = ports[r.pick(['USHOU', 'USSAV', 'USNYC', 'USBAL'])];
      const pod = ports[r.pick(['LYMRA', 'LYMRA', 'LYKHO', 'LYBEN'])];
      const container = `${linePrefix[line]}${String(r.int(1000000, 9999999))}`;
      const departed = status !== 'LOADING';
      const arrived = ['DISCHARGED', 'CLOSED'].includes(status);
      const { rows: [sh] } = await q(
        `INSERT INTO shipments (shipment_no, booking_no, bill_of_lading, container_no, container_type, capacity, carrier_id, forwarder_id, vessel_name, voyage_no,
                                pol_port_id, pod_port_id, etd, atd, eta, ata, status, last_tracking_at)
         VALUES ('SH-' || to_char(now(),'YYYY') || '-' || lpad(nextval('shipment_seq')::text, 4, '0'), $1,$2,$3,'C40HC',4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() - interval '3 hours')
         RETURNING id, shipment_no`,
        [`BK${r.int(100000, 999999)}`, `${linePrefix[line].slice(0, 3)}${r.int(10000000, 99999999)}`, container, line, V.forwarder,
          r.pick(['MSC AURORA', 'MAERSK KENTUCKY', 'CMA CGM TIGRIS', 'MSC CAPELLA']), `V${r.int(100, 999)}E`, pol, pod,
          dateOnly(etdMs), departed ? dateOnly(etdMs + DAY) : null, dateOnly(etaMs), arrived ? dateOnly(etaMs) : null, status]);
      const evts = [['GTIN', 'دخول الحاوية لمحطة التصدير', etdMs - 3 * DAY], ['LOAD', 'تحميل على السفينة', etdMs]];
      if (departed) evts.push(['DEPA', 'مغادرة السفينة', etdMs + DAY], ['TRSH', 'مسافنة', etdMs + 12 * DAY]);
      if (arrived) evts.push(['ARRI', 'وصول السفينة', etaMs], ['DISC', 'تفريغ الحاوية', etaMs + DAY]);
      for (const [code, desc, at] of evts.filter(([, , at]) => at < now))
        await q(`INSERT INTO shipment_events (shipment_id, event_code, description, location, occurred_at, source) VALUES ($1,$2,$3,$4,$5,'SYNC')`,
          [sh.id, code, desc, code === 'TRSH' ? 'Algeciras, ES' : ['ARRI', 'DISC'].includes(code) ? 'ليبيا' : 'US', iso(at)]);
      for (const [pos, c] of cars.entries())
        await q('INSERT INTO shipment_vehicles (shipment_id, vehicle_id, position, loaded_at) VALUES ($1,$2,$3,$4)', [sh.id, c.id, pos + 1, iso(etdMs)]);

      // تكاليف مشتركة: الشحن البحري + التحميل، موزعة بالتساوي بدقة
      for (const [code, total, desc, vend] of [['OCEAN_FREIGHT', r.int(3800, 5200), 'أجرة شحن حاوية 40HC', line], ['LOADING', 600, 'تحميل وتربيط 4 سيارات', V.forwarder]]) {
        const fx = await fxAt('USD', etdMs);
        const { rows: [sc] } = await q(
          `INSERT INTO shared_costs (shipment_id, category_code, vendor_id, description, total_amount, currency, fx_rate_to_lyd, method, incurred_at, created_by)
           VALUES ($1,$2,$3,$4,$5,'USD',$6,'EQUAL',$7,$8) RETURNING id`, [sh.id, code, vend, desc, total, fx, dateOnly(etdMs), users.acc]);
        for (const s of allocate(String(total), cars.map((c) => ({ id: c.id })), 'EQUAL'))
          await addCost(s.id, code, Number(s.amount), 'USD', etdMs, { vendor: vend, desc: `${desc} (حصة من ${total} USD — ${sh.shipment_no})`, shared: sc.id, paid: departed });
      }
      for (const c of cars) {
        await addCost(c.id, 'MARINE_INSURANCE', Math.max(60, c.hammer * 0.015), 'USD', etdMs, { vendor: V.insurer, desc: 'تأمين بحري 1.5% من قيمة الشراء' });
        if (c.effective === 'IN_TRANSIT_SEA') {
          // تقدير مسبق للتكاليف الليبية — يظهر في التقرير كـ "تقديري" حتى يُستبدل بالفعلي
          await addCost(c.id, 'CUSTOMS_DUTY', c.hammer * 1.1, 'LYD', now, { status: 'ESTIMATED', paid: false, desc: 'تقدير مبدئي للرسم الجمركي' });
        }
      }
    }
  }

  // ------------------------------------------------ الوصول، الجمارك، النقل، التجهيز
  for (const v of vehicles) {
    const at = (n) => v.boughtAt + n * DAY;
    if (v.idx >= MAIN_PATH.indexOf('AT_PORT_LIBYA')) {
      const fees = r.int(550, 900);
      await addCost(v.id, 'PORT_HANDLING', fees, 'LYD', at(45), { vendor: V.port, desc: 'رسوم تفريغ ومناولة', paid: v.idx > MAIN_PATH.indexOf('AT_PORT_LIBYA') });
      const cs = v.idx === MAIN_PATH.indexOf('AT_PORT_LIBYA') ? 'DOCS_PENDING'
        : v.idx === MAIN_PATH.indexOf('IN_CUSTOMS') ? r.pick(['SUBMITTED', 'INSPECTION', 'ASSESSED']) : 'RELEASED';
      const assessed = Math.round(v.hammer * 5.6 * 1.25);
      const duty = Math.round(assessed * 0.18);
      const { rows: [cd] } = await q(
        `INSERT INTO customs_declarations (vehicle_id, declaration_no, port_id, broker_id, status, submitted_at, assessed_value_lyd, duty_amount_lyd, released_at)
         SELECT $1, $2, sh.pod_port_id, $3, $4, $5, $6, $7, $8 FROM shipment_vehicles sv JOIN shipments sh ON sh.id = sv.shipment_id WHERE sv.vehicle_id = $1 RETURNING id`,
        [v.id, cs === 'DOCS_PENDING' ? null : `CD/${new Date().getFullYear()}/${r.int(10000, 99999)}`, r.pick([V.broker1, V.broker2]), cs,
          cs === 'DOCS_PENDING' ? null : iso(at(47)), ['ASSESSED', 'RELEASED'].includes(cs) ? assessed : null, ['ASSESSED', 'RELEASED'].includes(cs) ? duty : null,
          cs === 'RELEASED' ? iso(at(50)) : null]);
      if (cs === 'RELEASED') {
        await addCost(v.id, 'CUSTOMS_DUTY', duty, 'LYD', at(49), { desc: 'رسم جمركي — بيان مُفرج عنه', ref: cd.id.slice(0, 8) });
        await addCost(v.id, 'CUSTOMS_BROKER', r.int(350, 600), 'LYD', at(50), { vendor: V.broker1, desc: 'أتعاب التخليص' });
        if (r.bool(0.3)) await addCost(v.id, 'PORT_STORAGE', r.int(120, 480), 'LYD', at(50), { vendor: V.port, desc: 'أرضيات تأخير' });
      } else if (cs !== 'DOCS_PENDING') {
        await addCost(v.id, 'CUSTOMS_DUTY', v.hammer * 1.1, 'LYD', now, { status: 'ESTIMATED', paid: false, desc: 'تقدير مبدئي للرسم الجمركي' });
      }
    }
    if (v.idx >= MAIN_PATH.indexOf('LY_INLAND_TRANSIT')) {
      await q(`INSERT INTO inland_transports (vehicle_id, leg, vendor_id, from_location, to_location, distance_km, planned_at, picked_up_at, delivered_at, status)
               VALUES ($1,'LY_DELIVERY',$2,'ميناء مصراتة','معرض الشركة — طرابلس',210,$3,$4,$5,$6)`,
        [v.id, V.truck, dateOnly(at(51)), iso(at(51)), v.idx > MAIN_PATH.indexOf('LY_INLAND_TRANSIT') ? iso(at(52)) : null, v.idx > MAIN_PATH.indexOf('LY_INLAND_TRANSIT') ? 'DELIVERED' : 'PICKED_UP']);
      await addCost(v.id, 'LY_TRANSPORT', r.int(300, 700), 'LYD', at(51), { vendor: V.truck, desc: 'نقل بشاحنة من الميناء إلى المعرض' });
    }
    if (v.idx >= MAIN_PATH.indexOf('IN_STOCK')) {
      if (r.bool(0.65)) await addCost(v.id, 'REPAIRS', r.int(1500, 9000), 'LYD', at(54), { vendor: V.workshop, desc: 'سمكرة ودهان وإصلاح الضرر' });
      if (r.bool(0.4)) await addCost(v.id, 'PARTS', r.int(400, 3500), 'LYD', at(54), { desc: 'قطع غيار' });
      await q(`INSERT INTO vehicle_inspections (vehicle_id, stage, grade, findings, notes, inspected_by, inspected_at) VALUES ($1,'SHOWROOM',$2,$3,$4,$5,$6)`,
        [v.id, (r.int(32, 48) / 10).toFixed(1), JSON.stringify([{ part: 'الهيكل', issue: 'تم إصلاح الضرر الأمامي', severity: 'LOW' }, { part: 'الإطارات', issue: 'تآكل طبيعي', severity: 'LOW' }]),
          'جاهزة للعرض بعد التجهيز', users.ops, iso(at(55))]);
    }
  }

  // تكلفة كل سيارة حتى الآن (لتسعير البيع والعرض)
  const costOf = async (id) => Number((await q('SELECT total_cost_lyd FROM v_vehicle_landed_cost WHERE vehicle_id = $1', [id])).rows[0].total_cost_lyd);
  for (const v of vehicles.filter((x) => ['IN_STOCK', 'IN_AUCTION', 'CUSTOMS_CLEARED', 'LY_INLAND_TRANSIT'].includes(x.finalStatus))) {
    await q('UPDATE vehicles SET list_price_lyd = $2 WHERE id = $1', [v.id, Math.round((await costOf(v.id)) * 1.28 / 500) * 500]);
  }

  // ------------------------------------------------ المزادات
  const { rows: [pastEvent] } = await q(
    `INSERT INTO auction_events (title, starts_at, ends_at, status, deposit_required_lyd, created_by) VALUES ('مزاد الخميس الأسبوعي — السابق', $1, $2, 'CLOSED', 5000, $3) RETURNING id`,
    [iso(now - 9 * DAY), iso(now - 8 * DAY), users.sales]);
  const { rows: [liveEvent] } = await q(
    `INSERT INTO auction_events (title, starts_at, ends_at, status, deposit_required_lyd, anti_snipe_window_sec, extension_sec, created_by, terms)
     VALUES ('مزاد السيارات الأمريكية — الأسبوع الحالي', $1, $2, 'LIVE', 5000, 120, 120, $3, 'السيارات تُباع بحالتها. يُسدد الثمن خلال 3 أيام عمل من رسو المزاد.') RETURNING id`,
    [iso(now - 2 * 3600_000), iso(now + 3 * 3600_000), users.sales]);
  await q(`INSERT INTO auction_events (title, starts_at, ends_at, status, deposit_required_lyd, created_by) VALUES ('مزاد نهاية الشهر', $1, $2, 'SCHEDULED', 5000, $3)`,
    [iso(now + 6 * DAY), iso(now + 6 * DAY + 5 * 3600_000), users.sales]);

  for (const [ev, list] of [[pastEvent.id, customers.slice(0, 8)], [liveEvent.id, customers.slice(0, 10)]]) {
    for (const [i, c] of list.entries())
      await q(`INSERT INTO bidder_registrations (auction_event_id, customer_id, paddle_no, deposit_amount_lyd, deposit_status, approved_by, approved_at)
               VALUES ($1,$2,$3,5000,$4,$5,now())`, [ev, c, 101 + i, ev === pastEvent.id ? 'RELEASED' : i === 9 ? 'PENDING' : 'HELD', users.sales]);
  }

  // لوتات المزاد الحي: فترات انتهاء متدرجة (الأولى بعد دقائق لعرض الإغلاق الآلي ومنع القنص)
  const live = vehicles.filter((v) => v.finalStatus === 'IN_AUCTION');
  for (const [i, v] of live.entries()) {
    const cost = await costOf(v.id);
    const start = Math.round((cost * 0.85) / 500) * 500;
    const reserve = Math.round((cost * 1.12) / 500) * 500;
    const endMs = now + (i === 0 ? 6 * 60_000 : (25 + i * 20) * 60_000);
    const { rows: [lot] } = await q(
      `INSERT INTO auction_lots (auction_event_id, vehicle_id, lot_no, starting_price, reserve_price, starts_at, ends_at, original_ends_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'OPEN') RETURNING id`, [liveEvent.id, v.id, ++lotSeq, start, reserve, iso(now - 2 * 3600_000), iso(endMs)]);
    // تاريخ مزايدات متصاعد
    let price = start;
    const nBids = i === live.length - 1 ? 0 : r.int(3, 11);
    let leader = null;
    for (let b = 0; b < nBids; b++) {
      let who = r.pick(customers.slice(0, 9));
      if (who === leader) who = customers[(customers.indexOf(who) + 1) % 9];
      if (b > 0) price += price < 10000 ? 100 * r.int(1, 3) : price < 50000 ? 250 * r.int(1, 3) : 500 * r.int(1, 2);
      await q(`INSERT INTO bids (lot_id, customer_id, amount, kind, placed_by, placed_at) VALUES ($1,$2,$3,'MANUAL',$4,$5)`,
        [lot.id, who, price, users.sales, iso(now - 2 * 3600_000 + (b + 1) * (100 * 60_000 / (nBids + 1)))]);
      leader = who;
    }
    if (nBids) await q('UPDATE auction_lots SET current_price = $2, leading_customer_id = $3, bid_count = $4 WHERE id = $1', [lot.id, price, leader, nBids]);
    // مزايدة آلية لعميل آخر على بعض اللوتات (حدها أعلى من السعر الحالي — ستتدخل عند أي مزايدة جديدة)
    if (nBids && i % 3 === 1) {
      const other = customers.slice(0, 9).find((c) => c !== leader && c !== customers[0]);
      await q('INSERT INTO proxy_bids (lot_id, customer_id, max_amount) VALUES ($1,$2,$3)', [lot.id, other, price + (price < 50000 ? 1500 : 3000)]);
    }
  }

  // المبيعات (المباعة والمسلمة) — بعضها عبر المزاد السابق وبعضها بيع مباشر
  for (const [i, v] of vehicles.filter((x) => ['SOLD', 'DELIVERED'].includes(x.finalStatus)).entries()) {
    const cost = await costOf(v.id);
    const price = Math.round((cost * (1.08 + r.next() * 0.27)) / 500) * 500;
    const buyer = customers[(i * 3) % customers.length];
    let lotId = null;
    if (i % 2 === 0) {
      const { rows: [l] } = await q(
        `INSERT INTO auction_lots (auction_event_id, vehicle_id, lot_no, starting_price, reserve_price, current_price, leading_customer_id, bid_count, starts_at, ends_at, original_ends_at, status, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'CLOSED_SOLD',$10) RETURNING id`,
        [pastEvent.id, v.id, ++lotSeq, Math.round(price * 0.8 / 500) * 500, Math.round(price * 0.95 / 500) * 500, price, buyer, r.int(4, 14), iso(now - 9 * DAY), iso(now - 8 * DAY)]);
      lotId = l.id;
      await q(`INSERT INTO bids (lot_id, customer_id, amount, kind, placed_at) VALUES ($1,$2,$3,'MANUAL',$4)`, [lotId, buyer, price, iso(now - 8 * DAY - 600_000)]);
    }
    const { rows: [sale] } = await q(
      `INSERT INTO sales (invoice_no, vehicle_id, customer_id, lot_id, sale_type, sale_price_lyd, sold_at, payment_due_at, created_by)
       VALUES ('INV-' || to_char(now(),'YYYY') || '-' || lpad(nextval('invoice_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [v.id, buyer, lotId, lotId ? 'AUCTION' : 'DIRECT', price, iso(now - 8 * DAY), iso(now - 5 * DAY), users.sales]);
    const paidFull = v.finalStatus === 'DELIVERED' || r.bool(0.5);
    await q(`INSERT INTO payments (sale_id, amount, method, reference, received_at, received_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [sale.id, paidFull ? price : Math.round(price * 0.5), r.pick(['BANK_TRANSFER', 'CASH', 'CHEQUE']), `RCPT-${r.int(10000, 99999)}`, iso(now - 7 * DAY), users.acc]);
    await addCost(v.id, 'REGISTRATION', r.int(150, 400), 'LYD', now - 6 * DAY, { desc: 'ترقيم وتسجيل' });
  }

  // سجل مزامنة سابق (لملء شاشة التكامل)
  for (const [code, okRuns] of [['COPART', 6], ['IAAI', 6], ['TRACKING', 4]]) {
    for (let k = okRuns; k >= 1; k--) {
      await q(`INSERT INTO sync_jobs (source_id, job_type, status, triggered_by, items_seen, items_created, items_updated, items_unchanged, items_failed, queued_at, started_at, finished_at)
               VALUES ($1,$2,'SUCCEEDED','SCHEDULER',$3,$4,$5,$6,0,$7,$7,$8)`,
        [sources[code], code === 'TRACKING' ? 'SHIPMENT_TRACKING' : 'PURCHASES_IMPORT', r.int(8, 30), r.int(0, 2), r.int(1, 6), r.int(5, 20), iso(now - k * 3 * 3600_000), iso(now - k * 3 * 3600_000 + r.int(2000, 9000))]);
    }
  }

  await q('COMMIT');
  const { rows: [counts] } = await q(`SELECT (SELECT count(*) FROM vehicles) v, (SELECT count(*) FROM vehicle_costs) c, (SELECT count(*) FROM shipments) s, (SELECT count(*) FROM bids) b`);
  console.log(`seeded: ${counts.v} vehicles, ${counts.c} cost lines, ${counts.s} shipments, ${counts.b} bids`);
  console.log(`demo password for all users: ${DEMO_PASSWORD}`);
} catch (e) {
  await q('ROLLBACK');
  console.error(e);
  process.exitCode = 1;
} finally {
  await client.end();
}
