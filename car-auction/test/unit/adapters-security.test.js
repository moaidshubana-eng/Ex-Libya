import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalizeCopart, NormalizeError } from '../../src/sync/adapters/copart.js';
import { normalizeIaai } from '../../src/sync/adapters/iaai.js';
import { normalizeTracking } from '../../src/sync/adapters/tracking.js';
import { parseCsv, normalizeCsvRow } from '../../src/sync/adapters/csv.js';
import { fetchJson, SourceError } from '../../src/sync/http-client.js';
import { hashPassword, verifyPassword, encrypt, decrypt, lookupHash, mask, passwordPolicyError } from '../../src/security/crypto.js';
import { validate, t } from '../../src/validate.js';

const VIN = '1M8GDM9AXKP042788';

describe('محوّلات المصادر — توحيد البيانات', () => {
  test('Copart → النموذج الموحد', () => {
    const n = normalizeCopart({
      lotNumber: '61200274', vin: VIN, year: 2019, make: 'TOYOTA', modelGroup: 'CAMRY', odometer: 45210.6, odometerBrand: 'A',
      titleGroup: 'SALVAGE', hasKeys: 'YES', highlights: ['RUN_AND_DRIVE'], purchase: { price: 8450, buyerFee: 926, paidAt: '2026-10-01', pickedUpAt: '2026-10-02' },
      imageUrls: ['a.jpg', 'b_interior.jpg'],
    });
    assert.equal(n.make, 'Toyota');
    assert.equal(n.odometer, 45211);
    assert.equal(n.odometerBrand, 'ACTUAL');
    assert.equal(n.titleType, 'SALVAGE');
    assert.equal(n.hasKeys, true);
    assert.equal(n.runAndDrive, true);
    assert.equal(n.logisticsStatus, 'PICKED_UP');
    assert.deepEqual(n.images.map((i) => i.kind), ['EXTERIOR', 'INTERIOR']);
  });
  test('IAAI → نفس النموذج الموحد', () => {
    const n = normalizeIaai({
      stockNumber: '38400211', VIN, Year: 2020, Make: 'kia', Model: 'K5', Odometer: { value: 30000, unit: 'MI', brand: 'Actual' },
      TitleBrand: 'CLEAR', Keys: false, StartCode: 'Stationary', Purchase: { SalePrice: 7000, PaymentStatus: 'Paid', PickupStatus: 'Pending' },
    });
    assert.equal(n.make, 'KIA');
    assert.equal(n.titleType, 'CLEAN');
    assert.equal(n.runAndDrive, false);
    assert.equal(n.logisticsStatus, 'PAID');
  });
  test('بيانات تالفة تُرفض بخطأ تطبيع (تذهب لطابور الأخطاء لا لقاعدة البيانات)', () => {
    assert.throws(() => normalizeCopart({ lotNumber: '61200274', vin: 'BADVIN' }), NormalizeError);
    assert.throws(() => normalizeCopart({ lotNumber: 'x', vin: VIN }), NormalizeError);
    assert.throws(() => normalizeIaai(null), NormalizeError);
  });
  test('تتبع DCSA: أبعد حدث يحدد الحالة', () => {
    const t = normalizeTracking({ equipmentReference: 'MSCU1234567', events: [
      { eventCode: 'LOAD', eventDateTime: '2026-09-01T10:00:00Z' }, { eventCode: 'DEPA', eventDateTime: '2026-09-02T10:00:00Z' },
      { eventCode: 'ARRI', eventDateTime: '2026-09-28T10:00:00Z' }] });
    assert.equal(t.status, 'ARRIVED');
    assert.equal(t.ata, '2026-09-28');
    assert.equal(t.atd, '2026-09-02');
  });
  test('CSV: حقول بين علامات تنصيص وفواصل داخلها وBOM', () => {
    const rows = parseCsv('﻿lot_number,vin,year,make,model,damage\r\n12345678,' + VIN + ',2019,toyota,"Camry, SE","FRONT ""END"""\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, 'Camry, SE');
    assert.equal(rows[0].damage, 'FRONT "END"');
    assert.equal(normalizeCsvRow(rows[0]).make, 'Toyota');
  });
});

describe('عميل HTTP — إعادة المحاولة والتراجع', () => {
  const serve = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, () => resolve(s));
  });
  test('يعيد المحاولة على 503 ثم ينجح', async () => {
    let n = 0;
    const s = await serve((req, res) => { n++; if (n < 3) { res.statusCode = 503; return res.end(); } res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    const r = await fetchJson(`http://127.0.0.1:${s.address().port}/`, { baseDelayMs: 5 });
    assert.deepEqual(r, { ok: true });
    assert.equal(n, 3);
    s.close();
  });
  test('لا يعيد المحاولة على 401 (خطأ دائم)', async () => {
    let n = 0;
    const s = await serve((req, res) => { n++; res.statusCode = 401; res.end(); });
    await assert.rejects(fetchJson(`http://127.0.0.1:${s.address().port}/`, { baseDelayMs: 5 }), (e) => e instanceof SourceError && e.status === 401);
    assert.equal(n, 1);
    s.close();
  });
  test('يحترم Retry-After عند 429 ويتوقف بعد استنفاد المحاولات', async () => {
    let n = 0;
    const s = await serve((req, res) => { n++; res.statusCode = 429; res.setHeader('retry-after', '0'); res.end(); });
    await assert.rejects(fetchJson(`http://127.0.0.1:${s.address().port}/`, { retries: 2, baseDelayMs: 5 }));
    assert.equal(n, 3);
    s.close();
  });
  test('مهلة الطلب (timeout) تُعامل كخطأ قابل لإعادة المحاولة', async () => {
    const s = await serve(() => { /* لا رد أبدًا */ });
    await assert.rejects(fetchJson(`http://127.0.0.1:${s.address().port}/`, { retries: 1, timeoutMs: 100, baseDelayMs: 5 }), (e) => e.retryable === true);
    s.closeAllConnections();
    s.close();
  });
});

