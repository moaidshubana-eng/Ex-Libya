// فواتير المصاريف: روابط فتحها، واختيار ملفات ورفعها (الصور تُصغَّر قبل الرفع، وPDF يُرفع كما هو).
import { html, api, toast, modal } from './core.js';
import { compress } from './photos.js';

const MAX_PDF = 5 * 1024 * 1024;

/** روابط الفواتير المرفقة؛ تُفتح في تبويب جديد */
export const attachmentLinks = (list = []) => html`${list.map((a) => html`<a class="att-link" href="/api/expense-attachments/${a.id}" target="_blank" rel="noopener" title="${a.filename}">📎 ${a.mime === 'application/pdf' ? 'PDF' : 'صورة'}</a>`)}`;

async function readFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF) throw new Error(`${file.name}: أكبر من 5 ميغابايت`);
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error(`تعذر قراءة ${file.name}`));
      fr.readAsDataURL(file);
    });
  }
  return (await compress(file)).data;
}

/** يرفع ملفات (File) فاتورةً للمصروف؛ يعيد عدد ما رُفع */
export async function uploadInvoices(expenseId, files) {
  let n = 0;
  for (const file of files) {
    if (!file || !file.size) continue;
    try {
      await api(`/expenses/${expenseId}/attachments`, { method: 'POST', body: { data: await readFile(file), filename: file.name } });
      n++;
    } catch (e) { toast(e.message, 'err'); }
  }
  return n;
}

/** نافذة إرفاق: اختيار ملف، أو لصق صورة منسوخة (Ctrl+V من واتساب مثلًا)؛ تعيد عدد ما رُفع */
export async function pickInvoices(expenseId) {
  const pasted = [];
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!files.length) return;
    e.preventDefault();
    pasted.push(...files);
    const box = document.querySelector('[data-paste-zone]');
    if (box) box.textContent = `✔ لُصق ${pasted.length === 1 ? 'ملف واحد' : `${pasted.length} ملفات`} — اضغط «إرفاق»`;
  };
  document.addEventListener('paste', onPaste);
  const r = await modal({ title: 'إرفاق فاتورة', submitLabel: 'إرفاق', body: html`
    <div class="paste-zone" data-paste-zone tabindex="0">انسخ صورة الفاتورة والصقها هنا (Ctrl+V)</div>
    <label class="field">أو اختر ملفًا (صورة أو PDF)<input class="input" type="file" name="files" accept="image/*,application/pdf" multiple></label>` });
  document.removeEventListener('paste', onPaste);
  if (!r) return 0;
  const n = await uploadInvoices(expenseId, [...pasted, ...(r.files || [])]);
  if (n) toast(n === 1 ? 'أُرفقت الفاتورة' : `أُرفقت ${n} فواتير`, 'ok');
  return n;
}

/** حقل اختيار الفاتورة داخل نموذج مصروف جديد */
export const invoiceField = () => html`<label class="field">الفاتورة (صورة أو PDF — اختياري)<input class="input" type="file" name="invoice" accept="image/*,application/pdf" multiple></label>`;
