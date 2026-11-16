import { newVendorDialog, vendorTypeLabel } from './views-manage.js';
import { html, render, $, $$, api, fmt, LABELS, state, toast, modal, icon, localToday } from './core.js';

const ROLE_OPTS = ['ADMIN', 'OPERATIONS', 'ACCOUNTANT', 'SALES', 'VIEWER', 'BIDDER'];

/** وصف مقروء للجهاز من نص المتصفح: «Chrome على Windows» */
function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  return br && os ? `${br} على ${os}` : br || os || 'جهاز غير معروف';
}

export async function settingsView(el) {
  const isAdmin = state.user.role === 'ADMIN';
  const [fx, users, sec] = await Promise.all([api('/exchange-rates'), isAdmin ? api('/users') : { items: [] }, isAdmin ? api('/admin/security') : null]);
  const backupDays = sec?.last_backup_at ? Math.floor((Date.now() - new Date(sec.last_backup_at)) / 86_400_000) : null;
  const backupLate = sec && (backupDays === null || backupDays >= 7);
  const latest = {};
  for (const r of fx.items) if (!latest[r.currency]) latest[r.currency] = r;
  const today = localToday();
  const stale = (r) => !r || (Date.now() - new Date(r.effective_date)) > 3 * 86_400_000;

  render(el, html`
    <div class="card">
      <div class="card-h"><h2>أسعار الصرف</h2><span style="flex:1"></span>${state.user.role !== 'OPERATIONS' ? html`<button class="btn btn-accent btn-sm" data-fx>${icon('plus')} تسجيل سعر</button>` : ''}</div>
      <div class="card-b stack">
        <p class="muted" style="margin:0">كم دينارًا ليبيًا يقابل وحدة واحدة من العملة. يُؤخذ منه سعر كل تكلفة بتاريخها ويُحفظ معها. <b>سجّل سعر كل يوم عمل</b>، فبدون سعر في التاريخ لا تُقبل التكاليف بالدولار.</p>
        <div class="grid g3">${['USD', 'EUR'].map((c) => html`<div class="card card-b" style="box-shadow:none"><div class="faint">${c === 'USD' ? 'الدولار الأمريكي' : 'اليورو'}</div>
          <div class="num" style="font-size:26px;font-weight:700">${latest[c] ? Number(latest[c].rate_to_lyd).toFixed(4) : '—'}</div>
          <div class="${stale(latest[c]) ? 'neg' : 'faint'}">${latest[c] ? `بتاريخ ${fmt.date(latest[c].effective_date)}${stale(latest[c]) ? ' — قديم، حدّثه' : ''}` : 'لم يُسجَّل سعر بعد'}</div></div>`)}</div>
        <div class="table-wrap"><table class="t"><thead><tr><th>التاريخ</th><th>العملة</th><th class="n">السعر (د.ل)</th></tr></thead>
          <tbody>${fx.items.slice(0, 12).map((r) => html`<tr><td>${fmt.date(r.effective_date)}</td><td>${r.currency}</td><td class="n">${Number(r.rate_to_lyd).toFixed(4)}</td></tr>`)}</tbody></table></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>الموردون</h2><span style="flex:1"></span>${state.meta.vendors.length ? '' : html`<span class="faint">ابدأ بإضافة الخطوط الملاحية والمخلّصين</span>`}<button class="btn btn-accent btn-sm" data-newvendor>${icon('plus')} مورد جديد</button></div>
      <div class="card-b"><p class="muted" style="margin:0 0 10px">الجهات التي تتعامل معها: خطوط الشحن، وكلاء الشحن، المخلّصون، شركات النقل والسحب، الورش. تظهر في قوائم التكاليف والشحنات والجمارك.</p>
        <div class="chips">${state.meta.vendors.map((v) => html`<span class="chip">${v.name} <span class="faint">· ${vendorTypeLabel(v.vendor_type)}</span></span>`)}${state.meta.vendors.length ? '' : html`<span class="faint">لا موردين بعد</span>`}</div></div>
    </div>
    ${isAdmin ? html`<div class="card" style="margin-top:16px">
      <div class="card-h"><h2>المستخدمون</h2><span style="flex:1"></span><button class="btn btn-accent btn-sm" data-newuser>${icon('plus')} مستخدم جديد</button></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>الاسم</th><th>البريد</th><th>الدور</th><th>آخر دخول</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${users.items.map((u) => html`<tr><td><b>${u.full_name}</b>${u.customer_code ? html` <span class="faint">${u.customer_code}</span>` : ''}</td><td class="mono">${u.email}</td><td>${LABELS.role[u.role]}</td>
          <td>${u.last_login_at ? fmt.dt(u.last_login_at) : '—'}</td>
          <td>${u.is_active ? html`<span class="badge" style="color:var(--success)"><span class="dot"></span>فعّال</span>` : html`<span class="badge" style="color:var(--danger)"><span class="dot"></span>معطّل</span>`}</td>
          <td class="row"><button class="btn btn-sm" data-reset="${u.id}" data-name="${u.full_name}">كلمة مرور جديدة</button>
            ${u.id !== state.user.id ? html`<button class="btn btn-sm ${u.is_active ? 'btn-danger' : ''}" data-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'تعطيل' : 'تفعيل'}</button>` : ''}</td></tr>`)}</tbody></table></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>النسخ الاحتياطي</h2><span style="flex:1"></span><a class="btn btn-accent btn-sm" href="/api/admin/backup" download data-backup>${icon('download')} تنزيل نسخة كاملة</a></div>
      <div class="card-b stack">
        <p class="${backupLate ? 'neg' : 'muted'}" style="margin:0"><b>${backupDays === null ? 'لم تُنزَّل أي نسخة احتياطية بعد.' : backupDays === 0 ? 'آخر نسخة: اليوم.' : `آخر نسخة: منذ ${backupDays} يوم.`}</b>${backupLate ? ' نزّل نسخة الآن.' : ''}</p>
        <p class="muted" style="margin:0">ملف واحد مضغوط فيه كل شيء: السيارات، الحسابات، المصاريف، العُهد، وصور الفواتير. <b>نزّل نسخة كل أسبوع</b> واحفظها خارج هذا الجهاز (فلاشة أو Google Drive). لو ضاعت قاعدة البيانات تُسترجع منها المنظومة كاملة.</p>
        <p class="faint" style="margin:0">الملف فيه بيانات الشركة كلها، فلا ترسله لأحد ولا تتركه على جهاز مشترك.</p>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-h"><h2>الأجهزة الداخلة الآن</h2><span style="flex:1"></span>${sec.sessions.length > 1 ? html`<button class="btn btn-sm btn-danger" data-revoke-others>إخراج كل الأجهزة الأخرى</button>` : ''}</div>
      <div class="card-b" style="padding-bottom:0"><p class="muted" style="margin:0 0 10px">محاولات دخول فاشلة آخر 7 أيام: <b class="${sec.failed_logins_7d > 20 ? 'neg' : ''}">${sec.failed_logins_7d}</b>${sec.locked_users ? html` · حسابات مقفلة مؤقتًا: <b class="neg">${sec.locked_users}</b>` : ''} · <a href="#/audit">سجل التدقيق</a>. لو شفت جهازًا أو مكانًا ما تعرفاش، أخرجه وغيّر كلمة المرور.</p></div>
      <div class="table-wrap"><table class="t"><thead><tr><th>المستخدم</th><th>الجهاز</th><th>IP</th><th>دخل في</th><th></th></tr></thead>
        <tbody>${sec.sessions.map((s) => html`<tr><td><b>${s.full_name}</b> <span class="faint">${LABELS.role[s.role]}</span></td><td>${deviceLabel(s.user_agent)}</td><td class="mono faint">${s.ip || '—'}</td><td>${fmt.dt(s.created_at)}</td>
          <td>${s.current ? html`<span class="badge" style="color:var(--success)"><span class="dot"></span>هذا الجهاز</span>` : html`<button class="btn btn-sm btn-danger" data-revoke="${s.id}">إخراج</button>`}</td></tr>`)}</tbody></table></div>
    </div>` : ''}`);

  $('[data-backup]', el)?.addEventListener('click', () => { toast('بدأ تنزيل النسخة — احفظ الملف في مكان آمن', 'ok'); setTimeout(() => settingsView(el), 4000); });
  $('[data-revoke-others]', el)?.addEventListener('click', async () => {
    try { const r = await api('/admin/sessions/revoke-others', { method: 'POST', body: {} }); toast(`أُخرج ${r.revoked} جهاز`, 'ok'); settingsView(el); } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-revoke]', el).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/admin/sessions/${b.dataset.revoke}/revoke`, { method: 'POST', body: {} }); toast('أُخرج الجهاز', 'ok'); settingsView(el); } catch (e) { toast(e.message, 'err'); }
  }));

  $('[data-fx]', el)?.addEventListener('click', async () => {
    const r = await modal({ title: 'تسجيل سعر صرف', submitLabel: 'حفظ السعر', body: html`
      <div class="grid g3"><label class="field">العملة<select class="input" name="currency"><option>USD</option><option>EUR</option></select></label>
        <label class="field">السعر مقابل الدينار<input class="input num" name="rateToLyd" required inputmode="decimal" pattern="\\d+(\\.\\d{1,6})?" placeholder="5.5200"></label>
        <label class="field">اعتبارًا من<input class="input" type="date" name="effectiveDate" value="${today}" required></label></div>
      <p class="faint" style="margin:0">تسجيل سعر لنفس العملة والتاريخ يستبدل السابق. التكاليف المسجلة سابقًا لا تتغير.</p>` });
    if (!r) return;
    try { await api('/exchange-rates', { method: 'POST', body: r }); toast('تم حفظ السعر', 'ok'); settingsView(el); } catch (e) { toast(e.message, 'err'); }
  });

  $('[data-newvendor]', el).addEventListener('click', async () => { if (await newVendorDialog()) settingsView(el); });
  $('[data-newuser]', el)?.addEventListener('click', async () => {
    const r = await modal({ title: 'مستخدم جديد', submitLabel: 'إنشاء الحساب', body: html`
      <label class="field">الاسم الكامل<input class="input" name="fullName" required minlength="2"></label>
      <label class="field">البريد الإلكتروني (اسم الدخول)<input class="input" type="email" name="email" required autocomplete="off"></label>
      <div class="grid g2"><label class="field">الدور<select class="input" name="role">${ROLE_OPTS.map((x) => html`<option value="${x}" ${x === 'OPERATIONS' ? 'selected' : ''}>${LABELS.role[x]}</option>`)}</select></label>
        <label class="field">هاتف (للمزايد)<input class="input num" name="phone" autocomplete="off"></label></div>
      <label class="field">كلمة مرور مؤقتة<input class="input mono" name="password" required minlength="10" autocomplete="new-password"></label>
      <p class="faint" style="margin:0">10 أحرف على الأقل بحروف وأرقام. سلّمها للموظف وأخبره أن يغيّرها بعد أول دخول. المزايد يُنشأ له ملف عميل تلقائيًا، وتأمين المزاد يُعتمد من المبيعات.</p>` });
    if (!r) return;
    try {
      const body = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== ''));
      await api('/users', { method: 'POST', body }); toast('أُنشئ الحساب', 'ok'); settingsView(el);
    } catch (e) { toast(e.message, 'err'); }
  });

  $$('[data-reset]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = await modal({ title: `كلمة مرور جديدة — ${b.dataset.name}`, submitLabel: 'تعيين', body: html`<label class="field">كلمة المرور المؤقتة<input class="input mono" name="password" required minlength="10" autocomplete="new-password"></label><p class="faint" style="margin:0">تُنهى كل جلسات هذا المستخدم الحالية، ويُفك قفل حسابه إن كان مقفلًا.</p>` });
    if (!r) return;
    try { await api(`/users/${b.dataset.reset}`, { method: 'PATCH', body: { password: r.password } }); toast('تم تعيين كلمة المرور', 'ok'); } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-toggle]', el).forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/users/${b.dataset.toggle}`, { method: 'PATCH', body: { isActive: b.dataset.active !== 'true' } }); settingsView(el); } catch (e) { toast(e.message, 'err'); }
  }));
}

export async function changePasswordDialog() {
  const r = await modal({ title: 'تغيير كلمة المرور', submitLabel: 'تغيير', body: html`
    <label class="field">كلمة المرور الحالية<input class="input" type="password" name="current" required autocomplete="current-password"></label>
    <label class="field">كلمة المرور الجديدة<input class="input" type="password" name="next" required minlength="10" autocomplete="new-password"></label>
    <p class="faint" style="margin:0">10 أحرف على الأقل بحروف وأرقام. تُنهى جلساتك على الأجهزة الأخرى.</p>` });
  if (!r) return;
  try { await api('/auth/password', { method: 'POST', body: r }); toast('تم تغيير كلمة المرور', 'ok'); } catch (e) { toast(e.message, 'err'); }
}
