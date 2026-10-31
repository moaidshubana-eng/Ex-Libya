// صور السيارات المرفوعة يدويًا: تُحفظ في قاعدة البيانات (BYTEA) لأن الاستضافة قد لا تملك قرصًا دائمًا.
// الواجهة تصغّر الصورة وتضغطها قبل الرفع (~200–400 كيلوبايت)، والخادم يتحقق من النوع الحقيقي من البايتات
// نفسها لا من الاسم أو ما يدّعيه المتصفح.
import { createHash } from 'node:crypto';
import { tx, audit } from '../db.js';
import { HttpError } from '../security/middleware.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_VEHICLE = 40;

/** يحدد النوع من التوقيع الثنائي (magic bytes). يرفض SVG وكل ما عدا JPEG/PNG/WebP */
export function sniffImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** يفك data URL أو base64 خام ويتحقق من الحجم والنوع */
export function decodeImage(data) {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(data);
  const b64 = (m ? m[1] : data).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new HttpError(422, 'BAD_IMAGE', 'بيانات الصورة غير صالحة');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new HttpError(422, 'BAD_IMAGE', 'الصورة فارغة');
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'IMAGE_TOO_LARGE', 'الصورة أكبر من 5 ميغابايت');
  const mime = sniffImageType(buf);
  if (!mime) throw new HttpError(415, 'UNSUPPORTED_IMAGE', 'نوع الصورة غير مدعوم (JPEG أو PNG أو WebP فقط)');
  return { buf, mime };
}

export async function addVehicleImage(vehicleId, { data, kind, caption, width, height }, actor) {
  const { buf, mime } = decodeImage(data);
  const sha = createHash('sha256').update(buf).digest('hex');
  return tx(async (c) => {
    const { rows: [v] } = await c.query('SELECT id FROM vehicles WHERE id = $1 FOR UPDATE', [vehicleId]);
    if (!v) throw new HttpError(404, 'NOT_FOUND', 'السيارة غير موجودة');
    const { rows: [st] } = await c.query(
      'SELECT count(*)::int AS n, COALESCE(max(sort_order), -1) AS last, bool_or(is_primary) AS has_primary FROM vehicle_images WHERE vehicle_id = $1', [vehicleId]);
    if (st.n >= MAX_IMAGES_PER_VEHICLE) throw new HttpError(422, 'TOO_MANY_IMAGES', `الحد الأقصى ${MAX_IMAGES_PER_VEHICLE} صورة للسيارة`);
    const { rows: [im] } = await c.query(
      `INSERT INTO vehicle_images (vehicle_id, kind, storage_key, content, mime, bytes, sha256, caption, width, height, sort_order, is_primary, captured_at)
       VALUES ($1, COALESCE($2::image_kind, 'EXTERIOR'), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (vehicle_id, sha256) DO NOTHING
       RETURNING id, kind, caption, width, height, is_primary, sort_order`,
      [vehicleId, kind || null, `db:${sha}`, buf, mime, buf.length, sha, caption || null, width || null, height || null, st.last + 1, !st.has_primary]);
    if (!im) throw new HttpError(409, 'DUPLICATE_IMAGE', 'هذه الصورة مرفوعة مسبقًا لهذه السيارة');
    await audit(c, { actorId: actor.id, action: 'VEHICLE_IMAGE_ADDED', entity: 'vehicle', entityId: vehicleId, after: { imageId: im.id, bytes: buf.length, mime }, ip: actor.ip });
    return im;
  });
}

export async function deleteVehicleImage(vehicleId, imageId, actor) {
  return tx(async (c) => {
    const { rows: [im] } = await c.query(
      'DELETE FROM vehicle_images WHERE id = $1 AND vehicle_id = $2 RETURNING id, is_primary, bytes', [imageId, vehicleId]);
    if (!im) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
    if (im.is_primary) {
      // الصورة الرئيسية حُذفت: أول صورة متبقية تصبح الرئيسية
      await c.query(
        `UPDATE vehicle_images SET is_primary = TRUE WHERE id = (
           SELECT id FROM vehicle_images WHERE vehicle_id = $1 ORDER BY sort_order LIMIT 1)`, [vehicleId]);
    }
    await audit(c, { actorId: actor.id, action: 'VEHICLE_IMAGE_DELETED', entity: 'vehicle', entityId: vehicleId, before: { imageId, bytes: im.bytes }, ip: actor.ip });
    return { ok: true };
  });
}

export async function setPrimaryImage(vehicleId, imageId, actor) {
  return tx(async (c) => {
    const { rows: [im] } = await c.query('SELECT id FROM vehicle_images WHERE id = $1 AND vehicle_id = $2 FOR UPDATE', [imageId, vehicleId]);
    if (!im) throw new HttpError(404, 'NOT_FOUND', 'الصورة غير موجودة');
    // الفهرس الفريد الجزئي يمنع صورتين رئيسيتين: نلغي القديمة أولًا
    await c.query('UPDATE vehicle_images SET is_primary = FALSE WHERE vehicle_id = $1 AND is_primary', [vehicleId]);
    await c.query('UPDATE vehicle_images SET is_primary = TRUE WHERE id = $1', [imageId]);
    await audit(c, { actorId: actor.id, action: 'VEHICLE_IMAGE_PRIMARY', entity: 'vehicle', entityId: vehicleId, after: { imageId }, ip: actor.ip });
    return { ok: true };
  });
}
