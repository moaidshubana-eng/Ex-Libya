import { query, tx, audit } from '../db.js';
import { rateToLyd } from './costs.js';
import { vinError } from '../domain/vin.js';
import { canTransition, manualNextStatuses, STATUS_LABEL } from '../domain/status.js';
import { HttpError } from '../security/middleware.js';

/**
 * تغيير حالة السيارة داخل معاملة قائمة (client). المصدر الوحيد لتغيير الحالة
 * في الكود: يستخدمه المستخدم يدويًا، المزامنة الآلية، وإغلاق المزاد.
 */
export async function changeStatus(client, vehicleId, to, { actorId = null, source = 'MANUAL', reason = null, expectedVersion = null, ip = null } = {}) {
  const { rows } = await client.query('SELECT id, status, hold_return_status, version FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
  const v = rows[0];
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
  if (expectedVersion != null && v.version !== expectedVersion)
    throw new HttpError(409, 'STALE', 'تم تعديل السيارة من مستخدم آخر — أعد تحميل الصفحة');
  if (!canTransition(v.status, to, v.hold_return_status))
    throw new HttpError(422, 'BAD_TRANSITION', `لا يمكن الانتقال من "${STATUS_LABEL[v.status]}" إلى "${STATUS_LABEL[to]}"`);
  if (to === 'ON_HOLD' && !reason) throw new HttpError(422, 'REASON_REQUIRED', 'سبب التعليق مطلوب');

  const { rows: upd } = await client.query(
    `UPDATE vehicles SET status = $2::vehicle_status, hold_reason = CASE WHEN $2::vehicle_status = 'ON_HOLD' THEN $3 ELSE hold_reason END,
            hold_return_status = CASE WHEN $2::vehicle_status = 'ON_HOLD' THEN status ELSE hold_return_status END,
            version = version + 1
      WHERE id = $1 RETURNING id, status, version`,
    [vehicleId, to, reason],
  );
  await client.query(
    `INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, source, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [vehicleId, v.status, to, source, reason, actorId],
  );
  await audit(client, { actorId, action: 'VEHICLE_STATUS_CHANGED', entity: 'vehicle', entityId: vehicleId, before: { status: v.status }, after: { status: to, reason, source }, ip });
  return upd[0];
}

const SORTS = {
  newest: 'v.created_at DESC',
  year_desc: 'v.year DESC, v.make',
  price_asc: 'v.list_price_lyd ASC NULLS LAST',
  price_desc: 'v.list_price_lyd DESC NULLS LAST',
  status: 'v.status, v.status_changed_at DESC',
  eta: 'sh.eta ASC NULLS LAST',
};

/**
 * قائمة السيارات على مرحلتين لأداء ثابت مع أي حجم أسطول:
 *  (1) اختيار معرّفات الصفحة فقط (مرشحات عبر EXISTS، بلا تجميع تكاليف)،
 *  (2) جلب التفاصيل والتكلفة المجمعة لهذه المعرّفات فقط (24 سيارة لا 20 ألفًا).
 */
export async function listVehicles(f, { includeCosts }) {
  const where = [];
  const params = [];
  const p = (v) => (params.push(v), `$${params.length}`);
  if (f.status) where.push(`v.status = ANY(${p(String(f.status).split(','))}::vehicle_status[])`);
  if (f.make) where.push(`v.make = ${p(f.make)}`);
  if (f.source) where.push(`EXISTS (SELECT 1 FROM source_listings s JOIN external_sources es ON es.id = s.source_id WHERE s.vehicle_id = v.id AND es.code = ${p(f.source)})`);
  if (f.port) where.push(`pod.code = ${p(f.port)}`);
  if (f.yearFrom) where.push(`v.year >= ${p(Number(f.yearFrom))}`);
  if (f.yearTo) where.push(`v.year <= ${p(Number(f.yearTo))}`);
  if (f.titleType) where.push(`v.title_type = ${p(f.titleType)}`);
  if (f.q) {
    const q = String(f.q).trim().slice(0, 60);
    const like = p(`%${q}%`);
    const exact = p(q);
    where.push(`(v.vin ILIKE ${like} OR v.stock_no ILIKE ${like} OR (v.make || ' ' || v.model) ILIKE ${like} OR sh.container_no ILIKE ${like}
                 OR EXISTS (SELECT 1 FROM source_listings s WHERE s.vehicle_id = v.id AND s.lot_number = ${exact}))`);
  }
  if (f.forBidder) where.push(`v.status IN ('IN_AUCTION','IN_STOCK')`);
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 24));
  const order = SORTS[f.sort] || SORTS.newest;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const fromSql = `FROM vehicles v
      LEFT JOIN shipment_vehicles sv ON sv.vehicle_id = v.id
      LEFT JOIN shipments sh ON sh.id = sv.shipment_id
      LEFT JOIN ports pod ON pod.id = sh.pod_port_id
      ${whereSql}`;

  const [{ rows: idRows }, { rows: [{ total }] }] = await Promise.all([
    query(`SELECT v.id ${fromSql} ORDER BY ${order}, v.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    query(`SELECT count(*)::int AS total ${fromSql}`, params),
  ]);
  const ids = idRows.map((r) => r.id);
  if (!ids.length) return { items: [], total, page, pageSize };

  const { rows } = await query(
    `SELECT v.id, v.stock_no, v.vin, v.year, v.make, v.model, v.trim, v.body_style, v.exterior_color,
            v.odometer, v.odometer_unit, v.title_type, v.primary_damage, v.status, v.status_changed_at,
            v.list_price_lyd, v.condition_grade, v.run_and_drive,
            es.code AS source, sl.lot_number, sh.shipment_no, sh.container_no, sh.eta, pod.name_ar AS pod_name,
            (SELECT id FROM vehicle_images i WHERE i.vehicle_id = v.id ORDER BY is_primary DESC, sort_order LIMIT 1) AS image_id,
            ${includeCosts ? `(SELECT COALESCE(sum(c.amount_lyd), 0) FROM vehicle_costs c WHERE c.vehicle_id = v.id AND c.voided_at IS NULL)` : 'NULL::numeric'} AS total_cost_lyd
       FROM vehicles v
       LEFT JOIN LATERAL (SELECT * FROM source_listings s WHERE s.vehicle_id = v.id ORDER BY first_seen_at DESC LIMIT 1) sl ON TRUE
       LEFT JOIN external_sources es ON es.id = sl.source_id
       LEFT JOIN shipment_vehicles sv ON sv.vehicle_id = v.id
       LEFT JOIN shipments sh ON sh.id = sv.shipment_id
       LEFT JOIN ports pod ON pod.id = sh.pod_port_id
      WHERE v.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { items: ids.map((id) => byId.get(id)), total, page, pageSize };
}

export async function getVehicle(id, { includeCosts, includeInternal }) {
  const { rows } = await query(
    `SELECT v.*, p.name_ar AS destination_port FROM vehicles v LEFT JOIN ports p ON p.id = v.destination_port_id WHERE v.id = $1`, [id]);
  const v = rows[0];
  if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');

  const [images, listings, history, shipment, customs, transports, inspections, lot, sale, costs] = await Promise.all([
    query(`SELECT id, kind, caption, width, height, is_primary, sort_order FROM vehicle_images WHERE vehicle_id = $1 ORDER BY is_primary DESC, sort_order`, [id]),
    query(`SELECT sl.lot_number, sl.listing_url, sl.yard_name, sl.yard_state, sl.sale_date, sl.sale_status, sl.acv_usd,
                  sl.repair_estimate_usd, sl.purchase_price_usd, sl.last_synced_at, es.code AS source, es.name AS source_name
             FROM source_listings sl JOIN external_sources es ON es.id = sl.source_id WHERE sl.vehicle_id = $1`, [id]),
    includeInternal ? query(`SELECT h.from_status, h.to_status, h.source, h.reason, h.occurred_at, u.full_name AS changed_by
             FROM vehicle_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.vehicle_id = $1 ORDER BY h.occurred_at, h.id`, [id]) : { rows: [] },
    query(`SELECT sh.id, sh.shipment_no, sh.booking_no, sh.bill_of_lading, sh.container_no, sh.container_type, sh.vessel_name, sh.voyage_no,
                  sh.etd, sh.atd, sh.eta, sh.ata, sh.status, pol.name_ar AS pol, pod.name_ar AS pod, c.name AS carrier, sv.position,
                  (SELECT json_agg(e ORDER BY e.occurred_at) FROM (SELECT event_code, description, location, occurred_at FROM shipment_events WHERE shipment_id = sh.id) e) AS events
             FROM shipment_vehicles sv JOIN shipments sh ON sh.id = sv.shipment_id
             JOIN ports pol ON pol.id = sh.pol_port_id JOIN ports pod ON pod.id = sh.pod_port_id
             LEFT JOIN vendors c ON c.id = sh.carrier_id WHERE sv.vehicle_id = $1`, [id]),
    includeInternal ? query(`SELECT cd.id, cd.declaration_no, cd.status, cd.submitted_at, cd.assessed_value_lyd, cd.duty_amount_lyd, cd.released_at,
                  cd.rejection_reason, p.name_ar AS port, b.name AS broker
             FROM customs_declarations cd JOIN ports p ON p.id = cd.port_id LEFT JOIN vendors b ON b.id = cd.broker_id WHERE cd.vehicle_id = $1`, [id]) : { rows: [] },
    includeInternal ? query(`SELECT t.leg, t.from_location, t.to_location, t.status, t.planned_at, t.picked_up_at, t.delivered_at, vd.name AS vendor
             FROM inland_transports t LEFT JOIN vendors vd ON vd.id = t.vendor_id WHERE t.vehicle_id = $1 ORDER BY t.created_at`, [id]) : { rows: [] },
    query(`SELECT stage, grade, findings, notes, inspected_at FROM vehicle_inspections WHERE vehicle_id = $1 ORDER BY inspected_at`, [id]),
    query(`SELECT l.id, l.lot_no, l.status, l.current_price, l.bid_count, l.ends_at, e.title AS event_title
             FROM auction_lots l JOIN auction_events e ON e.id = l.auction_event_id
            WHERE l.vehicle_id = $1 ORDER BY l.starts_at DESC LIMIT 1`, [id]),
    includeInternal ? query(`SELECT s.invoice_no, s.sale_type, s.sale_price_lyd, s.sold_at, c.full_name AS customer,
                  COALESCE((SELECT sum(amount * fx_rate_to_lyd) FROM payments WHERE sale_id = s.id),0)::numeric(14,3) AS paid_lyd
             FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.vehicle_id = $1`, [id]) : { rows: [] },
    includeCosts ? getVehicleCosts(id) : null,
  ]);

  const out = {
    ...v,
    images: images.rows,
    listings: listings.rows.map((l) => (includeInternal ? l : { source: l.source, source_name: l.source_name, lot_number: l.lot_number, yard_state: l.yard_state })),
    history: history.rows,
    shipment: shipment.rows[0] || null,
    customs: customs.rows[0] || null,
    transports: transports.rows,
    inspections: inspections.rows,
    lot: lot.rows[0] || null,
    sale: sale.rows[0] || null,
    costs,
    next_statuses: includeInternal ? manualNextStatuses(v.status, v.hold_return_status) : [],
  };
  if (!includeInternal) {
    for (const k of ['notes', 'locked_fields', 'hold_reason', 'hold_return_status', 'version']) delete out[k];
  }
  return out;
}

export async function getVehicleCosts(vehicleId) {
  const [{ rows: items }, { rows: summary }] = await Promise.all([
    query(`SELECT c.id, c.category_code, cc.name_ar AS category, cc.stage, c.description, c.amount, c.currency, c.fx_rate_to_lyd,
                  c.amount_lyd, c.status, c.invoice_ref, c.incurred_at, c.is_paid, c.shared_cost_id IS NOT NULL AS is_shared,
                  vd.name AS vendor, u.full_name AS created_by, c.created_at
             FROM vehicle_costs c JOIN cost_categories cc ON cc.code = c.category_code
             LEFT JOIN vendors vd ON vd.id = c.vendor_id LEFT JOIN users u ON u.id = c.created_by
            WHERE c.vehicle_id = $1 AND c.voided_at IS NULL ORDER BY cc.sort_order, c.incurred_at`, [vehicleId]),
    query(`SELECT * FROM v_vehicle_landed_cost WHERE vehicle_id = $1`, [vehicleId]),
  ]);
  return { items, summary: summary[0] || null };
}

export async function compareVehicles(ids, opts) {
  return Promise.all(ids.map((id) => getVehicle(id, opts)));
}

const EDITABLE = {
  year: 'year', make: 'make', model: 'model', trim: 'trim', bodyStyle: 'body_style', exteriorColor: 'exterior_color', interiorColor: 'interior_color',
  engine: 'engine', transmission: 'transmission', driveType: 'drive_type', fuelType: 'fuel_type', odometer: 'odometer', odometerUnit: 'odometer_unit',
  titleType: 'title_type', titleState: 'title_state', primaryDamage: 'primary_damage', secondaryDamage: 'secondary_damage', hasKeys: 'has_keys',
  runAndDrive: 'run_and_drive', conditionGrade: 'condition_grade', listPriceLyd: 'list_price_lyd', notes: 'notes',
};

/**
 * إدخال سيارة يدويًا (بدون ربط آلي): تُنشأ بحالة PURCHASED مع رقم مخزون، وتُسجَّل تكاليف الشراء بالدولار
 * بسعر صرف يوم الشراء، ويُحفظ رقم اللوت في المصدر إن وُجد. إن فُعِّل الربط لاحقًا فسيُطابَق اللوت/VIN
 * مع هذا السجل نفسه فلا يتكرر.
 */
export async function createVehicle(b, actor) {
  const ve = vinError(b.vin);
  if (ve) throw new HttpError(422, 'BAD_VIN', ve);
  const vin = b.vin.trim().toUpperCase();
  return tx(async (c) => {
    const { rows: dup } = await c.query('SELECT stock_no FROM vehicles WHERE vin = $1', [vin]);
    if (dup[0]) throw new HttpError(409, 'DUPLICATE_VIN', `هذه السيارة مسجلة مسبقًا برقم المخزون ${dup[0].stock_no}`);
    let srcId = null;
    if (b.source && b.source !== 'OTHER') {
      srcId = (await c.query('SELECT id FROM external_sources WHERE code = $1', [b.source])).rows[0]?.id;
      if (b.lotNumber) {
        const { rows: l } = await c.query('SELECT v.stock_no FROM source_listings s JOIN vehicles v ON v.id = s.vehicle_id WHERE s.source_id = $1 AND s.lot_number = $2', [srcId, b.lotNumber]);
        if (l[0]) throw new HttpError(409, 'DUPLICATE_LOT', `رقم اللوت مسجل مسبقًا على السيارة ${l[0].stock_no}`);
      }
    }
    const port = (await c.query('SELECT id FROM ports WHERE code = $1', [b.destinationPort || 'LYMRA'])).rows[0];
    const { rows: [v] } = await c.query(
      `INSERT INTO vehicles (stock_no, vin, year, make, model, trim, body_style, exterior_color, odometer, odometer_unit, title_type, primary_damage,
                             has_keys, run_and_drive, destination_port_id, notes)
       VALUES ('LY-' || to_char(now(),'YYYY') || '-' || lpad(nextval('stock_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, stock_no`,
      [vin, b.year, b.make, b.model, b.trim || null, b.bodyStyle || null, b.exteriorColor || null, b.odometer ?? null, b.odometerUnit || 'mi',
        b.titleType || 'OTHER', b.primaryDamage || null, b.hasKeys ?? null, b.runAndDrive ?? null, port?.id || null, b.notes || null]);
    await c.query(`INSERT INTO vehicle_status_history (vehicle_id, from_status, to_status, source, reason, changed_by) VALUES ($1, NULL, 'PURCHASED', 'MANUAL', 'إدخال يدوي', $2)`, [v.id, actor.id]);
    const date = b.purchaseDate || new Date().toISOString().slice(0, 10);
    if (b.source && b.source !== 'OTHER' && b.lotNumber) {
      await c.query(
        `INSERT INTO source_listings (vehicle_id, source_id, lot_number, sale_date, sale_status, purchase_price_usd, raw_payload, payload_hash)
         VALUES ($1,$2,$3,$4,'SOLD',$5,$6,$7)`,
        [v.id, srcId, b.lotNumber, date, b.purchasePriceUsd || null, JSON.stringify({ manual: true, enteredBy: actor.id }), `manual:${v.id}`]);
    }
    const lines = [['HAMMER_PRICE', b.purchasePriceUsd, 'سعر الشراء'], ['AUCTION_BUYER_FEE', b.buyerFeeUsd, 'رسوم المشتري'], ['AUCTION_OTHER_FEES', b.otherFeesUsd, 'رسوم مزاد أخرى']]
      .filter(([, amount]) => amount && Number(amount) > 0);
    if (lines.length) {
      const fx = await rateToLyd(c, 'USD', date);
      for (const [code, amount, desc] of lines) {
        await c.query(
          `INSERT INTO vehicle_costs (vehicle_id, category_code, description, amount, currency, fx_rate_to_lyd, status, incurred_at, invoice_ref, is_paid, created_by)
           VALUES ($1,$2,$3,$4,'USD',$5,'ACTUAL',$6,$7,false,$8)`,
          [v.id, code, `${desc}${b.lotNumber ? ` — لوت ${b.lotNumber}` : ''}`, amount, fx, date, b.lotNumber ? `LOT-${b.lotNumber}` : null, actor.id]);
      }
    }
    await audit(c, { actorId: actor.id, action: 'VEHICLE_CREATED', entity: 'vehicle', entityId: v.id, after: { stock_no: v.stock_no, vin, manual: true }, ip: actor.ip });
    return v;
  });
}

/** تعديل بيانات السيارة. الحقول المعدَّلة تُقفل (locked_fields) فلا تكتب فوقها المزامنة لاحقًا إن فُعِّل الربط. */
export async function updateVehicle(id, b, actor) {
  const { version, ...fields } = b;
  return tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM vehicles WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
    if (version != null && cur.version !== version) throw new HttpError(409, 'STALE', 'تم تعديل السيارة من مستخدم آخر — أعد تحميل الصفحة');
    const sets = [], vals = [id], locked = new Set(cur.locked_fields || []), before = {}, after = {};
    for (const [k, v] of Object.entries(fields)) {
      const col = EDITABLE[k];
      if (!col || String(cur[col] ?? '') === String(v)) continue;
      vals.push(v); sets.push(`${col} = $${vals.length}`); locked.add(col); before[col] = cur[col]; after[col] = v;
    }
    if (!sets.length) return { id, unchanged: true, version: cur.version };
    vals.push([...locked]);
    const { rows: [upd] } = await c.query(`UPDATE vehicles SET ${sets.join(', ')}, locked_fields = $${vals.length}, version = version + 1 WHERE id = $1 RETURNING id, version`, vals);
    await audit(c, { actorId: actor.id, action: 'VEHICLE_UPDATED', entity: 'vehicle', entityId: id, before, after, ip: actor.ip });
    return upd;
  });
}
