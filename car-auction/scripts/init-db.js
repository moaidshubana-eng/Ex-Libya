// تهيئة قاعدة بيانات الإنتاج بأمان — يُشغَّل عند كل إقلاع:
//  1) إن لم يوجد المخطط: ينشئه من db/schema.sql (يتضمن الموانئ وبنود التكلفة والمصادر).
//     إن وُجد: لا يمس شيئًا أبدًا (على عكس apply-schema.js الذي يحذف).
//  2) إن لم يوجد أي مستخدم وضُبط INITIAL_ADMIN_EMAIL و INITIAL_ADMIN_PASSWORD: ينشئ أول مدير.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config.js';
import { hashPassword, passwordPolicyError } from '../src/security/crypto.js';

// قاعدة مُدارة قد تحتاج لحظات لتكون جاهزة عند أول إقلاع (أو تستيقظ من سبات Neon).
// عميل pg لا يُعاد استخدامه بعد فشل الاتصال، فننشئ عميلًا جديدًا في كل محاولة
let c;
for (let i = 1; ; i++) {
  c = new pg.Client({ connectionString: config.databaseUrl });
  try { await c.connect(); break; } catch (e) {
    await c.end().catch(() => {});
    if (i >= 10) { console.error('[init-db] تعذر الاتصال بقاعدة البيانات:', e.message); process.exit(1); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
try {
  const { rows } = await c.query(`SELECT to_regclass('auction.vehicles') AS t`);
  if (rows[0].t) {
    console.log('[init-db] المخطط موجود — لا تغيير');
  } else {
    await c.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    console.log('[init-db] أُنشئ المخطط');
  }
  // الهجرات: كل ملف في db/migrations يُطبَّق مرة واحدة بالترتيب داخل معاملة، ويُسجَّل في schema_migrations
  await c.query(`CREATE TABLE IF NOT EXISTS auction.schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = new URL('../db/migrations/', import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  const { rows: done } = await c.query('SELECT name FROM auction.schema_migrations');
  const applied = new Set(done.map((r) => r.name));
  for (const f of files.filter((x) => !applied.has(x))) {
    await c.query('BEGIN');
    try {
      await c.query(readFileSync(new URL(f, dir), 'utf8'));
      await c.query('INSERT INTO auction.schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log(`[init-db] طُبّقت الهجرة ${f}`);
    } catch (e) {
      await c.query('ROLLBACK');
      console.error(`[init-db] فشلت الهجرة ${f}: ${e.message}`);
      process.exit(1);
    }
  }
  const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM auction.users');
  const { email, password, name } = config.bootstrapAdmin;
  if (n === 0) {
    if (!email || !password) {
      console.warn('[init-db] لا مستخدمين! اضبط INITIAL_ADMIN_EMAIL و INITIAL_ADMIN_PASSWORD لإنشاء أول مدير.');
    } else {
      const bad = passwordPolicyError(password);
      if (bad) { console.error(`[init-db] كلمة مرور المدير الأول مرفوضة: ${bad}`); process.exit(1); }
      await c.query(`INSERT INTO auction.users (email, full_name, password_hash, role) VALUES ($1,$2,$3,'ADMIN')`, [email.toLowerCase(), name, await hashPassword(password)]);
      console.log(`[init-db] أُنشئ المدير الأول: ${email.toLowerCase()} — غيّر كلمة المرور بعد أول دخول واحذف INITIAL_ADMIN_PASSWORD من الإعدادات`);
    }
  }
} finally {
  await c.end();
}
