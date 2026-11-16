// النسخة الاحتياطية الكاملة: كل جداول المنظومة في ملف واحد مضغوط (سطر JSON لكل صف).
// تُؤخذ داخل معاملة قراءة واحدة، فالملف لقطة متّسقة حتى لو كان أحد يُدخل بيانات أثناء التنزيل.
// الاسترجاع: scripts/restore-backup.js
import { createGzip, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { pool } from '../db.js';

export const BACKUP_FORMAT = 'ggm-backup';
export const BACKUP_VERSION = 1;
// الجلسات لا تُنسخ: رموز دخول مؤقتة لا قيمة لها بعد الاسترجاع، وتركها خارج الملف يقلل ما يُسرَّب لو وقع في يد غريبة
const SKIP_TABLES = ['user_sessions', 'portal_sessions', 'schema_migrations'];
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function write(stream, line) {
  if (!stream.write(line + '\n')) await once(stream, 'drain');
}

/** أسماء الهجرات المطبّقة (قاعدة أُنشئت من schema.sql مباشرة قد لا يكون فيها الجدول) */
async function appliedMigrations(c) {
  const { rows: [{ t }] } = await c.query(`SELECT to_regclass('auction.schema_migrations') AS t`);
  if (!t) return [];
  return (await c.query('SELECT name FROM auction.schema_migrations ORDER BY name')).rows.map((m) => m.name);
}

/** يكتب النسخة على مجرى (استجابة HTTP أو ملف). يعيد ملخصًا بعدد الصفوف */
export async function writeBackup(out) {
  const gz = createGzip({ level: 6 });
  gz.pipe(out);
  // لو انقطع التنزيل من جهة المتصفح نوقف الكتابة فورًا ولا نبقى ممسكين باتصال القاعدة
  out.on('close', () => { if (!gz.writableFinished) gz.destroy(new Error('انقطع تنزيل النسخة')); });
  const c = await pool.connect();
  const summary = { tables: 0, rows: 0 };
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migs = await appliedMigrations(c);
    const { rows: tables } = await c.query(
      `SELECT c.relname AS name, EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'bytea'::regtype) AS has_bytes
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'auction' AND c.relkind = 'r' AND c.relname <> ALL($1) ORDER BY c.relname`, [SKIP_TABLES]);
    await write(gz, JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, at: new Date().toISOString(), migrations: migs, tables: tables.map((t) => t.name) }));
    for (const t of tables) {
      // الصفوف تُجلب نصًّا جاهزًا من القاعدة وتُكتب كما هي. جداول الصور تُجلب صفوفًا قليلة في الدفعة حتى لا تمتلئ الذاكرة
      await c.query(`DECLARE bk NO SCROLL CURSOR FOR SELECT to_jsonb(x)::text AS j FROM auction.${ident(t.name)} x`);
      const size = t.has_bytes ? 4 : 500;
      for (;;) {
        const { rows } = await c.query(`FETCH ${size} FROM bk`);
        if (!rows.length) break;
        for (const r of rows) await write(gz, `{"t":${JSON.stringify(t.name)},"r":${r.j}}`);
        summary.rows += rows.length;
      }
      await c.query('CLOSE bk');
      summary.tables++;
    }
    const { rows: seqs } = await c.query(`SELECT sequencename AS name, last_value FROM pg_sequences WHERE schemaname = 'auction' ORDER BY 1`);
    for (const s of seqs) await write(gz, JSON.stringify({ seq: s.name, last: s.last_value == null ? null : String(s.last_value) }));
    await write(gz, JSON.stringify({ end: true, ...summary }));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    gz.destroy(e);
    throw e;
  } finally {
    c.release();
  }
  gz.end();
  await finished(out);
  return summary;
}

/**
 * يسترجع نسخة إلى قاعدة مخططها موجود (نفس الهجرات). يحذف محتوى الجداول المنسوخة ويضع مكانه محتوى الملف،
 * كله في معاملة واحدة: إما ينجح كاملًا أو لا يتغير شيء.
 */
export async function restoreBackup(c, input) {
  const lines = createInterface({ input: input.pipe(createGunzip()), crlfDelay: Infinity });
  const it = lines[Symbol.asyncIterator]();
  const first = await it.next();
  const head = first.done ? null : JSON.parse(first.value);
  if (!head || head.format !== BACKUP_FORMAT || head.version !== BACKUP_VERSION) throw new Error('الملف ليس نسخة احتياطية صالحة للمنظومة');
  const have = await appliedMigrations(c);
  if (JSON.stringify(have) !== JSON.stringify(head.migrations))
    throw new Error(`مخطط القاعدة لا يطابق النسخة. هجرات النسخة: ${head.migrations.at(-1) || '-'}، هجرات القاعدة: ${have.at(-1) || '-'}`);

  const summary = { tables: head.tables.length, rows: 0, complete: false };
  await c.query('BEGIN');
  try {
    // القيود المرجعية تُرفع أثناء التحميل ثم تُعاد كما هي، فلا يهم ترتيب الجداول ولا المراجع الدائرية
    const { rows: fks } = await c.query(
      `SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'auction' AND c.contype = 'f'`);
    for (const f of fks) await c.query(`ALTER TABLE ${f.tbl} DROP CONSTRAINT ${ident(f.conname)}`);
    const cols = {};
    for (const t of head.tables) {
      const { rows } = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'auction' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [t]);
      if (!rows.length) throw new Error(`جدول في النسخة غير موجود في القاعدة: ${t}`);
      cols[t] = rows.map((r) => ident(r.column_name)).join(', ');
      await c.query(`ALTER TABLE auction.${ident(t)} DISABLE TRIGGER USER`);
    }
    await c.query(`TRUNCATE ${head.tables.map((t) => `auction.${ident(t)}`).join(', ')}, auction.user_sessions, auction.portal_sessions`);
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      if (!n.value) continue;
      const o = JSON.parse(n.value);
      if (o.t) {
        if (!cols[o.t]) throw new Error(`صف لجدول غير معلن في رأس النسخة: ${o.t}`);
        await c.query(`INSERT INTO auction.${ident(o.t)} (${cols[o.t]}) SELECT ${cols[o.t]} FROM jsonb_populate_record(NULL::auction.${ident(o.t)}, $1::jsonb)`, [JSON.stringify(o.r)]);
        summary.rows++;
      } else if (o.seq) {
        if (o.last != null) await c.query('SELECT setval($1::regclass, $2::bigint, true)', [`auction.${ident(o.seq)}`, o.last]);
      } else if (o.end) {
        if (o.rows !== summary.rows) throw new Error(`النسخة ناقصة: فيها ${summary.rows} صفًا والمتوقع ${o.rows}`);
        summary.complete = true;
      }
    }
    if (!summary.complete) throw new Error('النسخة مبتورة (لم تصل نهايتها) — لم يُسترجع شيء');
    for (const t of head.tables) await c.query(`ALTER TABLE auction.${ident(t)} ENABLE TRIGGER USER`);
    for (const f of fks) await c.query(`ALTER TABLE ${f.tbl} ADD CONSTRAINT ${ident(f.conname)} ${f.def}`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
  return summary;
}
