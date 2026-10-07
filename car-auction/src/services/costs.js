import { query, tx, audit } from '../db.js';
import { allocate } from '../domain/money.js';
import { HttpError } from '../security/middleware.js';

/** سعر الصرف الساري في تاريخ معيّن (آخر سعر منشور في أو قبل التاريخ) */
export async function rateToLyd(client, currency, date) {
  if (currency === 'LYD') return '1';
  const { rows } = await (client || { query }).query(
    `SELECT rate_to_lyd FROM exchange_rates WHERE currency = $1 AND effective_date <= $2 ORDER BY effective_date DESC LIMIT 1`,
    [currency, date],
  );
  if (!rows[0]) throw new HttpError(422, 'NO_FX_RATE', `لا يوجد سعر صرف مسجل لعملة ${currency} في ${date} — أدخله أولًا`);
  return rows[0].rate_to_lyd;
}

export async function addCost(vehicleId, input, actor) {
  return tx(async (c) => {
    const { rows: v } = await c.query('SELECT id, status FROM vehicles WHERE id = $1', [vehicleId]);
    if (!v[0]) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
    if (v[0].status === 'CANCELLED') throw new HttpError(422, 'VEHICLE_CANCELLED', 'لا تُضاف تكاليف على سيارة ملغاة');
    const fx = input.fxRateToLyd ?? (await rateToLyd(c, input.currency, input.incurredAt));
    if (input.currency === 'LYD' && Number(fx) !== 1) throw new HttpError(422, 'BAD_FX', 'سعر صرف الدينار يجب أن يكون 1');
    const { rows } = await c.query(
      `INSERT INTO vehicle_costs (vehicle_id, category_code, vendor_id, description, amount, currency, fx_rate_to_lyd, status, invoice_ref, incurred_at, is_paid, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [vehicleId, input.categoryCode, input.vendorId || null, input.description || null, input.amount, input.currency, fx,
        input.status || 'ACTUAL', input.invoiceRef || null, input.incurredAt, input.isPaid ?? false, actor.id],
    );
    await audit(c, { actorId: actor.id, action: 'COST_ADDED', entity: 'vehicle_cost', entityId: rows[0].id, after: rows[0], ip: actor.ip });
    return rows[0];
  });
}

export async function voidCost(costId, reason, actor) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE vehicle_costs SET voided_at = now(), voided_by = $2, void_reason = $3
        WHERE id = $1 AND voided_at IS NULL AND shared_cost_id IS NULL RETURNING *`, [costId, actor.id, reason]);
    if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'التكلفة غير موجودة أو ملغاة مسبقًا أو جزء من تكلفة مشتركة (تُلغى من الشحنة)');
    await audit(c, { actorId: actor.id, action: 'COST_VOIDED', entity: 'vehicle_cost', entityId: costId, after: { reason }, ip: actor.ip });
    return rows[0];
  });
}

/**
 * تكلفة مشتركة على مستوى الشحنة (أجرة الحاوية، التحميل، التأمين…) تُوزَّع آليًا
 * على سيارات الحاوية بالتساوي أو حسب قيمة الشراء، بحيث مجموع الحصص = الإجمالي بالضبط.
 */
export async function addSharedCost(shipmentId, input, actor) {
  return tx(async (c) => {
    const { rows: cars } = await c.query(
      `SELECT sv.vehicle_id AS id,
              COALESCE((SELECT sum(amount_lyd) FROM vehicle_costs vc WHERE vc.vehicle_id = sv.vehicle_id AND vc.category_code = 'HAMMER_PRICE' AND vc.voided_at IS NULL), 0) AS weight
         FROM shipment_vehicles sv WHERE sv.shipment_id = $1 ORDER BY sv.position NULLS LAST, sv.vehicle_id`, [shipmentId]);
    if (!cars.length) throw new HttpError(422, 'EMPTY_SHIPMENT', 'لا توجد سيارات في هذه الشحنة');
    const fx = input.fxRateToLyd ?? (await rateToLyd(c, input.currency, input.incurredAt));
    const { rows: sc } = await c.query(
      `INSERT INTO shared_costs (shipment_id, category_code, vendor_id, description, total_amount, currency, fx_rate_to_lyd, method, incurred_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [shipmentId, input.categoryCode, input.vendorId || null, input.description || null, input.totalAmount, input.currency, fx, input.method, input.incurredAt, actor.id]);
    const shares = allocate(input.totalAmount, cars, input.method);
    for (const s of shares) {
      await c.query(
        `INSERT INTO vehicle_costs (vehicle_id, category_code, vendor_id, shared_cost_id, description, amount, currency, fx_rate_to_lyd, status, incurred_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTUAL',$9,$10)`,
        [s.id, input.categoryCode, input.vendorId || null, sc[0].id, `${input.description || 'تكلفة مشتركة'} (حصة من ${input.totalAmount} ${input.currency})`,
          s.amount, input.currency, fx, input.incurredAt, actor.id]);
    }
    await audit(c, { actorId: actor.id, action: 'SHARED_COST_ALLOCATED', entity: 'shipment', entityId: shipmentId, after: { ...sc[0], shares }, ip: actor.ip });
    return { sharedCost: sc[0], shares };
  });
}

