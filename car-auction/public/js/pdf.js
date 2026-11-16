// تحميل صفحة من المنظومة كملف PDF مباشرة (بلا نافذة الطباعة).
// المتصفح نفسه يرسم الصفحة صورةً (SVG foreignObject)، فيبقى العربي ووصل الحروف والمسافات كما على الشاشة؛
// ورسم html2canvas للنص العربي يلزق الكلمات ببعض. ثم jsPDF (من /vendor، تُحمَّل عند أول ضغطة؛ CSP لا تسمح بسكربت خارجي)
// يضع الصورة في صفحات A4 مقطوعة بين السطور والبطاقات لا في وسطها.
// ما عليه .no-print لا يظهر في الملف، وما عليه .print-only يظهر.
const PDF_W = 720; // عرض المحتوى بالبكسل = 190 مم (A4 ناقص هامشين 10 مم)
const PDF_SCALE = 2;
const PAGE_H = (PDF_W * 277) / 190; // ارتفاع 277 مم بنفس المقياس
const CUT_AT = 'thead tr, tbody tr, tfoot tr, .card, .stmt-kpis, .grid > *, .owed';
// خط النظام (خط الشاشة لا يُحمَّل داخل الصورة)، وجداول تلتف نصوصها حتى لا يخرج عمود عن عرض الصفحة
const FONT = '*{font-family:"Segoe UI",Tahoma,Arial,sans-serif !important}'
  + '.t{width:100%}.t td,.t th{white-space:normal !important;padding:5px 6px !important;font-size:12px !important}'
  + '.t td.n,.t th.n,.t .mono,.t .num{white-space:nowrap !important}';
const BODY_STYLE = `margin:0;padding:0;width:${PDF_W}px;min-height:0;background:#fff`;
let pdfLib, cssText;
const loadPdfLib = () => (pdfLib ??= new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: '/vendor/html2pdf.bundle.min.js' });
  s.onload = () => resolve(window.html2pdf);
  s.onerror = () => { pdfLib = null; reject(new Error('تعذّر تحميل أداة PDF')); };
  document.head.appendChild(s);
}));
const dataUrl = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });

/** نسخة من العقدة جاهزة للملف: بلا أزرار، بعرض الصفحة، والصور مضمَّنة */
async function prepare(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('.no-print').forEach((x) => x.remove());
  copy.querySelectorAll('.print-only').forEach((x) => { x.style.display = 'block'; });
  copy.style.cssText = `width:${PDF_W}px;max-width:none;margin:0;box-shadow:none;border:0;border-radius:0;box-sizing:border-box`;
  copy.querySelectorAll('.table-wrap').forEach((x) => { x.style.overflow = 'visible'; });
  // الصورة داخل SVG لا تجلب ملفات خارجية: الشعار وأي صورة تُضمَّن
  for (const im of copy.querySelectorAll('img')) im.src = await dataUrl(await fetch(im.src).then((r) => r.blob()));
  cssText ??= await fetch([...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href).find((h) => h.startsWith(location.origin))).then((r) => r.text());
  return copy;
}

/** يقيس الارتفاع ومواضع القطع في إطار بعرض الصفحة نفسه، حتى تنطبق قواعد العرض (media) كما في الصورة تمامًا */
async function measure(copy) {
  const frame = document.createElement('iframe');
  frame.style.cssText = `position:absolute;top:0;left:-10000px;width:${PDF_W}px;height:100px;border:0;visibility:hidden`;
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    // doctype حتى يكون الإطار بالوضع القياسي مثل الصورة؛ بدونه (quirks) تختلف ارتفاعات السطور فتنزاح مواضع القطع
    doc.open();
    doc.write('<!doctype html><html dir="rtl" lang="ar" data-theme="light"><head></head><body></body></html>');
    doc.close();
    doc.head.appendChild(Object.assign(doc.createElement('style'), { textContent: cssText + FONT }));
    doc.body.style.cssText = BODY_STYLE;
    const el = doc.body.appendChild(doc.importNode(copy, true));
    // حدث التحميل لا decode(): الأخيرة قد لا تنتهي أبدًا لصورة في إطار مخفي
    await Promise.all([...el.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
    const top = el.getBoundingClientRect().top;
    return {
      height: Math.ceil(el.getBoundingClientRect().height) + 2,
      cuts: [...el.querySelectorAll(CUT_AT)].map((x) => Math.ceil(x.getBoundingClientRect().bottom - top)),
    };
  } finally { frame.remove(); }
}

/** صورة SVG للنسخة بنفس بنية الإطار (جذر بسمة فاتحة ثم body) */
async function rasterSource(copy, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" data-theme="light" width="${PDF_W}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">`
    + `<body xmlns="http://www.w3.org/1999/xhtml" dir="rtl" lang="ar" style="${BODY_STYLE}"><style>${cssText.replace(/<\//g, '<\\/')}${FONT}</style>`
    + `${new XMLSerializer().serializeToString(copy)}</body></foreignObject></svg>`;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('تعذّر رسم الصفحة'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  return img;
}

/** حدود الصفحات: كل صفحة تنتهي عند أقرب حدّ سطر أو بطاقة */
function pageBreaks(height, cuts) {
  const pages = [];
  for (let start = 0; start < height;) {
    const limit = start + PAGE_H;
    const fits = cuts.filter((c) => c > start + PAGE_H / 3 && c <= limit);
    const end = height <= limit ? height : (fits.length ? Math.max(...fits) : Math.floor(limit));
    pages.push([start, end]);
    start = end;
  }
  return pages;
}

/** كل صفحة تُرسم على لوحتها مباشرة من الصورة (لوحة واحدة للتقرير الطويل تتجاوز حد المتصفح) */
function drawPage(img, [start, end]) {
  const page = Object.assign(document.createElement('canvas'), { width: PDF_W * PDF_SCALE, height: Math.ceil((end - start) * PDF_SCALE) });
  const ctx = page.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, page.width, page.height);
  ctx.scale(PDF_SCALE, PDF_SCALE);
  ctx.translate(0, -start);
  ctx.drawImage(img, 0, 0);
  return page;
}

/** ينشئ ملف PDF من العقدة وينزّله باسم filename */
export async function downloadPdf(node, filename) {
  const [html2pdf, copy] = await Promise.all([loadPdfLib(), prepare(node)]);
  const { height, cuts } = await measure(copy);
  const img = await rasterSource(copy, height);
  const [first, ...rest] = pageBreaks(height, cuts);
  const pdf = await html2pdf().set({ margin: 10, image: { type: 'jpeg', quality: 0.92 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } })
    .from(drawPage(img, first), 'canvas').toPdf().get('pdf');
  for (const range of rest) {
    const p = drawPage(img, range);
    pdf.addPage();
    pdf.addImage(p.toDataURL('image/jpeg', 0.92), 'JPEG', 10, 10, 190, (p.height / PDF_SCALE) * (190 / PDF_W));
  }
  pdf.save(filename);
}
