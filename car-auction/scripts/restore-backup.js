// استرجاع نسخة احتياطية نُزّلت من «الإعدادات ← النسخ الاحتياطي».
//   DATABASE_URL=<القاعدة الهدف> node scripts/restore-backup.js <ملف.ndjson.gz> [--yes]
// القاعدة الهدف يجب أن يكون مخططها موجودًا بنفس الهجرات (شغّل scripts/init-db.js عليها أولًا).
// يستبدل كل بيانات القاعدة الهدف بمحتوى الملف. إن كانت فيها بيانات يرفض حتى تضيف ‎--yes.
import { createReadStream, existsSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config.js';
import { restoreBackup } from '../src/services/backup.js';

const [file, ...flags] = process.argv.slice(2);
if (!file || !existsSync(file)) { console.error('الاستخدام: node scripts/restore-backup.js <ملف النسخة> [--yes]'); process.exit(2); }

const c = new pg.Client({ connectionString: config.databaseUrl, options: '-c search_path=auction,public' });
await c.connect();
try {
  const { rows: [{ n }] } = await c.query('SELECT (SELECT count(*) FROM auction.vehicles) + (SELECT count(*) FROM auction.company_expenses) + (SELECT count(*) FROM auction.customers) AS n');
  if (Number(n) > 0 && !flags.includes('--yes')) {
    console.error(`القاعدة الهدف فيها بيانات (${n} سجلًا) وستُستبدل كلها. أعد التشغيل مع ‎--yes إن كان هذا المقصود.`);
    process.exit(3);
  }
  const s = await restoreBackup(c, createReadStream(file));
  console.log(`[restore] تم: ${s.rows} صفًا في ${s.tables} جدولًا. الجلسات أُنهيت، فيلزم تسجيل الدخول من جديد.`);
} catch (e) {
  console.error('[restore] فشل ولم يتغير شيء:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
