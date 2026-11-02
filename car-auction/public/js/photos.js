// رفع صور السيارة وإدارتها (للإدارة والعمليات فقط؛ الخادم يفرض الصلاحية).
// الصورة تُصغَّر وتُضغط في المتصفح قبل الرفع: أطول ضلع 1600 بكسل، JPEG بجودة 0.82 (~200–400 كيلوبايت)،
// فيكون الرفع سريعًا من الجوال وتبقى مساحة القاعدة المجانية كافية.
import { html, render, $, $$, api, imgUrl, toast, icon } from './core.js';

const MAX_SIDE = 1600;
const QUALITY = 0.82;

export function photosBar(v) {
  return html`<div class="card card-b row" style="justify-content:space-between;gap:8px;flex-wrap:wrap">
    <span class="muted">${v.images.length ? `${v.images.length} صورة` : 'لا توجد صور بعد'}</span>
    <div class="row" style="gap:8px">
      <label class="btn btn-sm btn-primary" style="cursor:pointer">${icon('plus')} إضافة صور
        <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/*" multiple hidden data-photo-input></label>
      ${v.images.length ? html`<button class="btn btn-sm" data-photo-manage>إدارة الصور</button>` : ''}
    </div>
  </div>`;
}

/** opts: path (مسار API للصور) و urlOf (رابط عرض الصورة) — الافتراضي صور السيارة؛ يُستعمل أيضًا للوتات مزادات أمريكا */
export function mountPhotos(el, v, reload, { path = `/vehicles/${v.id}/images`, urlOf = (im) => imgUrl(v.id, im.id) } = {}) {
  $('[data-photo-input]', el)?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    let ok = 0;
    for (const [i, f] of files.entries()) {
      toast(`جارٍ رفع الصورة ${i + 1} من ${files.length}…`);
      try {
        const img = await compress(f);
        await api(path, { method: 'POST', body: img });
        ok++;
      } catch (err) {
        toast(`${f.name}: ${err.message}`, 'err');
      }
    }
    if (ok) { toast(`رُفعت ${ok} صورة`, 'ok'); reload(); }
  });
  $('[data-photo-manage]', el)?.addEventListener('click', () => manageDialog(v, reload, path, urlOf));
}

/** يقرأ الصورة ويصغّرها ويعيدها JPEG بترميز base64 */
export async function compress(file) {
  if (file.size > 40 * 1024 * 1024) throw new Error('الملف كبير جدًا');
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('تعذر قراءة الصورة (استخدم JPEG أو PNG)');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // خلفية بيضاء للصور الشفافة
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('تعذر ضغط الصورة');
  const data = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('تعذر قراءة الصورة'));
    fr.readAsDataURL(blob);
  });
  return { data, width: w, height: h };
}

function manageDialog(v, reload, path, urlOf) {
  const d = document.createElement('dialog');
  d.className = 'modal';
  let changed = false;
  const draw = () => render(d, html`<form method="dialog">
    <div class="m-h"><h3>إدارة الصور</h3><button class="btn btn-ghost btn-sm" value="close" aria-label="إغلاق">✕</button></div>
    <div class="m-b"><div class="photo-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
      ${v.images.map((im) => html`<div class="card" style="overflow:hidden">
        <img src="${urlOf(im)}" alt="" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block">
        <div class="row" style="gap:6px;padding:8px;justify-content:space-between">
          ${im.is_primary ? html`<span class="badge">الرئيسية</span>` : html`<button type="button" class="btn btn-sm" data-primary="${im.id}">اجعلها الرئيسية</button>`}
          <button type="button" class="btn btn-sm btn-danger" data-del="${im.id}" aria-label="حذف">حذف</button>
        </div></div>`)}
    </div></div>
    <div class="m-f"><button class="btn btn-primary" value="close">تم</button></div>
  </form>`);
  draw();
  document.body.appendChild(d);
  d.showModal();
  d.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-primary]');
    const del = e.target.closest('[data-del]');
    if (!p && !del) return;
    try {
      if (p) {
        await api(`${path}/${p.dataset.primary}/primary`, { method: 'POST', body: {} });
        v.images.forEach((im) => { im.is_primary = im.id === p.dataset.primary; });
      } else {
        if (!confirm('حذف هذه الصورة نهائيًا؟')) return;
        await api(`${path}/${del.dataset.del}`, { method: 'DELETE' });
        const wasPrimary = v.images.find((im) => im.id === del.dataset.del)?.is_primary;
        v.images = v.images.filter((im) => im.id !== del.dataset.del);
        if (wasPrimary && v.images[0]) v.images[0].is_primary = true;
      }
      changed = true;
      if (!v.images.length) return d.close();
      draw();
    } catch (err) { toast(err.message, 'err'); }
  });
  d.addEventListener('close', () => { d.remove(); if (changed) reload(); });
}
