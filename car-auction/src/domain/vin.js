// رقم الهيكل (VIN) — ISO 3779: 17 خانة بلا I و O و Q، والخانة التاسعة رقم تحقق
// إلزامي لسيارات أمريكا الشمالية (كل ما يُستورد من Copart/IAAI).

const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function checkDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i];
    const val = /\d/.test(ch) ? Number(ch) : TRANSLIT[ch];
    sum += val * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

/** يعيد null إن كان صالحًا، أو سبب الرفض */
export function vinError(vin) {
  if (typeof vin !== 'string') return 'VIN مفقود';
  const v = vin.trim().toUpperCase();
  if (!VIN_RE.test(v)) return `VIN بصيغة غير صالحة: ${vin}`;
  if (checkDigit(v) !== v[8]) return `خانة التحقق في VIN غير مطابقة: ${vin}`;
  return null;
}

/** توليد VIN صالح (للبيانات التجريبية فقط) من بادئة WMI+VDS ورقم تسلسلي */
export function makeVin(prefix8, yearCode, plant, serial) {
  const body = `${prefix8}0${yearCode}${plant}${String(serial).padStart(6, '0')}`;
  const cd = checkDigit(body);
  return body.slice(0, 8) + cd + body.slice(9);
}

// رمز سنة الطراز (الخانة العاشرة)
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
export function yearCode(year) {
  return YEAR_CODES[(year - 2010 + 30) % 30];
}
