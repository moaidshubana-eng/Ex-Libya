// محرك المزامنة مع المصادر الخارجية.
//
// الضمانات:
//  * عدم التداخل: فهرس فريد جزئي يمنع جولتين متزامنتين لنفس (المصدر، النوع) حتى عبر عدة خوادم.
//  * عدم التكرار (Idempotency): بصمة SHA-256 للحمولة؛ إن لم تتغير لا يُكتب شيء.
//  * عزل الأخطاء: فشل عنصر واحد لا يوقف الجولة — يُعاد مرتين ثم يذهب إلى sync_dead_letters.
//  * قاطع الدائرة: بعد 3 جولات فاشلة متتالية يُوقف المصدر مؤقتًا بمهلة تتضاعف (حتى ساعتين).
//  * احترام التعديل اليدوي: الحقول في vehicles.locked_fields لا تكتب فوقها المزامنة.
//  * الحالة تتقدم للأمام فقط وعبر مسار الانتقالات المسموحة (تُسجَّل كل خطوة وسيطة).
import { pool, query, tx, audit } from '../db.js';
import { config } from '../config.js';
import { sha256 } from '../security/crypto.js';
import { forwardPath, pathIndex } from '../domain/status.js';
import { changeStatus } from '../services/vehicles.js';
import { rateToLyd } from '../services/costs.js';
import { createCopartAdapter, NormalizeError } from './adapters/copart.js';
import { createIaaiAdapter } from './adapters/iaai.js';
import { createTrackingAdapter } from './adapters/tracking.js';
import { normalizeCsvRow, parseCsv } from './adapters/csv.js';

export class SyncBusy extends Error {}
export class CircuitOpen extends Error {}

const ITEM_RETRIES = 2;

export function getAdapter(code, overrides = {}) {
  const local = `http://127.0.0.1:${config.port}/mock`;
  const src = config.sources[code] || {};
  const base = overrides.baseUrl || src.baseUrl || (config.mockFeeds ? `${local}/${code.toLowerCase()}` : null);
  if (!base) throw new Error(`المصدر ${code} غير مهيأ — اضبط ${code}_FEED_URL`);
  const opts = { baseUrl: base, token: src.token, onRetry: overrides.onRetry };
  if (code === 'COPART') return createCopartAdapter(opts);
  if (code === 'IAAI') return createIaaiAdapter(opts);
  if (code === 'TRACKING') return createTrackingAdapter(opts);
  throw new Error(`لا يوجد محوّل للمصدر ${code}`);
}

const LOGISTICS_TARGET = { PAID: 'AWAITING_PICKUP', PICKED_UP: 'US_INLAND_TRANSIT', DELIVERED_TO_WAREHOUSE: 'AT_US_WAREHOUSE' };

// الحقول الفنية التي تُحدَّث من المصدر (ما لم تكن مقفلة يدويًا)
const SPEC_FIELDS = {
  year: 'year', make: 'make', model: 'model', trim: 'trim', bodyStyle: 'body_style', exteriorColor: 'exterior_color',
  engine: 'engine', cylinders: 'cylinders', fuelType: 'fuel_type', transmission: 'transmission', driveType: 'drive_type',
  odometer: 'odometer', odometerUnit: 'odometer_unit', odometerBrand: 'odometer_brand', titleType: 'title_type',
  titleState: 'title_state', primaryDamage: 'primary_damage', secondaryDamage: 'secondary_damage', hasKeys: 'has_keys', runAndDrive: 'run_and_drive',
};

async function startJob(sourceCode, jobType, triggeredBy) {
  const { rows: [src] } = await query('SELECT * FROM external_sources WHERE code = $1', [sourceCode]);
  if (!src) throw new Error(`مصدر غير معروف: ${sourceCode}`);
  if (!src.is_active) throw new Error(`المصدر ${sourceCode} معطّل`);
  if (src.circuit_open_until && new Date(src.circuit_open_until) > new Date() && !String(triggeredBy).startsWith('USER'))
    throw new CircuitOpen(`قاطع الدائرة مفتوح للمصدر ${sourceCode} حتى ${new Date(src.circuit_open_until).toISOString()}`);
  try {
    const { rows: [job] } = await query(
      `INSERT INTO sync_jobs (source_id, job_type, status, triggered_by, cursor_from, started_at) VALUES ($1,$2,'RUNNING',$3,$4,now()) RETURNING *`,
      [src.id, jobType, triggeredBy, src.last_cursor]);
    return { src, job };
  } catch (e) {
    if (e.code === '23505') throw new SyncBusy(`مزامنة ${sourceCode} جارية بالفعل`);
    throw e;
  }
}

