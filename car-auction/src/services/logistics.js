// الشحنات والجمارك والموردون — إدخال يدوي (بدون ربط آلي للتتبع)
import { query, tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';
import { changeStatus } from './vehicles.js';
import { forwardPath, pathIndex } from '../domain/status.js';

// ------------------------------------------------------------------ الموردون
export async function createVendor(b, actor) {
  const { rows: [v] } = await query(
    `INSERT INTO vendors (name, vendor_type, country, contact) VALUES ($1,$2,$3,$4)
     ON CONFLICT (name, vendor_type) DO NOTHING RETURNING id, name, vendor_type`,
    [b.name, b.vendorType, b.country || null, JSON.stringify({ phone: b.phone || null })]);
  if (!v) throw new HttpError(409, 'DUPLICATE', 'هذا المورد مسجل بنفس الاسم والنوع');
  await audit(null, { actorId: actor.id, action: 'VENDOR_CREATED', entity: 'vendor', entityId: v.id, after: v, ip: actor.ip });
  return v;
}

// ------------------------------------------------------------------ الشحنات
const SHIP_ORDER = ['BOOKED', 'LOADING', 'DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT', 'ARRIVED', 'DISCHARGED', 'CLOSED'];

export async function createShipment(b, actor) {
  const ports = (await query('SELECT id, code FROM ports WHERE code = ANY($1)', [[b.polCode, b.podCode]])).rows;
  const pol = ports.find((p) => p.code === b.polCode), pod = ports.find((p) => p.code === b.podCode);
  if (!pol || !pod) throw new HttpError(422, 'BAD_PORT', 'ميناء التحميل أو التفريغ غير معروف');
  if (pol.id === pod.id) throw new HttpError(422, 'BAD_PORT', 'ميناء التحميل والتفريغ متطابقان');
  try {
    const { rows: [s] } = await query(
      `INSERT INTO shipments (shipment_no, booking_no, bill_of_lading, container_no, container_type, capacity, carrier_id, forwarder_id, vessel_name, voyage_no,
                              pol_port_id, pod_port_id, etd, eta, notes)
       VALUES ('SH-' || to_char(now(),'YYYY') || '-' || lpad(nextval('shipment_seq')::text, 4, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, shipment_no`,
      [b.bookingNo || null, b.billOfLading || null, b.containerNo || null, b.containerType || 'C40HC', b.capacity || 4, b.carrierId || null, b.forwarderId || null,
        b.vesselName || null, b.voyageNo || null, pol.id, pod.id, b.etd || null, b.eta || null, b.notes || null]);
    await audit(null, { actorId: actor.id, action: 'SHIPMENT_CREATED', entity: 'shipment', entityId: s.id, after: { shipment_no: s.shipment_no }, ip: actor.ip });
    return s;
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'DUPLICATE_BL', 'بوليصة الشحن مسجلة على شحنة أخرى');
    if (e.code === '23514') throw new HttpError(422, 'BAD_CONTAINER', 'رقم الحاوية يجب أن يكون 4 أحرف كبيرة و7 أرقام (مثال: MSCU1234567)');
    throw e;
  }
}

export async function addVehicleToShipment(shipmentId, vehicleId, actor) {
  return tx(async (c) => {
    const { rows: [s] } = await c.query('SELECT id, shipment_no, status, capacity FROM shipments WHERE id = $1 FOR UPDATE', [shipmentId]);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'الشحنة غير موجودة');
    if (!['BOOKED', 'LOADING'].includes(s.status)) throw new HttpError(422, 'SHIPPED', 'الشحنة غادرت، لا تُضاف إليها سيارات');
    const { rows: [v] } = await c.query('SELECT id, status FROM vehicles WHERE id = $1', [vehicleId]);
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
    if ((await c.query('SELECT 1 FROM shipment_vehicles WHERE vehicle_id = $1', [vehicleId])).rowCount) throw new HttpError(409, 'ALREADY', 'السيارة محمّلة في شحنة (هذه أو غيرها)');
    if (v.status !== 'AT_US_WAREHOUSE') throw new HttpError(422, 'NOT_READY', 'لا تُحمَّل إلا سيارة في "مستودع التصدير"');
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM shipment_vehicles WHERE shipment_id = $1', [shipmentId]);
    if (n >= s.capacity) throw new HttpError(422, 'FULL', `الحاوية ممتلئة (السعة ${s.capacity})`);
    await c.query('INSERT INTO shipment_vehicles (shipment_id, vehicle_id, position, loaded_at) VALUES ($1,$2,$3, now())', [shipmentId, vehicleId, n + 1]);
    await changeStatus(c, vehicleId, 'LOADED', { actorId: actor.id, reason: `تحميل في الشحنة ${s.shipment_no}`, ip: actor.ip });
    if (s.status === 'BOOKED') await c.query(`UPDATE shipments SET status = 'LOADING', updated_at = now() WHERE id = $1`, [shipmentId]);
    return { shipmentId, vehicleId, position: n + 1 };
  });
}

