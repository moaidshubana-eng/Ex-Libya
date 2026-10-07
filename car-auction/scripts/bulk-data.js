// توليد حجم بيانات كبير لاختبار الأداء: N سيارة إضافية مع ~10 بنود تكلفة وسجل حالات و7 صور لكل منها.
// الاستخدام: BULK_VEHICLES=20000 DATABASE_URL=... node scripts/bulk-data.js
import pg from 'pg';
import { config } from '../src/config.js';

const N = Number(process.env.BULK_VEHICLES || 20000);
const c = new pg.Client({ connectionString: config.databaseUrl, options: '-c search_path=auction,public' });
await c.connect();
const t0 = Date.now();
await c.query('BEGIN');
await c.query(`
  INSERT INTO vehicles (stock_no, vin, year, make, model, trim, body_style, exterior_color, odometer, title_type, primary_damage, status, status_changed_at, created_at)
  SELECT 'BLK-' || lpad(g::text, 6, '0'),
         -- VIN صالح الصيغة (خانة التحقق لا يفرضها قيد قاعدة البيانات)
         'BLK' || lpad(g::text, 14, '0'),
         2015 + (g % 10), (ARRAY['Toyota','Hyundai','Kia','Nissan','Ford','Chevrolet','Honda','Lexus'])[1 + g % 8],
         (ARRAY['Camry','Sonata','K5','Altima','Explorer','Malibu','Accord','ES 350'])[1 + g % 8], 'SE', (ARRAY['SEDAN','SUV','PICKUP'])[1 + g % 3],
         (ARRAY['WHITE','BLACK','SILVER','GRAY','BLUE','RED'])[1 + g % 6], 20000 + (g * 37) % 100000,
         ((ARRAY['SALVAGE','CLEAN'])::title_type[])[1 + g % 2], 'FRONT END',
         ((ARRAY['PURCHASED','AWAITING_PICKUP','AT_US_WAREHOUSE','IN_TRANSIT_SEA','AT_PORT_LIBYA','IN_CUSTOMS','IN_STOCK','SOLD','DELIVERED'])::vehicle_status[])[1 + g % 9],
         now() - (g % 90) * interval '1 day', now() - (g % 120) * interval '1 day'
    FROM generate_series(1, $1) g`, [N]);
await c.query(`
  INSERT INTO vehicle_costs (vehicle_id, category_code, amount, currency, fx_rate_to_lyd, incurred_at, is_paid)
  SELECT v.id, cc.code, 100 + (abs(hashtext(v.id::text || cc.code)) % 9000), CASE WHEN cc.stage IN ('PURCHASE','US_LOGISTICS','OCEAN') THEN 'USD' ELSE 'LYD' END,
         CASE WHEN cc.stage IN ('PURCHASE','US_LOGISTICS','OCEAN') THEN 5.5 ELSE 1 END, current_date - 10, true
    FROM vehicles v CROSS JOIN cost_categories cc
   WHERE v.stock_no LIKE 'BLK-%' AND cc.code IN ('HAMMER_PRICE','AUCTION_BUYER_FEE','AUCTION_OTHER_FEES','US_TOWING','OCEAN_FREIGHT','MARINE_INSURANCE','PORT_HANDLING','CUSTOMS_DUTY','CUSTOMS_BROKER','LY_TRANSPORT')`);
await c.query(`
  INSERT INTO vehicle_images (vehicle_id, kind, storage_key, sha256, sort_order, is_primary)
  SELECT v.id, 'EXTERIOR', 'gen://' || v.id || '/' || i, md5(v.id::text || i), i, i = 0
    FROM vehicles v CROSS JOIN generate_series(0, 6) i WHERE v.stock_no LIKE 'BLK-%'`);
await c.query(`
  INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, source, occurred_at)
  SELECT v.id, NULL, v.status, 'SYSTEM', v.created_at FROM vehicles v WHERE v.stock_no LIKE 'BLK-%'`);
await c.query('COMMIT');
await c.query('ANALYZE');
const { rows: [n] } = await c.query(`SELECT (SELECT count(*) FROM vehicles) v, (SELECT count(*) FROM vehicle_costs) c, (SELECT count(*) FROM vehicle_images) i`);
console.log(`bulk: vehicles=${n.v} costs=${n.c} images=${n.i} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await c.end();
