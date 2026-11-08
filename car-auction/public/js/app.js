import { html, render, $, $$, api, state, LABELS, icon, toast } from './core.js';
import { dashboardView, vehiclesView, vehicleDetailView, compareView } from './views-vehicles.js';
import { auctionsView, lotView } from './views-auctions.js';
import { settingsView, changePasswordDialog } from './views-settings.js';
import { customersView } from './views-manage.js';
import { shipmentsView, customsView, reportsView, integrationsView, auditView } from './views-ops.js';
import { accountsView, statementView } from './views-accounts.js';
import { financeView, receiptView } from './views-finance.js';
import { watchlistView } from './views-watchlist.js';
import { custodiesView, custodyView } from './views-custody.js';
import { calculatorView } from './views-calculator.js';
// الحسابات التجريبية لا وجود لها في الإنتاج: لا تُعرض إلا عند التشغيل المحلي
const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);

const STAFF = ['ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES', 'VIEWER'];
const ROUTES = [
  { path: '/dashboard', title: 'لوحة المؤشرات', view: dashboardView, roles: STAFF, nav: ['dash', 'التشغيل'] },
  { path: '/vehicles', title: 'السيارات', view: vehiclesView, nav: ['car'] },
  { path: '/watchlist', title: 'مزادات أمريكا', view: watchlistView, roles: STAFF, nav: ['clock'] },
  { path: '/calculator', title: 'حاسبة التكلفة', view: calculatorView, roles: STAFF, nav: ['money'] },
  { path: '/vehicles/:id', title: 'تفاصيل السيارة', view: vehicleDetailView },
  { path: '/compare', title: 'مقارنة السيارات', view: compareView },
  { path: '/auctions', title: 'المزادات', view: auctionsView, nav: ['gavel'] },
  { path: '/lots/:id', title: 'المزايدة', view: lotView },
  { path: '/customers', title: 'العملاء', view: customersView, roles: ['ADMIN', 'SALES', 'ACCOUNTANT'], nav: ['users'] },
  { path: '/shipments', title: 'تتبع الشحنات', view: shipmentsView, roles: STAFF, nav: ['ship', 'اللوجستيات'] },
  { path: '/customs', title: 'الجمارك', view: customsView, roles: STAFF, nav: ['customs'] },
  { path: '/accounts', title: 'حسابات العملاء والموردين', view: accountsView, roles: ['ADMIN', 'ACCOUNTANT', 'SALES', 'OPERATIONS', 'VIEWER'], nav: ['money', 'المالية'] },
  { path: '/accounts/:type/:id', title: 'كشف حساب', view: statementView, roles: ['ADMIN', 'ACCOUNTANT', 'SALES', 'OPERATIONS', 'VIEWER'] },
  { path: '/finance', title: 'الأرباح والمصاريف', view: financeView, roles: ['ADMIN', 'ACCOUNTANT', 'VIEWER'], nav: ['report'] },
  { path: '/custody', title: 'العُهد', view: custodiesView, roles: ['ADMIN', 'ACCOUNTANT', 'VIEWER'], nav: ['money'] },
  { path: '/custody/:id', title: 'كشف عهدة', view: custodyView, roles: ['ADMIN', 'ACCOUNTANT', 'VIEWER'] },
  { path: '/receipts/:id', title: 'إيصال', view: receiptView, roles: ['ADMIN', 'ACCOUNTANT', 'SALES', 'OPERATIONS', 'VIEWER'] },
  { path: '/reports', title: 'تقرير التكاليف', view: reportsView, roles: ['ADMIN', 'ACCOUNTANT', 'OPERATIONS', 'VIEWER', 'SALES'], nav: ['report'] },
  { path: '/integrations', title: 'الربط مع Copart / IAAI', view: integrationsView, roles: STAFF, nav: ['sync', 'النظام'] },
  { path: '/settings', title: 'الإعدادات', view: settingsView, roles: ['ADMIN', 'ACCOUNTANT', 'OPERATIONS'], nav: ['money'] },
  { path: '/audit', title: 'سجل التدقيق', view: auditView, roles: ['ADMIN'], nav: ['audit'] },
];

