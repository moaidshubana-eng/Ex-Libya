import { createHmac, timingSafeEqual } from 'crypto';

/**
 * يتحقق من توقيع Meta لطلب Webhook (رأس X-Hub-Signature-256): تجزئة HMAC-SHA256
 * للجسم الخام موقّعة بسرّ التطبيق (App Secret). لا يُعتمد على هذا الرابط الخلفي
 * أي حمولة بلا توقيع صالح — أي طرف يعرف الرابط فقط لا يمكنه انتحال رسائل واردة.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const [scheme, signature] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !signature) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