const REPORT_FILTERS = {
  status: (p) => `lc.status = ANY(${p}::vehicle_status[])`,
  make: (p) => `lc.make = ${p}`,
  from: (p) => `v.created_at >= ${p}::date`,
  to: (p) => `v.created_at < (${p}::date + 1)`,
  shipment: (p) => `sh.shipment_no = ${p}`,
};

/** تقرير التكاليف التفصيلي لكل سيارة (مصدر واحد للجدول وExcel وPDF) */
export async function costReport(filters = {}) {
  const where = [];
  const params = [];
  for (const [k, build] of Object.entries(REPORT_FILTERS)) {
    if (!filters[k]) continue;
    params.push(k === 'status' ? String(filters[k]).split(',') : filters[k]);
    where.push(build(`$${params.length}`));
  }
  const { rows } = await query(
    `SELECT lc.*, sh.shipment_no, sh.container_no, es.code AS source, sl.lot_number
       FROM v_vehicle_landed_cost lc
       JOIN vehicles v ON v.id = lc.vehicle_id
       LEFT JOIN shipment_vehicles sv ON sv.vehicle_id = lc.vehicle_id
       LEFT JOIN shipments sh ON sh.id = sv.shipment_id
       LEFT JOIN LATERAL (SELECT * FROM source_listings s WHERE s.vehicle_id = lc.vehicle_id LIMIT 1) sl ON TRUE
       LEFT JOIN external_sources es ON es.id = sl.source_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY lc.stock_no`, params);

  const keys = ['purchase_lyd', 'us_logistics_lyd', 'ocean_lyd', 'libya_port_lyd', 'customs_lyd', 'libya_inland_lyd', 'preparation_lyd', 'overhead_lyd', 'total_cost_lyd', 'unpaid_lyd', 'sale_price_lyd', 'margin_lyd'];
  const totals = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + Number(r[k] || 0), 0).toFixed(3)]));
  const sold = rows.filter((r) => r.sale_price_lyd != null);
  totals.vehicles = rows.length;
  totals.sold = sold.length;
  totals.avg_margin_pct = sold.length
    ? ((sold.reduce((a, r) => a + Number(r.margin_lyd), 0) / sold.reduce((a, r) => a + Number(r.total_cost_lyd), 0)) * 100).toFixed(1)
    : null;
  return { rows, totals, generatedAt: new Date().toISOString(), filters };
}

/** تفصيل كل بنود التكلفة (ورقة ثانية في ملف Excel) */
export async function costLines(vehicleIds) {
  const { rows } = await query(
    `SELECT v.stock_no, v.vin, cc.name_ar AS category, cc.stage, c.description, c.amount, c.currency, c.fx_rate_to_lyd, c.amount_lyd,
            c.status, c.incurred_at, c.invoice_ref, c.is_paid, vd.name AS vendor
       FROM vehicle_costs c JOIN vehicles v ON v.id = c.vehicle_id JOIN cost_categories cc ON cc.code = c.category_code
       LEFT JOIN vendors vd ON vd.id = c.vendor_id
      WHERE c.voided_at IS NULL AND c.vehicle_id = ANY($1::uuid[]) ORDER BY v.stock_no, cc.sort_order, c.incurred_at`, [vehicleIds]);
  return rows;
}