export async function removeVehicleFromShipment(shipmentId, vehicleId, actor) {
  return tx(async (c) => {
    const { rows: [s] } = await c.query('SELECT id, status FROM shipments WHERE id = $1 FOR UPDATE', [shipmentId]);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'الشحنة غير موجودة');
    if (!['BOOKED', 'LOADING'].includes(s.status)) throw new HttpError(422, 'SHIPPED', 'الشحنة غادرت');
    const r = await c.query('DELETE FROM shipment_vehicles WHERE shipment_id = $1 AND vehicle_id = $2', [shipmentId, vehicleId]);
    if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'السيارة ليست في هذه الشحنة');
    await changeStatus(c, vehicleId, 'AT_US_WAREHOUSE', { actorId: actor.id, reason: 'إنزال من الحاوية', ip: actor.ip });
    return { ok: true };
  });
}

const STATUS_EVENT = {
  LOADING: ['LOAD', 'بدء التحميل'], DEPARTED: ['DEPA', 'مغادرة السفينة'], IN_TRANSIT: ['SAIL', 'في عرض البحر'], TRANSSHIPMENT: ['TRSH', 'مسافنة'],
  ARRIVED: ['ARRI', 'وصول السفينة'], DISCHARGED: ['DISC', 'تفريغ الحاوية'], CLOSED: ['CLOS', 'إغلاق الشحنة'],
};