function match(hash) {
  const [path, qs] = (hash.replace(/^#/, '') || '/').split('?');
  for (const r of ROUTES) {
    const keys = [];
    const re = new RegExp(`^${r.path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    const m = path.match(re);
    if (m) return { route: r, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }
  return null;
}

let cleanup = null;
let navToken = 0;

async function navigate() {
  const home = state.user.role === 'BIDDER' ? '#/auctions' : '#/dashboard';
  const m = match(location.hash);
  if (!m || (m.route.roles && !m.route.roles.includes(state.user.role))) { location.replace(home); return; }
  const token = ++navToken;
  cleanup?.();
  cleanup = null;
  const seg = { lots: 'auctions', compare: 'vehicles' }[location.hash.split(/[/?]/)[1]] || location.hash.split(/[/?]/)[1];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${seg}`));
  $('.shell').classList.remove('nav-open');
  const setTitle = (t, crumb = '') => { $('[data-title]').textContent = t; $('[data-crumbs]').textContent = crumb; document.title = `${t} — Golden Gate Motors`; };
  setTitle(m.route.title);
  const content = $('[data-content]');
  render(content, html`<div class="grid g4">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:110px"></div>`)}</div><div class="skeleton" style="height:320px;margin-top:16px"></div>`);
  try {
    const c = await m.route.view(content, { params: m.params, query: m.query, setTitle });
    if (token === navToken) cleanup = typeof c === 'function' ? c : null;
    else c?.();
    window.scrollTo(0, 0);
  } catch (e) {
    if (token !== navToken) return;
    render(content, html`<div class="card empty">${e.status === 404 ? 'غير موجود' : `تعذر التحميل: ${e.message}`}</div>`);
  }
}

function shell() {
  const u = state.user;
  let section = null;
  const nav = ROUTES.filter((r) => r.nav && (!r.roles || r.roles.includes(u.role))).map((r) => {
    const head = r.nav[1] && r.nav[1] !== section ? ((section = r.nav[1]), html`<div class="nav-section">${r.nav[1]}</div>`) : '';
    return html`${head}<a href="#${r.path}">${icon(r.nav[0])}<span>${r.title}</span>${r.path === '/auctions' ? html`<span class="badge-live">مباشر</span>` : ''}</a>`;
  });
  render(document.body, html`<a class="sr-only" href="#main">تخطَّ إلى المحتوى</a><div class="shell">
    <aside class="sidebar" aria-label="القائمة الرئيسية">
      <div class="brand"><img class="brand-logo" src="/brand/ggm-logo-official.png" alt="Golden Gate Motors"><small>منظومة الاستيراد والمزايدة</small></div>
      <nav class="nav">${nav}</nav>
      <div class="me"><b>${u.full_name}</b><span>${LABELS.role[u.role]}</span>
        <div class="row" style="margin-top:8px"><button class="btn btn-sm btn-ghost" style="color:#c6d3e3" data-theme-toggle>الوضع الداكن/الفاتح</button>
        <button class="btn btn-sm btn-ghost" style="color:#c6d3e3" data-pw>كلمة المرور</button>
        <button class="btn btn-sm btn-ghost" style="color:#c6d3e3" data-logout>${icon('logout')} خروج</button></div></div>
    </aside>
    <main class="main" id="main">
      <header class="topbar"><button class="btn btn-sm menu-btn" data-menu aria-label="القائمة">${icon('menu')}</button><img class="topbar-mark" src="/brand/ggm-icon-64.png" alt="Golden Gate Motors">
        <div><h1 data-title></h1><div class="crumbs" data-crumbs></div></div><span class="spacer"></span></header>
      <div class="content" data-content></div>
    </main></div><div class="toast-host" aria-live="polite"></div>`);
  $('[data-menu]').addEventListener('click', () => $('.shell').classList.toggle('nav-open'));
  $('[data-pw]').addEventListener('click', changePasswordDialog);
  $('[data-logout]').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); location.hash = ''; location.reload(); });
  $('[data-theme-toggle]').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch { /* التخزين غير متاح */ }
  });
}

function loginScreen() {
  render(document.body, html`<div class="login">
    <section class="hero">
      <div class="brand brand-hero"><img class="brand-logo" src="/brand/ggm-logo-official.png" alt="Golden Gate Motors"><small>منظومة الاستيراد والمزايدة</small></div>
      <div><h1>من ساحة المزاد في أمريكا<br>إلى المشتري في ليبيا — في شاشة واحدة</h1>
        <p>تتبع كل سيارة عبر الشحن والجمارك والنقل، تكاليف دقيقة لكل سيارة، ومزايدات حية، وتقارير جاهزة للتصدير.</p></div>
      <div class="feats">
        <div class="feat"><b>تتبع شامل</b>16 حالة لدورة حياة السيارة بقواعد انتقال صارمة</div>
        <div class="feat"><b>مزايدة حية</b>تحديث لحظي، مزايدة آلية، وحماية من القنص</div>
        <div class="feat"><b>تكلفة واصلة دقيقة</b>كل بند بعملته وسعر صرفه لحظة التسجيل</div>
        <div class="feat"><b>استيراد وتصدير</b>رفع السيارات من ملف Excel/CSV وتصدير التقارير</div>
      </div>
    </section>
    <section class="form-side"><form data-login novalidate>
      <h2 style="margin:0">تسجيل الدخول</h2>
      <label class="field">البريد الإلكتروني<input class="input" name="email" type="email" autocomplete="username" required></label>
      <label class="field">كلمة المرور<input class="input" name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary" style="min-height:44px">دخول</button>
      <div data-err role="alert" style="color:var(--danger);min-height:1.4em"></div>
      ${isLocal ? html`<div class="demo">حسابات تجريبية (كلمة المرور <span class="mono">Demo@2026pass</span>):<br>
        ${[['admin', 'مدير'], ['ops', 'عمليات'], ['accountant', 'محاسب'], ['sales', 'مبيعات'], ['bidder1', 'مزايد']].map(([e, l]) => html`<button type="button" data-demo="${e}@auction.ly">${l}</button> `)}</div>` : ''}
    </form></section></div>`);
  const form = $('[data-login]');
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => { form.email.value = b.dataset.demo; form.password.value = 'Demo@2026pass'; form.requestSubmit(); }));
  const btn = $('button:not([type=button])', form);
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return; // منع الإرسال المزدوج (ضغط Enter والزر معًا، أو انتظار استيقاظ الخادم)
    busy = true; btn.disabled = true; btn.textContent = 'جارٍ الدخول…';
    $('[data-err]').textContent = '';
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email: form.email.value.trim(), password: form.password.value } });
      document.removeEventListener('keydown', onEnter);
      state.user = user;
      await start();
    } catch (err) {
      $('[data-err]').textContent = err.message;
      busy = false; btn.disabled = false; btn.textContent = 'دخول';
    }
  });
  // المتصفح قد يملأ البريد وكلمة المرور تلقائيًا دون أن يكون المؤشر داخل أي حقل، فلا يعمل Enter.
  // نضع المؤشر في أول حقل فارغ، ونقبل Enter من أي مكان في شاشة الدخول
  (form.email.value ? form.password : form.email).focus();
  const onEnter = (e) => {
    if (e.key !== 'Enter' || e.isComposing || !document.body.contains(form)) return;
    if (form.contains(e.target) && e.target.matches('input, button')) return; // سلوك المتصفح الطبيعي يكفي هنا
    e.preventDefault();
    form.requestSubmit();
  };
  document.addEventListener('keydown', onEnter);
}

async function start() {
  state.meta = await api('/meta');
  if (!state.meta.integrationsEnabled) {
    const r = ROUTES.find((x) => x.path === '/integrations');
    Object.assign(r, { title: 'استيراد من ملف', roles: ['ADMIN', 'OPERATIONS'] });
  }
  shell();
  window.removeEventListener('hashchange', navigate);
  window.addEventListener('hashchange', navigate);
  navigate();
}

// فقط لمن كان داخلًا فعلًا: فحص /auth/me الأول بلا جلسة يعيد 401 طبيعيًا، وإعادة التحميل عندها تصنع حلقة لا تنتهي
let expiring = false;
window.addEventListener('auth:expired', () => {
  if (!state.user || expiring) return;
  expiring = true;
  toast('انتهت الجلسة — سجل الدخول مجددًا', 'err');
  setTimeout(() => location.reload(), 1200);
});

(async () => {
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* */ }
  try {
    state.user = (await api('/auth/me')).user;
    await start();
  } catch {
    loginScreen();
  }
})();
