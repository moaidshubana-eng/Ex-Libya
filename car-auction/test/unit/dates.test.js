import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { today } from '../../src/domain/dates.js';

describe('تاريخ العمل بتوقيت الشركة (ليبيا، UTC+2)', () => {
  test('بعد منتصف الليل في ليبيا يكون اليوم الجديد حتى لو كان UTC ما زال في أمس', () => {
    assert.equal(today(new Date('2026-11-16T22:30:00Z')), '2026-11-17');
    assert.equal(today(new Date('2026-11-16T21:59:00Z')), '2026-11-16');
    assert.equal(today(new Date('2026-12-31T23:00:00Z')), '2027-01-01');
  });

  test('الصيغة YYYY-MM-DD', () => {
    assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