async function finishJob(src, job, stats, { error = null, cursor = null } = {}) {
  const status = error ? 'FAILED' : stats.failed ? 'PARTIAL' : 'SUCCEEDED';
  await query(
    `UPDATE sync_jobs SET status = $2, items_seen = $3, items_created = $4, items_updated = $5, items_unchanged = $6, items_failed = $7,
            error = $8, cursor_to = $9, finished_at = now() WHERE id = $1`,
    [job.id, status, stats.seen, stats.created, stats.updated, stats.unchanged, stats.failed, error, cursor]);
  if (error) {
    // تضاعف مهلة الإيقاف: 15د، 30د، 60د، 120د كحد أقصى
    await query(
      `UPDATE external_sources SET consecutive_failures = consecutive_failures + 1,
              circuit_open_until = CASE WHEN consecutive_failures + 1 >= 3
                THEN now() + least(interval '2 hours', interval '15 minutes' * power(2, consecutive_failures + 1 - 3)) END
        WHERE id = $1`, [src.id]);
  } else {
    await query(
      `UPDATE external_sources SET consecutive_failures = 0, circuit_open_until = NULL, last_success_at = now(),
              last_cursor = COALESCE($2, last_cursor) WHERE id = $1`, [src.id, cursor]);
  }
  return { jobId: job.id, status, ...stats, error };
}

async function deadLetter(src, job, ref, payload, err, attempts) {
  await query(
    `INSERT INTO sync_dead_letters (job_id, source_id, external_ref, payload, error, attempts) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (source_id, external_ref) WHERE resolved_at IS NULL
     DO UPDATE SET attempts = sync_dead_letters.attempts + EXCLUDED.attempts, error = EXCLUDED.error, job_id = EXCLUDED.job_id, payload = EXCLUDED.payload`,
    [job?.id ?? null, src.id, String(ref ?? 'unknown'), payload ? JSON.stringify(payload) : null, String(err.message).slice(0, 1000), attempts]);
}

/** مزامنة مشتريات مصدر (Copart/IAAI). تعيد ملخص الجولة. */
export async function syncPurchases(sourceCode, { triggeredBy = 'SCHEDULER', adapter = null } = {}) {
  const { src, job } = await startJob(sourceCode, 'PURCHASES_IMPORT', triggeredBy);
  const stats = { seen: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
  let cursor = null;
  try {
    const a = adapter || getAdapter(sourceCode);
    // نطلب من المؤشر السابق ناقص 5 دقائق (هامش لتأخر الساعة بين الخادمين) — البصمة تمنع إعادة الكتابة
    const since = src.last_cursor ? new Date(Date.parse(src.last_cursor) - 5 * 60_000).toISOString() : null;
    for await (const page of a.fetchPurchases({ since })) {
      cursor = page.cursor || cursor;
      for (const raw of page.items) {
        stats.seen++;
        const r = await processWithRetry(src, job, a.normalize, raw);
        stats[r]++;
      }
    }
    return await finishJob(src, job, stats, { cursor });
  } catch (e) {
    return await finishJob(src, job, stats, { error: String(e.message).slice(0, 1000) });
  }
}

async function processWithRetry(src, job, normalize, raw) {
  let norm;
  try {
    norm = normalize(raw);
  } catch (e) {
    // خطأ بيانات (لا فائدة من إعادة المحاولة) → طابور الأخطاء مباشرة
    await deadLetter(src, job, raw?.lotNumber ?? raw?.stockNumber ?? raw?.lot_number, raw, e, 1);
    return 'failed';
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await upsertPurchase(src, norm, raw);
      // نجاح لاحق لنفس العنصر يُغلق أخطاءه السابقة المفتوحة تلقائيًا
      await query(`UPDATE sync_dead_letters SET resolved_at = now() WHERE source_id = $1 AND external_ref = $2 AND resolved_at IS NULL`, [src.id, norm.externalRef]);
      return result;
    } catch (e) {
      const transient = ['40001', '40P01', '55P03', '57014'].includes(e.code) || /ECONNRESET|timeout/i.test(e.message);
      if (transient && attempt <= ITEM_RETRIES) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      await deadLetter(src, job, norm.externalRef, raw, e, attempt);
      return 'failed';
    }
  }
}

