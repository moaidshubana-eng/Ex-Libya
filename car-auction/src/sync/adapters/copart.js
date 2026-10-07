// محوّل Copart.
// ملاحظة واقعية: Copart لا توفر واجهة برمجية عامة مفتوحة. الوصول للبيانات يكون عبر
// (1) تغذية بيانات مرخّصة يتيحها حساب العضو/الوسيط (Member/Broker data feed)،
// أو (2) مزوّد بيانات طرف ثالث مرخّص، أو (3) ملفات التصدير من بوابة العضو (CSV).
// هذا المحوّل يتعامل مع تغذية JSON مقسّمة صفحات بحقول على نمط Copart، وعنوانها
// ومفتاحها يُضبطان من البيئة (COPART_FEED_URL, COPART_API_TOKEN) — راجع docs/03-integration.md.
import { fetchJson } from '../http-client.js';
import { vinError } from '../../domain/vin.js';

export class NormalizeError extends Error {}

const TITLE = { SALVAGE: 'SALVAGE', 'SALVAGE CERTIFICATE': 'SALVAGE', CLEAN: 'CLEAN', 'CLEAR': 'CLEAN', REBUILT: 'REBUILT', 'PARTS ONLY': 'PARTS_ONLY', 'CERTIFICATE OF DESTRUCTION': 'CERTIFICATE_OF_DESTRUCTION' };
const ODO_BRAND = { A: 'ACTUAL', N: 'NOT_ACTUAL', E: 'EXEMPT', X: 'EXCEEDS_LIMIT' };

export function normalizeCopart(raw) {
  if (!raw || typeof raw !== 'object') throw new NormalizeError('عنصر فارغ');
  const lot = String(raw.lotNumber ?? '').trim();
  if (!/^\d{6,10}$/.test(lot)) throw new NormalizeError(`رقم لوت غير صالح: ${raw.lotNumber}`);
  const vin = String(raw.vin ?? '').trim().toUpperCase();
  const ve = vinError(vin);
  if (ve) throw new NormalizeError(ve);
  const p = raw.purchase || {};
  return {
    externalRef: lot,
    vin,
    year: Number(raw.year),
    make: titleCase(raw.make),
    model: raw.modelGroup || raw.modelDetail,
    trim: raw.trim || null,
    bodyStyle: raw.bodyStyle || null,
    exteriorColor: raw.color || null,
    engine: raw.engineType || null,
    cylinders: raw.cylinders ? Number(raw.cylinders) : null,
    fuelType: raw.fuel || null,
    transmission: raw.transmission || null,
    driveType: raw.drive || null,
    odometer: raw.odometer != null ? Math.round(Number(raw.odometer)) : null,
    odometerUnit: 'mi',
    odometerBrand: ODO_BRAND[raw.odometerBrand] || 'UNKNOWN',
    titleType: TITLE[String(raw.titleGroup || '').toUpperCase()] || 'OTHER',
    titleState: raw.titleState || null,
    primaryDamage: raw.damageDescription || null,
    secondaryDamage: raw.secondaryDamage || null,
    hasKeys: raw.hasKeys == null ? null : String(raw.hasKeys).toUpperCase() === 'YES',
    runAndDrive: Array.isArray(raw.highlights) ? raw.highlights.includes('RUN_AND_DRIVE') : null,
    yardName: raw.yardName || null,
    yardState: raw.locationState || null,
    yardZip: raw.locationZip || null,
    saleDate: raw.saleDate ? new Date(raw.saleDate).toISOString() : null,
    saleStatus: raw.saleStatus || null,
    acvUsd: raw.acv ?? null,
    repairEstimateUsd: raw.repairCost ?? null,
    purchasePriceUsd: p.price ?? null,
    buyerFeeUsd: p.buyerFee ?? null,
    otherFeesUsd: p.otherFees ?? null,
    paymentDueAt: p.paymentDue || null,
    pickupDeadlineAt: p.pickupDeadline || null,
    logisticsStatus: p.pickedUpAt ? (p.deliveredAt ? 'DELIVERED_TO_WAREHOUSE' : 'PICKED_UP') : p.paidAt ? 'PAID' : p.cancelled ? 'CANCELLED' : null,
    listingUrl: `https://www.copart.com/lot/${lot}`,
    images: (raw.imageUrls || []).map((url, i) => ({ url, kind: i === 0 ? 'EXTERIOR' : guessKind(url) })),
    updatedAt: raw.lastUpdated ? new Date(raw.lastUpdated).toISOString() : null,
  };
}

function guessKind(url) {
  const u = String(url).toLowerCase();
  if (u.includes('interior')) return 'INTERIOR';
  if (u.includes('engine')) return 'ENGINE';
  if (u.includes('damage')) return 'DAMAGE';
  return 'EXTERIOR';
}

export function titleCase(s) {
  if (!s) return s;
  const str = String(s).trim();
  if (str.length <= 3) return str.toUpperCase(); // BMW, GMC, KIA
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function createCopartAdapter({ baseUrl, token, pageSize = 50, onRetry }) {
  return {
    code: 'COPART',
    normalize: normalizeCopart,
    /** يعيد صفحات المشتريات المحدّثة منذ المؤشر الأخير */
    async *fetchPurchases({ since }) {
      let page = 1;
      for (;;) {
        const url = new URL(`${baseUrl}/purchases`);
        url.searchParams.set('page', page);
        url.searchParams.set('size', pageSize);
        if (since) url.searchParams.set('updatedSince', since);
        const data = await fetchJson(url, { token, onRetry });
        if (!Array.isArray(data.lots)) throw new Error('صيغة استجابة Copart غير متوقعة (lots مفقود)');
        yield { items: data.lots, cursor: data.serverTime };
        if (!data.hasMore) break;
        page++;
      }
    },
  };
}
