// محوّل IAAI (Insurance Auto Auctions).
// كما في Copart: لا واجهة عامة مفتوحة؛ التكامل عبر تغذية بيانات حساب المشتري/الوسيط
// أو مزوّد مرخّص. الحقول هنا على نمط IAAI (stockNumber, PrimaryDamage…) وتُحوَّل
// إلى نفس النموذج الموحد الذي ينتجه محوّل Copart — المحرك لا يعرف الفرق.
import { fetchJson } from '../http-client.js';
import { vinError } from '../../domain/vin.js';
import { NormalizeError, titleCase } from './copart.js';

const TITLE = { 'SALVAGE': 'SALVAGE', 'CLEAR': 'CLEAN', 'CLEAN': 'CLEAN', 'REBUILT': 'REBUILT', 'NON-REPAIRABLE': 'PARTS_ONLY', 'JUNK': 'CERTIFICATE_OF_DESTRUCTION' };
const ODO = { 'ACTUAL': 'ACTUAL', 'NOT ACTUAL': 'NOT_ACTUAL', 'EXEMPT': 'EXEMPT', 'EXCEEDS MECHANICAL LIMITS': 'EXCEEDS_LIMIT' };

export function normalizeIaai(raw) {
  if (!raw || typeof raw !== 'object') throw new NormalizeError('عنصر فارغ');
  const stock = String(raw.stockNumber ?? '').trim();
  if (!/^\d{6,10}$/.test(stock)) throw new NormalizeError(`رقم مخزون IAAI غير صالح: ${raw.stockNumber}`);
  const vin = String(raw.VIN ?? '').trim().toUpperCase();
  const ve = vinError(vin);
  if (ve) throw new NormalizeError(ve);
  const odo = raw.Odometer || {};
  const purchase = raw.Purchase || {};
  const fees = purchase.Fees || {};
  const pickup = String(purchase.PickupStatus || '').toUpperCase();
  return {
    externalRef: stock,
    vin,
    year: Number(raw.Year),
    make: titleCase(raw.Make),
    model: raw.Model,
    trim: raw.Series || null,
    bodyStyle: raw.BodyStyle || null,
    exteriorColor: raw.ExteriorColor || null,
    engine: raw.EngineSize || null,
    cylinders: raw.Cylinders ? Number(raw.Cylinders) : null,
    fuelType: raw.FuelType || null,
    transmission: raw.Transmission || null,
    driveType: raw.DriveLineType || null,
    odometer: odo.value != null ? Math.round(Number(odo.value)) : null,
    odometerUnit: odo.unit === 'KM' ? 'km' : 'mi',
    odometerBrand: ODO[String(odo.brand || '').toUpperCase()] || 'UNKNOWN',
    titleType: TITLE[String(raw.TitleBrand || '').toUpperCase()] || 'OTHER',
    titleState: raw.TitleState || null,
    primaryDamage: raw.PrimaryDamage || null,
    secondaryDamage: raw.SecondaryDamage || null,
    hasKeys: typeof raw.Keys === 'boolean' ? raw.Keys : null,
    runAndDrive: raw.StartCode ? raw.StartCode === 'Run & Drive' : null,
    yardName: raw.Branch?.name || null,
    yardState: raw.Branch?.state || null,
    yardZip: raw.Branch?.zip || null,
    saleDate: raw.AuctionDateTime || null,
    saleStatus: raw.Status || null,
    acvUsd: raw.ACV ?? null,
    repairEstimateUsd: raw.RepairCost ?? null,
    purchasePriceUsd: purchase.SalePrice ?? null,
    buyerFeeUsd: fees.Buyer ?? null,
    otherFeesUsd: fees.Other ?? null,
    paymentDueAt: purchase.PaymentDue || null,
    pickupDeadlineAt: purchase.PickupBy || null,
    logisticsStatus: pickup === 'DELIVERED' ? 'DELIVERED_TO_WAREHOUSE' : pickup === 'PICKED UP' ? 'PICKED_UP'
      : String(purchase.PaymentStatus).toUpperCase() === 'PAID' ? 'PAID' : purchase.Voided ? 'CANCELLED' : null,
    listingUrl: `https://www.iaai.com/VehicleDetail/${stock}`,
    images: (raw.Images || []).map((im) => ({ url: im.Url, kind: ['EXTERIOR', 'INTERIOR', 'ENGINE', 'DAMAGE'].includes(String(im.Type).toUpperCase()) ? String(im.Type).toUpperCase() : 'OTHER' })),
    updatedAt: raw.LastModified || null,
  };
}

export function createIaaiAdapter({ baseUrl, token, pageSize = 50, onRetry }) {
  return {
    code: 'IAAI',
    normalize: normalizeIaai,
    async *fetchPurchases({ since }) {
      let offset = 0;
      for (;;) {
        const url = new URL(`${baseUrl}/buyer/purchases`);
        url.searchParams.set('offset', offset);
        url.searchParams.set('limit', pageSize);
        if (since) url.searchParams.set('modifiedAfter', since);
        const data = await fetchJson(url, { token, onRetry });
        if (!Array.isArray(data.Vehicles)) throw new Error('صيغة استجابة IAAI غير متوقعة (Vehicles مفقود)');
        yield { items: data.Vehicles, cursor: data.AsOf };
        offset += data.Vehicles.length;
        if (!data.Vehicles.length || offset >= data.Total) break;
      }
    },
  };
}
