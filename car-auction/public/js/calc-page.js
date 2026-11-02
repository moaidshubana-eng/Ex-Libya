// الحاسبة العامة (/calc): نفس حاسبة المنظومة بلا تسجيل دخول ولا اتصال بالخادم — الحساب كله في المتصفح.
import { $ } from './core.js';
import { calculatorView } from './views-calculator.js';

try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* */ }
calculatorView($('[data-calc]'), { publicMode: true });
