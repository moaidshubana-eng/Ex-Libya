// الحاسبة العامة (/calc): نفس حاسبة المنظومة بلا تسجيل دخول — الحساب كله في المتصفح، والإعدادات من الخادم.
import { $, api } from './core.js';
import { calculatorView } from './views-calculator.js';
import { mergeSettings } from './calc.js';
import { initCalcAdmin } from './calc-admin.js';

try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* */ }
// إن تعذّرت القراءة تعمل الحاسبة بالأسعار الافتراضية
const settings = await api('/public/calc-settings').then((r) => r.settings).catch(() => null);
calculatorView($('[data-calc]'), { publicMode: true, settings });
initCalcAdmin($('[data-calc-mark]'), mergeSettings(settings));
