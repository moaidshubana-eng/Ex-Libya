// معرض الصور: عدسة تكبير عند المرور، عارض ملء الشاشة بتكبير حتى 6× (العجلة/القرص/الأزرار)،
// سحب للتحريك، تنقل بلوحة المفاتيح، ودعم اللمس (قرص بإصبعين وسحب).
import { html, render, $, $$, icon } from './core.js';

export function galleryTemplate(images, urlOf, title) {
  if (!images.length) return html`<div class="card empty">لا توجد صور</div>`;
  return html`<div class="gallery" data-index="0">
    <div class="stage-img" tabindex="0" role="button" aria-label="فتح الصورة بالحجم الكامل">
      <img src="${urlOf(images[0])}" alt="${title} — ${images[0].caption || ''}" draggable="false">
      <div class="lens" aria-hidden="true"></div>
      <button class="nav-arrow prev" aria-label="السابقة">${icon('right')}</button>
      <button class="nav-arrow next" aria-label="التالية">${icon('left')}</button>
      <span class="hint">مرّر للتكبير · انقر للعرض الكامل</span>
    </div>
    <div class="thumbs">${images.map((im, i) => html`<button class="${i === 0 ? 'on' : ''}" data-i="${i}" aria-label="${im.caption || `صورة ${i + 1}`}"><img src="${urlOf(im)}" alt="" loading="lazy"></button>`)}</div>
  </div>`;
}

export function mountGallery(root, images, urlOf, title) {
  const g = $('.gallery', root);
  if (!g) return;
  const stage = $('.stage-img', g);
  const img = $('img', stage);
  const lens = $('.lens', stage);
  let idx = 0;
  const ZOOM = 2.6;

  const show = (i) => {
    idx = (i + images.length) % images.length;
    img.src = urlOf(images[idx]);
    img.alt = `${title} — ${images[idx].caption || ''}`;
    $$('.thumbs button', g).forEach((b, k) => b.classList.toggle('on', k === idx));
  };
  $$('.thumbs button', g).forEach((b) => b.addEventListener('click', () => show(Number(b.dataset.i))));
  $('.prev', g).addEventListener('click', (e) => { e.stopPropagation(); show(idx - 1); });
  $('.next', g).addEventListener('click', (e) => { e.stopPropagation(); show(idx + 1); });

  // عدسة التكبير: تعرض نفس الصورة بتكبير ZOOM حول موضع المؤشر (الصورة متجهية فتبقى حادة)
  stage.addEventListener('mousemove', (e) => {
    const r = img.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) { lens.style.display = 'none'; return; }
    lens.style.display = 'block';
    const lw = lens.offsetWidth / 2;
    const sr = stage.getBoundingClientRect();
    lens.style.left = `${e.clientX - sr.left - lw}px`;
    lens.style.top = `${e.clientY - sr.top - lw}px`;
    lens.style.backgroundImage = `url("${img.src}")`;
    lens.style.backgroundSize = `${r.width * ZOOM}px ${r.height * ZOOM}px`;
    lens.style.backgroundPosition = `${-(x * ZOOM - lw)}px ${-(y * ZOOM - lw)}px`;
  });
  stage.addEventListener('mouseleave', () => { lens.style.display = 'none'; });
  stage.addEventListener('click', (e) => { if (!e.target.closest('.nav-arrow')) openLightbox(images, urlOf, idx, title); });
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(images, urlOf, idx, title); }
    if (e.key === 'ArrowLeft') show(idx + 1);
    if (e.key === 'ArrowRight') show(idx - 1);
  });
}

export function openLightbox(images, urlOf, start = 0, title = '') {
  let idx = start, scale = 1, tx = 0, ty = 0;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', `صور ${title}`);
  render(box, html`
    <div class="lb-top">
      <b style="flex:1">${title} <span class="faint" data-cap></span></b>
      <button class="btn btn-sm" data-act="out" aria-label="تصغير">−</button>
      <span class="num" data-zoom style="min-width:52px;text-align:center">100%</span>
      <button class="btn btn-sm" data-act="in" aria-label="تكبير">+</button>
      <button class="btn btn-sm" data-act="reset">ملاءمة</button>
      <button class="btn btn-sm" data-act="close" aria-label="إغلاق">✕ إغلاق</button>
    </div>
    <div class="lb-stage"><img alt="" draggable="false"></div>
    <div class="lb-strip">${images.map((im, i) => html`<button data-i="${i}" aria-label="${im.caption || i + 1}"><img src="${urlOf(im)}" alt=""></button>`)}</div>`);
  document.body.appendChild(box);
  const img = $('.lb-stage img', box);
  const stageEl = $('.lb-stage', box);
  const prevFocus = document.activeElement;

  const apply = () => {
    img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${scale})`;
    $('[data-zoom]', box).textContent = `${Math.round(scale * 100)}%`;
  };
  const show = (i) => {
    idx = (i + images.length) % images.length;
    img.src = urlOf(images[idx]);
    $('[data-cap]', box).textContent = `— ${images[idx].caption || ''} (${idx + 1}/${images.length})`;
    $$('.lb-strip button', box).forEach((b, k) => b.classList.toggle('on', k === idx));
    scale = 1; tx = 0; ty = 0; apply();
  };
  const zoomAt = (factor, cx = 0, cy = 0) => {
    const ns = Math.min(6, Math.max(1, scale * factor));
    const k = ns / scale;
    tx = cx - (cx - tx) * k; ty = cy - (cy - ty) * k; // التكبير حول نقطة المؤشر
    scale = ns;
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  };
  const close = () => { document.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', close); box.remove(); prevFocus?.focus?.(); };
  window.addEventListener('hashchange', close); // التنقل لصفحة أخرى يغلق العارض
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(idx + 1);
    else if (e.key === 'ArrowRight') show(idx - 1);
    else if (e.key === '+' || e.key === '=') zoomAt(1.4);
    else if (e.key === '-') zoomAt(1 / 1.4);
  };
  document.addEventListener('keydown', onKey);
  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'in') zoomAt(1.4);
    if (act === 'out') zoomAt(1 / 1.4);
    if (act === 'reset') { scale = 1; tx = 0; ty = 0; apply(); }
    const th = e.target.closest('.lb-strip button');
    if (th) show(Number(th.dataset.i));
  });
  stageEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stageEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
  }, { passive: false });
  stageEl.addEventListener('dblclick', (e) => {
    const r = stageEl.getBoundingClientRect();
    if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(); } else zoomAt(2.5, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
  });

  // السحب واللمس (Pointer Events) مع قرص الإصبعين
  const pts = new Map();
  let last = null, pinch0 = null;
  stageEl.addEventListener('pointerdown', (e) => { stageEl.setPointerCapture(e.pointerId); pts.set(e.pointerId, e); last = e; stageEl.classList.add('dragging'); });
  stageEl.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinch0) zoomAt(d / pinch0);
      pinch0 = d;
      return;
    }
    if (scale > 1 && last) { tx += e.clientX - last.clientX; ty += e.clientY - last.clientY; apply(); }
    last = e;
  });
  const up = (e) => { pts.delete(e.pointerId); pinch0 = null; last = null; if (!pts.size) stageEl.classList.remove('dragging'); };
  stageEl.addEventListener('pointerup', up);
  stageEl.addEventListener('pointercancel', up);

  show(idx);
  $('[data-act="close"]', box).focus();
}
