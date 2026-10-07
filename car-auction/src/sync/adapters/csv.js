// استيراد ملف CSV (تصدير بوابة العضو في Copart/IAAI أو ملف الوسيط) — مسار بديل
// عند تعذّر التغذية الآلية، يمر بنفس المحرك ونفس قواعد التحقق والدمج.
import { vinError } from '../../domain/vin.js';
import { NormalizeError, titleCase } from './copart.js';

/** محلل CSV متوافق مع RFC 4180 (حقول بين علامات تنصيص، فواصل وأسطر داخلها) */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// الأعمدة المقبولة: source,lot_number,vin,year,make,model,trim,color,odometer,title,damage,yard,state,purchase_price_usd,buyer_fee_usd,sale_date
export function normalizeCsvRow(r) {
  const lot = r.lot_number || r.lot || r.stock_number;
  if (!/^\d{6,10}$/.test(lot || '')) throw new NormalizeError(`رقم لوت غير صالح: ${lot}`);
  const vin = String(r.vin || '').toUpperCase();
  const ve = vinError(vin);
  if (ve) throw new NormalizeError(ve);
  const year = Number(r.year);
  if (!(year >= 1950 && year <= 2100)) throw new NormalizeError(`سنة غير صالحة: ${r.year}`);
  if (!r.make || !r.model) throw new NormalizeError('الماركة والطراز مطلوبان');
  const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[$,]/g, '')));
  return {
    externalRef: lot, vin, year, make: titleCase(r.make), model: r.model, trim: r.trim || null,
    exteriorColor: r.color || null, odometer: num(r.odometer), odometerUnit: 'mi', odometerBrand: 'UNKNOWN',
    titleType: (r.title || '').toUpperCase().includes('SALVAGE') ? 'SALVAGE' : (r.title || '').toUpperCase().includes('CLEAN') ? 'CLEAN' : 'OTHER',
    primaryDamage: r.damage || null, yardName: r.yard || null, yardState: r.state || null,
    saleDate: r.sale_date ? new Date(r.sale_date).toISOString() : null,
    purchasePriceUsd: num(r.purchase_price_usd), buyerFeeUsd: num(r.buyer_fee_usd), otherFeesUsd: null,
    logisticsStatus: null, images: [], listingUrl: null,
  };
}
