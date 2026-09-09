import { createHmac } from 'crypto';
import { verifyMetaSignature } from './verify-signature';

const appSecret = 'test-app-secret';

function sign(body: Buffer, secret: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyMetaSignature', () => {
  it('يقبل توقيعًا صحيحًا', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(verifyMetaSignature(body, sign(body, appSecret), appSecret)).toBe(true);
  });

  it('يرفض توقيعًا موقّعًا بسرّ مختلف', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(verifyMetaSignature(body, sign(body, 'wrong-secret'), appSecret)).toBe(false);
  });

  it('يرفض جسمًا مُعدَّلًا بعد التوقيع', () => {
    const original = Buffer.from(JSON.stringify({ hello: 'world' }));
    const tampered = Buffer.from(JSON.stringify({ hello: 'mallory' }));
    expect(verifyMetaSignature(tampered, sign(original, appSecret), appSecret)).toBe(false);
  });

  it('يرفض غياب رأس التوقيع أو سرّ التطبيق', () => {
    const body = Buffer.from('{}');
    expect(verifyMetaSignature(body, undefined, appSecret)).toBe(false);
    expect(verifyMetaSignature(body, sign(body, appSecret), '')).toBe(false);
  });

  it('يرفض مخططًا غير sha256', () => {
    const body = Buffer.from('{}');
    expect(verifyMetaSignature(body, 'sha1=deadbeef', appSecret)).toBe(false);
  });
});
