import pg from 'pg';
import { config } from './config.js';

// NUMERIC يعود نصًا (لا Number) للحفاظ على الدقة المالية — هذا سلوك pg الافتراضي ونُبقيه.
// BIGINT (عدادات count/bigserial) نحوله إلى Number لأنه آمن في نطاقاتنا.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  options: '-c search_path=auction,public',
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export function query(text, params) {
  return pool.query(text, params);
}

/**
 * تنفيذ دالة داخل معاملة. تُعاد المحاولة تلقائيًا عند تعارض التسلسل
 * (serialization_failure / deadlock_detected) حتى 3 مرات.
 */
export async function tx(fn, { retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt < retries && (err.code === '40001' || err.code === '40P01')) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function audit(client, { actorId, action, entity, entityId, before, after, ip }) {
  await (client || pool).query(
    `INSERT INTO audit_logs (actor_id, action, entity, entity_id, before_data, after_data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorId || null, action, entity, entityId ? String(entityId) : null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip || null],
  );
}
