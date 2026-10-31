// مسارات الإدخال التشغيلي: العملاء، إدارة المزادات، البيع والدفعات، الشحنات، الجمارك، الموردون
import express from 'express';
import { asyncH, requireRole, HttpError, ROLES } from '../security/middleware.js';
import { validate, t, isUuid } from '../validate.js';
import { sha256 } from '../security/crypto.js';
import { createCustomer, createAuctionEvent, cancelAuctionEvent, cancelLot, listRegistrations, registerBidder, setDeposit, directSale, addPayment } from '../services/sales.js';
import { createShipment, updateShipment, addVehicleToShipment, removeVehicleFromShipment, openCustoms, createVendor } from '../services/logistics.js';
import { query, audit } from '../db.js';

export const ops = express.Router();
const actorOf = (req) => ({ id: req.user.id, ip: req.ip, ipHash: sha256(`${req.ip}`).slice(0, 16) });
const uuidParam = (...names) => (req, _res, next) => (names.every((n) => isUuid(req.params[n])) ? next() : next(new HttpError(404, 'NOT_FOUND', 'غير موجود')));
const SALES_TEAM = ['ADMIN', 'SALES'];

// ---------------------------------------------------------------- العملاء
ops.post('/customers', requireRole(SALES_TEAM), asyncH(async (req, res) => {
  const b = validate(req.body, {
    fullName: t.string({ required: true, min: 2, max: 120 }), customerType: t.enum(['INDIVIDUAL', 'DEALER', 'COMPANY']),
    phone: t.string({ max: 30 }), nationalId: t.string({ max: 30 }), email: t.string({ max: 200 }), city: t.string({ max: 60 }), notes: t.string({ max: 500 }),
  });
  res.status(201).json(await createCustomer(b, actorOf(req)));
}));

ops.patch('/customers/:id', requireRole(SALES_TEAM), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { kycStatus: t.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'], { required: true }) });
  const { rows: [c] } = await query('UPDATE customers SET kyc_status = $2, updated_at = now() WHERE id = $1 RETURNING id, code, kyc_status', [req.params.id, b.kycStatus]);
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'العميل غير موجود');
  await audit(null, { actorId: req.user.id, action: 'KYC_CHANGED', entity: 'customer', entityId: c.id, after: { kyc: c.kyc_status }, ip: req.ip });
  res.json(c);
}));

// ---------------------------------------------------------------- إدارة المزادات
ops.post('/auctions', requireRole(ROLES.AUCTION_MANAGERS), asyncH(async (req, res) => {
  const b = validate(req.body, {
    title: t.string({ required: true, min: 3, max: 120 }), startsAt: t.datetime({ required: true }), endsAt: t.datetime({ required: true }),
    depositRequiredLyd: t.decimal(), antiSnipeWindowSec: t.int({ min: 0, max: 600 }), extensionSec: t.int({ min: 0, max: 600 }), terms: t.string({ max: 2000 }),
  });
  res.status(201).json(await createAuctionEvent(b, actorOf(req)));
}));
ops.post('/auctions/:id/cancel', requireRole(ROLES.AUCTION_MANAGERS), uuidParam('id'), asyncH(async (req, res) => res.json(await cancelAuctionEvent(req.params.id, actorOf(req)))));
ops.post('/lots/:id/cancel', requireRole(ROLES.AUCTION_MANAGERS), uuidParam('id'), asyncH(async (req, res) => res.json(await cancelLot(req.params.id, actorOf(req)))));

ops.get('/auctions/:id/registrations', requireRole([...SALES_TEAM, 'ACCOUNTANT']), uuidParam('id'), asyncH(async (req, res) => res.json({ items: await listRegistrations(req.params.id) })));
ops.post('/auctions/:id/registrations', requireRole(SALES_TEAM), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { customerId: t.uuid({ required: true }) });
  res.status(201).json(await registerBidder(req.params.id, b.customerId, actorOf(req)));
}));
ops.patch('/registrations/:id', requireRole([...SALES_TEAM, 'ACCOUNTANT']), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { depositStatus: t.enum(['HELD', 'RELEASED', 'FORFEITED'], { required: true }), amount: t.decimal() });
  res.json(await setDeposit(req.params.id, b.depositStatus, b.amount, actorOf(req)));
}));

