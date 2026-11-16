// فواتير المصاريف: روابط فتحها، واختيار ملفات ورفعها (الصور تُصغَّر قبل الرفع، وPDF يُرفع كما هو).
import { html, api, toast } from './core.js';
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

/** يفتح اختيار الملفات ثم يرفعها */
export function pickInvoices(expenseId) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*,application/pdf', multiple: true });
    input.addEventListener('change', async () => {
      const n = await uploadInvoices(expenseId, [...input.files]);
      if (n) toast(n === 1 ? 'أُرفقت الفاتورة' : `أُرفقت ${n} فواتير`, 'ok');
      resolve(n);
    });
    input.click();
  });
}

/** حقل اختيار الفاتورة داخل نموذج مصروف جديد */
export const invoiceField = () => html`<label class="field">الفاتورة (صورة أو PDF — اختياري)<input class="input" type="file" name="invoice" accept="image/*,application/pdf" multiple></label>`;
