// محوّل تتبع الحاويات. الخطوط الملاحية الكبرى (Maersk, MSC, CMA CGM, Hapag-Lloyd)
// توفر واجهات تتبع بمعيار DCSA Track & Trace، وتوجد مجمّعات تغطي عدة خطوط بواجهة واحدة.
// المحوّل يتوقع استجابة مبسطة على نمط DCSA: قائمة أحداث (equipmentEventTypeCode/transportEventTypeCode).
import { fetchJson } from '../http-client.js';

// تحويل رموز DCSA إلى حالة الشحنة الداخلية
const EVENT_TO_STATUS = {
  GTIN: 'LOADING', // Gate in at origin terminal
  LOAD: 'LOADING',
  DEPA: 'DEPARTED',
  TRSH: 'TRANSSHIPMENT',
  ARRI: 'ARRIVED',
  DISC: 'DISCHARGED',
  GTOT: 'DISCHARGED', // Gate out at destination
};
const ORDER = ['BOOKED', 'LOADING', 'DEPARTED', 'IN_TRANSIT', 'TRANSSHIPMENT', 'ARRIVED', 'DISCHARGED', 'CLOSED'];

export function normalizeTracking(raw) {
  const events = (raw.events || []).map((e) => ({
    code: e.eventCode,
    description: e.description || e.eventCode,
    location: e.location || null,
    occurredAt: new Date(e.eventDateTime).toISOString(),
    externalId: e.eventID || null,
  })).filter((e) => e.code && !Number.isNaN(Date.parse(e.occurredAt)));
  let status = null;
  for (const e of events) {
    const s = EVENT_TO_STATUS[e.code];
    if (s && (!status || ORDER.indexOf(s) > ORDER.indexOf(status))) status = s;
  }
  if (status === 'DEPARTED' || status === 'TRANSSHIPMENT') status = 'IN_TRANSIT';
  return {
    containerNo: raw.equipmentReference,
    vessel: raw.vesselName || null,
    voyage: raw.voyageNumber || null,
    eta: raw.estimatedArrival ? raw.estimatedArrival.slice(0, 10) : null,
    ata: events.find((e) => e.code === 'ARRI')?.occurredAt.slice(0, 10) || null,
    atd: events.find((e) => e.code === 'DEPA')?.occurredAt.slice(0, 10) || null,
    status,
    events,
  };
}

export function createTrackingAdapter({ baseUrl, token, onRetry }) {
  return {
    code: 'TRACKING',
    normalize: normalizeTracking,
    async fetchContainer(containerNo) {
      const data = await fetchJson(`${baseUrl}/containers/${encodeURIComponent(containerNo)}`, { token, onRetry });
      return normalizeTracking(data);
    },
  };
}