// ---------------------------------------------------------------- البيع المباشر والدفعات
ops.post('/vehicles/:id/sell', requireRole(SALES_TEAM), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { customerId: t.uuid({ required: true }), priceLyd: t.decimal({ required: true, positive: true }), dueDays: t.int({ min: 0, max: 60 }) });
  res.status(201).json(await directSale(req.params.id, b, actorOf(req)));
}));
ops.post('/sales/:id/payments', requireRole([...SALES_TEAM, 'ACCOUNTANT']), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, {
    amount: t.decimal({ required: true, positive: true }), currency: t.enum(['LYD', 'USD', 'EUR'], { required: true }),
    method: t.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER'], { required: true }), reference: t.string({ max: 80 }),
  });
  res.status(201).json(await addPayment(req.params.id, b, actorOf(req)));
}));

// ---------------------------------------------------------------- الموردون
ops.post('/vendors', requireRole(['ADMIN', 'OPERATIONS', 'ACCOUNTANT']), asyncH(async (req, res) => {
  const b = validate(req.body, {
    name: t.string({ required: true, min: 2, max: 120 }), country: t.string({ max: 2 }), phone: t.string({ max: 30 }),
    vendorType: t.enum(['AUCTION', 'TOWING', 'FREIGHT_FORWARDER', 'SHIPPING_LINE', 'INSURANCE', 'CUSTOMS_BROKER', 'INLAND_TRANSPORT', 'WORKSHOP', 'OTHER'], { required: true }),
  });
  res.status(201).json(await createVendor(b, actorOf(req)));
}));

// ---------------------------------------------------------------- الشحنات والجمارك
const shipFields = {
  bookingNo: t.string({ max: 40 }), billOfLading: t.string({ max: 40 }), containerNo: t.string({ max: 11, pattern: /^[A-Z]{4}\d{7}$/ }),
  vesselName: t.string({ max: 80 }), voyageNo: t.string({ max: 30 }), etd: t.date(), eta: t.date(), notes: t.string({ max: 500 }),
};
ops.post('/shipments', requireRole(ROLES.LOGISTICS_WRITERS), asyncH(async (req, res) => {
  const b = validate(req.body, {
    ...shipFields, polCode: t.string({ required: true, max: 10 }), podCode: t.string({ required: true, max: 10 }), containerType: t.enum(['C20', 'C40', 'C40HC', 'RORO']),
    capacity: t.int({ min: 1, max: 12 }), carrierId: t.uuid(), forwarderId: t.uuid(),
  });
  res.status(201).json(await createShipment(b, actorOf(req)));
}));
ops.patch('/shipments/:id', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { ...shipFields, atd: t.date(), ata: t.date(), status: t.enum(['BOOKED', 'LOADING', 'DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT', 'ARRIVED', 'DISCHARGED', 'CLOSED', 'CANCELLED']) });
  res.json(await updateShipment(req.params.id, b, actorOf(req)));
}));
ops.post('/shipments/:id/vehicles', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { vehicleId: t.uuid({ required: true }) });
  res.status(201).json(await addVehicleToShipment(req.params.id, b.vehicleId, actorOf(req)));
}));
ops.delete('/shipments/:id/vehicles/:vehicleId', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id', 'vehicleId'), asyncH(async (req, res) => res.json(await removeVehicleFromShipment(req.params.id, req.params.vehicleId, actorOf(req)))));
ops.post('/vehicles/:id/customs', requireRole(ROLES.LOGISTICS_WRITERS), uuidParam('id'), asyncH(async (req, res) => {
  const b = validate(req.body, { portCode: t.string({ max: 10 }), brokerId: t.uuid(), declarationNo: t.string({ max: 60 }) });
  res.status(201).json(await openCustoms(req.params.id, b, actorOf(req)));
}));