/** دمج عنصر واحد (معاملة مستقلة) — يعيد created | updated | unchanged */
export async function upsertPurchase(src, n, raw) {
  const hash = sha256(raw);
  return tx(async (c) => {
    const { rows: [listing] } = await c.query(
      'SELECT id, vehicle_id, payload_hash FROM source_listings WHERE source_id = $1 AND lot_number = $2 FOR UPDATE', [src.id, n.externalRef]);
    if (listing && listing.payload_hash === hash) {
      await c.query('UPDATE source_listings SET last_synced_at = now() WHERE id = $1', [listing.id]);
      return 'unchanged';
    }

    let vehicleId = listing?.vehicle_id;
    let created = false;
    if (!vehicleId) {
      const { rows } = await c.query('SELECT id FROM vehicles WHERE vin = $1', [n.vin]);
      vehicleId = rows[0]?.id;
    }
    if (!vehicleId) {
      const { rows: [v] } = await c.query(
        `INSERT INTO vehicles (stock_no, vin, year, make, model, trim, body_style, exterior_color, engine, cylinders, fuel_type, transmission, drive_type,
                               odometer, odometer_unit, odometer_brand, title_type, title_state, primary_damage, secondary_damage, has_keys, run_and_drive, destination_port_id)
         VALUES ('LY-' || to_char(now(),'YYYY') || '-' || lpad(nextval('stock_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 (SELECT id FROM ports WHERE code = 'LYMRA'))
         RETURNING id`,
        [n.vin, n.year, n.make, n.model, n.trim, n.bodyStyle, n.exteriorColor, n.engine, n.cylinders, n.fuelType, n.transmission, n.driveType,
          n.odometer, n.odometerUnit, n.odometerBrand, n.titleType, n.titleState, n.primaryDamage, n.secondaryDamage, n.hasKeys, n.runAndDrive]);
      vehicleId = v.id;
      created = true;
      await c.query(`INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, source, reason) VALUES ($1, NULL, 'PURCHASED', 'SYNC', $2)`,
        [vehicleId, `استيراد آلي من ${src.code} — لوت ${n.externalRef}`]);
      await addPurchaseCosts(c, vehicleId, n);
    } else {
      // تحديث الحقول الفنية غير المقفلة فقط، وفقط إن تغيّرت
      const { rows: [cur] } = await c.query('SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
      const locked = new Set(cur.locked_fields || []);
      const sets = [];
      const vals = [vehicleId];
      for (const [k, col] of Object.entries(SPEC_FIELDS)) {
        if (n[k] === undefined || n[k] === null || locked.has(col)) continue;
        if (String(cur[col]) === String(n[k])) continue;
        vals.push(n[k]);
        sets.push(`${col} = $${vals.length}`);
      }
      if (sets.length) await c.query(`UPDATE vehicles SET ${sets.join(', ')}, version = version + 1 WHERE id = $1`, vals);
    }

    await c.query(
      `INSERT INTO source_listings (vehicle_id, source_id, lot_number, listing_url, yard_name, yard_state, yard_zip, sale_date, sale_status, acv_usd,
                                    repair_estimate_usd, purchase_price_usd, payment_due_at, pickup_deadline_at, raw_payload, payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (source_id, lot_number) DO UPDATE SET vehicle_id = EXCLUDED.vehicle_id, yard_name = EXCLUDED.yard_name, sale_status = EXCLUDED.sale_status,
         acv_usd = EXCLUDED.acv_usd, repair_estimate_usd = EXCLUDED.repair_estimate_usd, purchase_price_usd = EXCLUDED.purchase_price_usd,
         payment_due_at = EXCLUDED.payment_due_at, pickup_deadline_at = EXCLUDED.pickup_deadline_at,
         raw_payload = EXCLUDED.raw_payload, payload_hash = EXCLUDED.payload_hash, last_synced_at = now()`,
      [vehicleId, src.id, n.externalRef, n.listingUrl, n.yardName, n.yardState, n.yardZip, n.saleDate, n.saleStatus, n.acvUsd,
        n.repairEstimateUsd, n.purchasePriceUsd, n.paymentDueAt, n.pickupDeadlineAt, JSON.stringify(raw), hash]);

    // الصور: نسجل المرجع؛ عامل الصور (images worker) ينزّلها لاحقًا إلى التخزين الدائم ويحسب الأبعاد
    for (const [i, im] of (n.images || []).entries()) {
      await c.query(
        `INSERT INTO vehicle_images (vehicle_id, source_id, kind, original_url, storage_key, sha256, sort_order, is_primary, width, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1600,1200) ON CONFLICT DO NOTHING`,
        [vehicleId, src.id, im.kind, im.url, `gen://${vehicleId}/${i}`, sha256(im.url), i,
          i === 0 && created]);
    }

    await advanceFromSource(c, vehicleId, n.logisticsStatus, src.code);
    return created ? 'created' : 'updated';
  });
}

async function addPurchaseCosts(c, vehicleId, n) {
  const date = (n.saleDate || new Date().toISOString()).slice(0, 10);
  const lines = [
    ['HAMMER_PRICE', n.purchasePriceUsd, 'سعر الشراء (من المصدر)'],
    ['AUCTION_BUYER_FEE', n.buyerFeeUsd, 'رسوم المشتري (من المصدر)'],
    ['AUCTION_OTHER_FEES', n.otherFeesUsd, 'رسوم بوابة/بيئة/مزايدة إلكترونية'],
  ].filter(([, amt]) => amt != null && Number(amt) > 0);
  if (!lines.length) return;
  const fx = await rateToLyd(c, 'USD', date);
  for (const [code, amount, desc] of lines) {
    await c.query(
      `INSERT INTO vehicle_costs (vehicle_id, category_code, description, amount, currency, fx_rate_to_lyd, status, incurred_at, invoice_ref)
       VALUES ($1,$2,$3,$4,'USD',$5,'ACTUAL',$6,$7)`,
      [vehicleId, code, desc, String(amount), fx, date, `SRC-${n.externalRef}`]);
  }
}

async function advanceFromSource(c, vehicleId, logisticsStatus, sourceCode) {
  if (!logisticsStatus) return;
  const { rows: [v] } = await c.query('SELECT status FROM vehicles WHERE id = $1', [vehicleId]);
  if (logisticsStatus === 'CANCELLED') {
    if (['PURCHASED', 'AWAITING_PICKUP'].includes(v.status))
      await changeStatus(c, vehicleId, 'CANCELLED', { source: 'SYNC', reason: `ألغى المصدر ${sourceCode} عملية البيع` });
    return;
  }
  const target = LOGISTICS_TARGET[logisticsStatus];
  if (!target || pathIndex(v.status) < 0 || pathIndex(v.status) >= pathIndex(target)) return; // لا رجوع للخلف ولا تجاوز للمعلقة
  const path = forwardPath(v.status, target);
  if (!path) return;
  for (const step of path) await changeStatus(c, vehicleId, step, { source: 'SYNC', reason: `تحديث آلي من ${sourceCode}` });
}

/** تتبع الحاويات: يحدّث الشحنات المفتوحة وأحداثها وينقل حالة سياراتها */
export async function syncTracking({ triggeredBy = 'SCHEDULER', adapter = null } = {}) {
  const { src, job } = await startJob('TRACKING', 'SHIPMENT_TRACKING', triggeredBy);
  const stats = { seen: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
  try {
    const a = adapter || getAdapter('TRACKING');
    const { rows: shipments } = await query(
      `SELECT id, shipment_no, container_no, status FROM shipments WHERE container_no IS NOT NULL AND status NOT IN ('CLOSED','CANCELLED','DISCHARGED') ORDER BY eta NULLS LAST`);
    for (const sh of shipments) {
      stats.seen++;
      try {
        const t = await a.fetchContainer(sh.container_no);
        const changed = await applyTracking(sh, t);
        await query(`UPDATE sync_dead_letters SET resolved_at = now() WHERE source_id = $1 AND external_ref = $2 AND resolved_at IS NULL`, [src.id, sh.container_no]);
        stats[changed ? 'updated' : 'unchanged']++;
      } catch (e) {
        stats.failed++;
        await deadLetter(src, job, sh.container_no, { shipment: sh.shipment_no }, e, 1);
      }
    }
    return await finishJob(src, job, stats, { cursor: new Date().toISOString() });
  } catch (e) {
    return await finishJob(src, job, stats, { error: String(e.message).slice(0, 1000) });
  }
}

const SHIP_ORDER = ['BOOKED', 'LOADING', 'DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT', 'ARRIVED', 'DISCHARGED', 'CLOSED'];

async function applyTracking(sh, t) {
  return tx(async (c) => {
    let inserted = 0;
    for (const e of t.events) {
      const r = await c.query(
        `INSERT INTO shipment_events (shipment_id, event_code, description, location, occurred_at, source, external_id)
         VALUES ($1,$2,$3,$4,$5,'SYNC',$6) ON CONFLICT DO NOTHING`, [sh.id, e.code, e.description, e.location, e.occurredAt, e.externalId]);
      inserted += r.rowCount;
    }
    const forward = t.status && SHIP_ORDER.indexOf(t.status) > SHIP_ORDER.indexOf(sh.status);
    if (!inserted && !forward) return false;
    await c.query(
      `UPDATE shipments SET status = CASE WHEN $2::shipment_status IS NOT NULL AND $3 THEN $2::shipment_status ELSE status END,
              vessel_name = COALESCE(vessel_name, $4), voyage_no = COALESCE(voyage_no, $5), eta = COALESCE($6::date, eta),
              atd = COALESCE(atd, $7::date), ata = COALESCE(ata, $8::date), last_tracking_at = now(), updated_at = now() WHERE id = $1`,
      [sh.id, t.status, !!forward, t.vessel, t.voyage, t.eta, t.atd, t.ata]);
    // انعكاس حالة الشحنة على السيارات
    const target = ['ARRIVED', 'DISCHARGED'].includes(t.status) ? 'AT_PORT_LIBYA' : ['IN_TRANSIT', 'DEPARTED', 'TRANSSHIPMENT'].includes(t.status) ? 'IN_TRANSIT_SEA' : null;
    if (target) {
      const { rows: cars } = await c.query('SELECT v.id, v.status FROM shipment_vehicles sv JOIN vehicles v ON v.id = sv.vehicle_id WHERE sv.shipment_id = $1', [sh.id]);
      for (const car of cars) {
        if (pathIndex(car.status) < 0 || pathIndex(car.status) >= pathIndex(target)) continue;
        const path = forwardPath(car.status, target);
        if (!path) continue;
        for (const step of path) await changeStatus(c, car.id, step, { source: 'SYNC', reason: `تتبع الحاوية ${sh.container_no}: ${t.status}` });
      }
    }
    return true;
  });
}

/** استيراد ملف CSV عبر نفس خط المعالجة */
export async function importCsv(text, actor) {
  const { src, job } = await startJob('CSV', 'PURCHASES_IMPORT', `USER:${actor.id}`);
  const stats = { seen: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
  try {
    const rows = parseCsv(text);
    if (rows.length > 5000) throw new Error('الملف أكبر من 5000 سطر — قسّمه');
    for (const r of rows) {
      stats.seen++;
      const res = await processWithRetry(src, job, normalizeCsvRow, r);
      stats[res]++;
    }
    await audit(null, { actorId: actor.id, action: 'CSV_IMPORTED', entity: 'sync_job', entityId: job.id, after: stats, ip: actor.ip });
    return await finishJob(src, job, stats, { cursor: new Date().toISOString() });
  } catch (e) {
    return await finishJob(src, job, stats, { error: String(e.message).slice(0, 1000) });
  }
}

/** إعادة معالجة عنصر من طابور الأخطاء (بعد تصحيح السبب) */
export async function retryDeadLetter(id, actor) {
  const { rows: [dl] } = await query(
    `SELECT d.*, s.code FROM sync_dead_letters d JOIN external_sources s ON s.id = d.source_id WHERE d.id = $1 AND d.resolved_at IS NULL`, [id]);
  if (!dl) return { ok: false, error: 'العنصر غير موجود أو تمت معالجته' };
  const { rows: [src] } = await query('SELECT * FROM external_sources WHERE id = $1', [dl.source_id]);
  try {
    if (dl.code === 'TRACKING') {
      const { rows: [sh] } = await query('SELECT id, shipment_no, container_no, status FROM shipments WHERE container_no = $1', [dl.external_ref]);
      if (!sh) throw new Error('الشحنة غير موجودة');
      const changed = await applyTracking(sh, await getAdapter('TRACKING').fetchContainer(sh.container_no));
      await query('UPDATE sync_dead_letters SET resolved_at = now(), resolved_by = $2 WHERE id = $1', [id, actor.id]);
      return { ok: true, result: changed ? 'updated' : 'unchanged' };
    }
    if (!dl.payload) throw new Error('لا توجد حمولة محفوظة لإعادة المعالجة');
    const normalize = dl.code === 'CSV' ? normalizeCsvRow : getAdapter(dl.code).normalize;
    const result = await upsertPurchase(src, normalize(dl.payload), dl.payload);
    await query('UPDATE sync_dead_letters SET resolved_at = now(), resolved_by = $2 WHERE id = $1', [id, actor.id]);
    return { ok: true, result };
  } catch (e) {
    await query('UPDATE sync_dead_letters SET attempts = attempts + 1, error = $2 WHERE id = $1', [id, String(e.message).slice(0, 1000)]);
    return { ok: false, error: e.message };
  }
}

/**
 * المجدول: كل دقيقة يفحص المصادر المستحقة. قفل استشاري يضمن تشغيله على نسخة واحدة فقط.
 * أي مهمة عالقة (RUNNING أكثر من 30 دقيقة — تعطل الخادم أثناءها) تُعلَّم فاشلة لتحرير القفل.
 */
export async function schedulerTick() {
  const lock = await pool.connect();
  try {
    const { rows: [{ ok }] } = await lock.query('SELECT pg_try_advisory_lock(515151) AS ok');
    if (!ok) return [];
    try {
      await query(`UPDATE sync_jobs SET status = 'FAILED', error = 'انتهت المهلة (عملية عالقة)', finished_at = now()
                    WHERE status = 'RUNNING' AND started_at < now() - interval '30 minutes'`);
      const { rows: due } = await query(
        `SELECT code FROM external_sources
          WHERE is_active AND code IN ('COPART','IAAI','TRACKING')
            AND (circuit_open_until IS NULL OR circuit_open_until < now())
            AND (last_success_at IS NULL OR last_success_at < now() - make_interval(secs => sync_interval_sec))
            AND NOT EXISTS (SELECT 1 FROM sync_jobs j WHERE j.source_id = external_sources.id AND j.status = 'FAILED'
                             AND j.finished_at > now() - make_interval(secs => least(sync_interval_sec, 300)))`);
      const results = [];
      for (const { code } of due) {
        try {
          results.push(code === 'TRACKING' ? await syncTracking() : await syncPurchases(code));
        } catch (e) {
          if (!(e instanceof SyncBusy) && !(e instanceof CircuitOpen)) console.error(`[sync] ${code}:`, e.message);
        }
      }
      return results;
    } finally {
      await lock.query('SELECT pg_advisory_unlock(515151)');
    }
  } finally {
    lock.release();
  }
}

export { NormalizeError };
