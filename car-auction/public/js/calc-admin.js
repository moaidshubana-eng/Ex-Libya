// ضبط الحاسبة العامة: علامة صغيرة في تذييل /calc تفتح نافذة للمدير. العلامة للوصول فقط؛ الحماية من دخول المدير في الخادم.
import { html, api, modal, toast } from './core.js';
import { PORTS, SHIP_TYPES } from './calc.js';

const num = (name, value, min = 0) => html`<input class="input num" type="number" step="any" min="${min}" name="${name}" value="${value}" required>`;

async function currentUser() {
  try { return (await api('/auth/me')).user; } catch { return null; }
}

async function login() {
  const v = await modal({
    title: 'دخول المدير',
    submitLabel: 'دخول',
    body: html`<label class="field">البريد الإلكتروني<input class="input" type="email" name="email" autocomplete="username" required></label>
      <label class="field">كلمة المرور<input class="input" type="password" name="password" autocomplete="current-password" required></label>`,
  });
  if (!v) return null;
  try { return (await api('/auth/login', { method: 'POST', body: v })).user; } catch (e) { toast(e.message, 'err'); return null; }
}

async function editSettings(s) {
  const v = await modal({
    title: 'ضبط الحاسبة العامة',
    body: html`<div class="grid g2">
        <label class="field">سعر الصرف (د.ل للدولار)${num('exchange', s.exchange, 0.5)}</label>
        <label class="field">فرق الحوالة (%)${num('transferPct', s.transferPct)}</label>
        <label class="field">الواير ($)${num('wire', s.wire)}</label>
        <label class="field">هامش النقل الداخلي ($)${num('towingMargin', s.towingMargin)}</label>
      </div>
      <div class="table-wrap"><table class="t"><thead><tr><th>الميناء</th>${Object.values(SHIP_TYPES).map((l) => html`<th class="n">${l.split(' ')[0]}</th>`)}</tr></thead>
        <tbody>${Object.entries(PORTS).map(([k, p]) => html`<tr><td>${p.label}</td>${Object.keys(SHIP_TYPES).map((t) => html`<td class="n">${num(`ship:${k}:${t}`, s.ports[k][t])}</td>`)}</tr>`)}</tbody></table></div>
      <p class="faint" style="margin:0;font-size:12.5px">يطبَّق الحفظ على كل زوار الحاسبة العامة، ولا يغيّر حاسبة المنظومة.</p>`,
  });
  if (!v) return;
  const ports = Object.fromEntries(Object.keys(PORTS).map((k) => [k, Object.fromEntries(Object.keys(SHIP_TYPES).map((t) => [t, v[`ship:${k}:${t}`]]))]));
  try {
    await api('/calc-settings', { method: 'PUT', body: { exchange: v.exchange, transferPct: v.transferPct, wire: v.wire, towingMargin: v.towingMargin, ports } });
    location.reload();
  } catch (e) { toast(e.message, 'err'); }
}

export function initCalcAdmin(mark, settings) {
  if (!mark) return;
  mark.addEventListener('click', async () => {
    const user = (await currentUser()) || (await login());
    if (!user) return;
    if (user.role !== 'ADMIN') { toast('هذا الضبط للمدير فقط', 'err'); return; }
    await editSettings(settings);
  });
}
