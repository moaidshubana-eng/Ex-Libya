import { html, render, $, $$, api, state, LABELS, icon, toast } from './core.js';
import { dashboardView, vehiclesView, vehicleDetailView, compareView } from './views-vehicles.js';
import { auctionsView, lotView } from './views-auctions.js';
import { shipmentsView, customsView, reportsView, integrationsView, auditView } from './views-ops.js';

const STAFF = ['ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES', 'VIEWER'];
const ROUTES = [
  { path: '/dashboard', title: 'لوحة المؤشرات', view: dashboardView, roles: STAFF, nav: ['dash', 'التشغيل'] },
  { path: '/vehicles', title: 'السيارات', view: vehiclesView, nav: ['car'] },
  { path: '/vehicles/:id', title: 'تفاصيل السيارة', view: vehicleDetailView },
  { path: '/compare', title: 'مقارنة السيارات', view: compareView },
  { path: '/auctions', title: 'المزادات', view: auctionsView, nav: ['gavel'] },
  { path: '/lots/:id', title: 'المزايدة', view: lotView },
  { path: '/shipments', title: 'تتبع الشحنات', view: shipmentsView, roles: STAFF, nav: ['ship', 'اللوجستيات'] },
  { path: '/customs', title: 'الجمارك', view: customsView, roles: STAFF, nav: ['customs'] },
  { path: '/reports', title: 'تقرير التكاليف', view: reportsView, roles: ['ADMIN', 'ACCOUNTANT', 'OPERATIONS', 'VIEWER', 'SALES'], nav: ['report', 'المالية'] },
  { path: '/integrations', title: 'الربط مع Copart / IAAI', view: integrationsView, roles: STAFF, nav: ['sync', 'النظام'] },
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
  const setTitle = (t, crumb = '') => { $('[data-title]').textContent = t; $('[data-crumbs]').textContent = crumb; document.title = `${t} — مزاد السيارات`; };
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
      <div class="brand"><div class="brand-mark">م</div><div><b>مزاد السيارات</b><small>استيراد · تتبع · مزايدة</small></div></div>
      <nav class="nav">${nav}</nav>
      <div class="me"><b>${u.full_name}</b><span>${LABELS.role[u.role]}</span>
        <div class="row" style="margin-top:8px"><button class="btn btn-sm btn-ghost" style="color:#c6d3e3" data-theme-toggle>الوضع الداكن/الفاتح</button>
        <button class="btn btn-sm btn-ghost" style="color:#c6d3e3" data-logout>${icon('logout')} خروج</button></div></div>
    </aside>
    <main class="main" id="main">
      <header class="topbar"><button class="btn btn-sm menu-btn" data-menu aria-label="القائمة">${icon('menu')}</button>
        <div><h1 data-title></h1><div class="crumbs" data-crumbs></div></div><span class="spacer"></span></header>
      <div class="content" data-content></div>
    </main></div><div class="toast-host" aria-live="polite"></div>`);
  $('[data-menu]').addEventListener('click', () => $('.shell').classList.toggle('nav-open'));
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
      <div class="brand" style="padding:0"><div class="brand-mark">م</div><div><b>مزاد السيارات</b><small style="color:#9fb4cc">منظومة الاستيراد والمزايدة</small></div></div>
      <div><h1>من ساحة المزاد في أمريكا<br>إلى المشتري في ليبيا — في شاشة واحدة</h1>
        <p>تتبع كل سيارة عبر الشحن والجمارك والنقل، تكاليف دقيقة لكل سيارة، ومزايدات حية مع ربط آلي بمنصتي Copart و IAAI.</p></div>
      <div class="feats">
        <div class="feat"><b>تتبع شامل</b>16 حالة لدورة حياة السيارة بقواعد انتقال صارمة</div>
        <div class="feat"><b>مزايدة حية</b>تحديث لحظي، مزايدة آلية، وحماية من القنص</div>
        <div class="feat"><b>تكلفة واصلة دقيقة</b>كل بند بعملته وسعر صرفه لحظة التسجيل</div>
        <div class="feat"><b>ربط آلي</b>مزامنة دورية مع معالجة الأخطاء وإعادة المحاولة</div>
      </div>
    </section>
    <section class="form-side"><form data-login novalidate>
      <h2 style="margin:0">تسجيل الدخول</h2>
      <label class="field">البريد الإلكتروني<input class="input" name="email" type="email" autocomplete="username" required></label>
      <label class="field">كلمة المرور<input class="input" name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary" style="min-height:44px">دخول</button>
      <div data-err role="alert" style="color:var(--danger);min-height:1.4em"></div>
      <div class="demo">حسابات تجريبية (كلمة المرور <span class="mono">Demo@2026pass</span>):<br>
        ${[['admin', 'مدير'], ['ops', 'عمليات'], ['accountant', 'محاسب'], ['sales', 'مبيعات'], ['bidder1', 'مزايد']].map(([e, l]) => html`<button type="button" data-demo="${e}@auction.ly">${l}</button> `)}</div>
    </form></section></div>`);
  const form = $('[data-login]');
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => { form.email.value = b.dataset.demo; form.password.value = 'Demo@2026pass'; form.requestSubmit(); }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('[data-err]').textContent = '';
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email: form.email.value.trim(), password: form.password.value } });
      state.user = user;
      await start();
    } catch (err) { $('[data-err]').textContent = err.message; }
  });
}

async function start() {
  state.meta = await api('/meta');
  shell();
  window.removeEventListener('hashchange', navigate);
  window.addEventListener('hashchange', navigate);
  navigate();
}

window.addEventListener('auth:expired', () => { toast('انتهت الجلسة — سجل الدخول مجددًا', 'err'); setTimeout(() => location.reload(), 1200); });

(async () => {
  try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* */ }
  try {
    state.user = (await api('/auth/me')).user;
    await start();
  } catch {
    loginScreen();
  }
})();
