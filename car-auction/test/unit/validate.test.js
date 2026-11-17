import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validate, t } from '../../src/validate.js';

const fail = (body, schema) => { try { validate(body, schema); return null; } catch (e) { return e.message; } };

describe('رسائل التحقق مفهومة للمستخدم', () => {
  test('اسم الحقل بالعربية لا بالإنجليزية', () => {
    assert.equal(fail({}, { email: t.string({ required: true }), password: t.string({ required: true }) }), 'البريد الإلكتروني: مطلوب، كلمة المرور: مطلوب');
    assert.equal(fail({ amount: '0' }, { amount: t.decimal({ positive: true }) }), 'المبلغ: يجب أن يكون أكبر من صفر');
    assert.match(fail({ somethingNew: 1 }, {}), /^somethingNew: حقل غير معروف$/); // حقل بلا ترجمة يبقى باسمه
  });

  test('المبلغ: رسالة تطابق سبب الرفض', () => {
    const s = { amount: t.decimal({ positive: true }) };
    assert.match(fail({ amount: '999999999999999' }, s), /المبلغ: الرقم كبير جدًا/);
    assert.match(fail({ amount: '10.1234' }, s), /المبلغ: 3 منازل عشرية كحد أقصى/);
    assert.match(fail({ amount: '1,500' }, s), /المبلغ: اكتب رقمًا بالأرقام الإنجليزية/);
    assert.match(fail({ amount: '١٢٣' }, s), /المبلغ: اكتب رقمًا بالأرقام الإنجليزية/);
    assert.match(fail({ amount: '-5' }, s), /المبلغ:/);
    assert.deepEqual(validate({ amount: '1500.5' }, s), { amount: '1500.5' });
    assert.deepEqual(validate({ amount: '99999999999.999' }, s), { amount: '99999999999.999' });
  });

  test('سعر الصرف يقبل حتى 6 منازل (5.5200) والمبالغ تبقى على 3', () => {
    const fx = { rateToLyd: t.decimal({ positive: true, scale: 6 }) };
    assert.deepEqual(validate({ rateToLyd: '5.5200' }, fx), { rateToLyd: '5.5200' });
    assert.deepEqual(validate({ rateToLyd: '7.123456' }, fx), { rateToLyd: '7.123456' });
    assert.match(fail({ rateToLyd: '7.1234567' }, fx), /سعر الصرف: 6 منازل عشرية كحد أقصى/);
  });
});