/** تحديث شحنة. تقدّم الحالة يسجّل حدثًا وينقل سياراتها: مغادرة ← في البحر، وصول/تفريغ ← في الميناء */
export async function updateShipment(id, b, actor) {
  return tx(async (c) => {
    const { rows: [s] } = await c.query('SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [id]);
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'الشحنة غير موجودة');
    const today = new Date().toISOString().slice(0, 10);
    const sets = [], vals = [id];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    for (const [k, col] of Object.entries({ bookingNo: 'booking_no', billOfLading: 'bill_of_lading', containerNo: 'container_no', vesselName: 'vessel_name', voyageNo: 'voyage_no', etd: 'etd', eta: 'eta', atd: 'atd', ata: 'ata', notes: 'notes' }))
      if (b[k] !== undefined) set(col, b[k]);
    if (b.status && b.status !== s.status) {
      if (s.status === 'CANCELLED' || b.status === 'CANCELLED' && ['ARRIVED', 'DISCHARGED', 'CLOSED'].includes(s.status)) throw new HttpError(422, 'BAD_FLOW', 'لا يمكن هذا التغيير على الشحنة');
      if (b.status !== 'CANCELLED' && SHIP_ORDER.indexOf(b.status) < SHIP_ORDER.indexOf(s.status)) throw new HttpError(422, 'BACKWARDS', 'لا تُرجَع الشحنة إلى مرحلة سابقة');
      if (['DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT', 'ARRIVED', 'DISCHARGED'].includes(b.status)) {
        const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM shipment_vehicles WHERE shipment_id = $1', [id]);
        if (!n) throw new HttpError(422, 'EMPTY', 'الشحنة فارغة؛ حمّل سيارات قبل تسجيل المغادرة');
      }
      set('status', b.status);
      if (['DEPARTED', 'IN_TRANSIT'].includes(b.status) && !s.atd && b.atd === undefined) set('atd', today);
      if (['ARRIVED', 'DISCHARGED'].includes(b.status) && !s.ata && b.ata === undefined) set('ata', today);
      const ev = STATUS_EVENT[b.status];
      if (ev) await c.query(`INSERT INTO shipment_events (shipment_id, event_code, description, source, occurred_at) VALUES ($1,$2,$3,'MANUAL', now()) ON CONFLICT DO NOTHING`, [id, ev[0], ev[1]]);
      const target = ['ARRIVED', 'DISCHARGED'].includes(b.status) ? 'AT_PORT_LIBYA' : ['DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT'].includes(b.status) ? 'IN_TRANSIT_SEA' : null;
      if (target) {
        const { rows: cars } = await c.query('SELECT v.id, v.status FROM shipment_vehicles sv JOIN vehicles v ON v.id = sv.vehicle_id WHERE sv.shipment_id = $1', [id]);
        for (const car of cars) {
          if (pathIndex(car.status) < 0 || pathIndex(car.status) >= pathIndex(target)) continue;
          for (const step of forwardPath(car.status, target) || []) await changeStatus(c, car.id, step, { actorId: actor.id, reason: `الشحنة ${s.shipment_no}: ${ev?.[1] || b.status}`, ip: actor.ip });
        }
      }
    }
    if (!sets.length) return { id, unchanged: true };
    sets.push('updated_at = now()');
    try {
      await c.query(`UPDATE shipments SET ${sets.join(', ')} WHERE id = $1`, vals);
    } catch (e) {
      if (e.code === '23514') throw new HttpError(422, 'BAD_CONTAINER', 'رقم الحاوية يجب أن يكون 4 أحرف كبيرة و7 أرقام');
      if (e.code === '23505') throw new HttpError(409, 'DUPLICATE_BL', 'بوليصة الشحن مسجلة على شحنة أخرى');
      throw e;
    }
    await audit(c, { actorId: actor.id, action: 'SHIPMENT_UPDATED', entity: 'shipment', entityId: id, before: { status: s.status }, after: b, ip: actor.ip });
    return { id };
  });
}

// ------------------------------------------------------------------ الجمارك
export async function openCustoms(vehicleId, b, actor) {
  return tx(async (c) => {
    const { rows: [v] } = await c.query(
      `SELECT v.id, v.status, v.destination_port_id, (SELECT sh.pod_port_id FROM shipment_vehicles sv JOIN shipments sh ON sh.id = sv.shipment_id WHERE sv.vehicle_id = v.id) AS pod
         FROM vehicles v WHERE v.id = $1 FOR UPDATE`, [vehicleId]);
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
    if (!['AT_PORT_LIBYA', 'IN_CUSTOMS', 'SOLD'].includes(v.status)) throw new HttpError(422, 'NOT_AT_PORT', 'يُفتح البيان الجمركي لسيارة وصلت الميناء الليبي');
    if ((await c.query('SELECT 1 FROM customs_declarations WHERE vehicle_id = $1', [vehicleId])).rowCount) throw new HttpError(409, 'EXISTS', 'للسيارة بيان جمركي مفتوح مسبقًا');
    let portId = v.pod || v.destination_port_id;
    if (b.portCode) portId = (await c.query('SELECT id FROM ports WHERE code = $1 AND country = $2', [b.portCode, 'LY'])).rows[0]?.id || portId;
    if (!portId) throw new HttpError(422, 'NO_PORT', 'حدد ميناء الوصول');
    const { rows: [d] } = await c.query(
      `INSERT INTO customs_declarations (vehicle_id, declaration_no, port_id, broker_id, status) VALUES ($1,$2,$3,$4,'DOCS_PENDING') RETURNING id`,
      [vehicleId, b.declarationNo || null, portId, b.brokerId || null]);
    await audit(c, { actorId: actor.id, action: 'CUSTOMS_OPENED', entity: 'customs_declaration', entityId: d.id, after: { vehicleId }, ip: actor.ip });
    return d;
  });
}
