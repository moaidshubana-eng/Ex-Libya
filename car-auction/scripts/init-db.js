// تهيئة قاعدة بيانات الإنتاج بأمان — يُشغَّل عند كل إقلاع:
//  1) إن لم يوجد المخطط: ينشئه من db/schema.sql (يتضمن الموانئ وبنود التكلفة والمصادر).
//     إن وُجد: لا يمس شيئًا أبدًا (على عكس apply-schema.js الذي يحذف).
//  2) إن لم يوجد أي مستخدم وضُبط INITIAL_ADMIN_EMAIL و INITIAL_ADMIN_PASSWORD: ينشئ أول مدير.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config.js';
import { hashPassword, passwordPolicyError } from '../src/security/crypto.js';

const c = new pg.Client({ connectionString: config.databaseUrl });
// قاعدة مُدارة قد تحتاج لحظات لتكون جاهزة عند أول إقلاع
for (let i = 1; ; i++) {
  try { await c.connect(); break; } catch (e) {
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