describe('الأمان — التشفير والتجزئة والتحقق', () => {
  test('كلمة المرور: scrypt مع ملح عشوائي، والتحقق ينجح/يفشل صحيحًا', async () => {
    const h1 = await hashPassword('Correct-horse-1');
    const h2 = await hashPassword('Correct-horse-1');
    assert.notEqual(h1, h2);
    assert.ok(await verifyPassword('Correct-horse-1', h1));
    assert.ok(!(await verifyPassword('wrong-password-1', h1)));
  });
  test('سياسة كلمة المرور', () => {
    assert.ok(passwordPolicyError('short1'));
    assert.ok(passwordPolicyError('onlyletterslong'));
    assert.equal(passwordPolicyError('Letters1234'), null);
  });
  test('AES-256-GCM: تشفير وفك، وكشف أي عبث بالنص المشفر', () => {
    const c = encrypt('0912345678');
    assert.notEqual(c, encrypt('0912345678')); // IV عشوائي
    assert.equal(decrypt(c), '0912345678');
    const parts = c.split(':');
    const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 1; parts[3] = ct.toString('base64');
    assert.throws(() => decrypt(parts.join(':')));
  });
  test('بصمة البحث ثابتة وتتجاهل التنسيق', () => {
    assert.equal(lookupHash('091-234 5678'), lookupHash('0912345678'));
  });
  test('الإخفاء الجزئي', () => assert.equal(mask('0912345678'), '091****678'));
  test('التحقق من المدخلات يرفض الحقول غير المعروفة والقيم الخاطئة', () => {
    const schema = { amount: t.decimal({ required: true, positive: true }), currency: t.enum(['USD', 'LYD']) };
    assert.deepEqual(validate({ amount: '10.5', currency: 'USD' }, schema), { amount: '10.5', currency: 'USD' });
    assert.throws(() => validate({ amount: '10.5', role: 'ADMIN' }, schema), /حقل غير معروف/);
    assert.throws(() => validate({ amount: '-1' }, schema));
    assert.throws(() => validate({ amount: '1e9' }, schema));
    assert.throws(() => validate({ amount: '1', currency: 'GBP' }, schema));
    assert.throws(() => validate([], schema));
  });
});
