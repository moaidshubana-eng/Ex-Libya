// يطبّق db/schema.sql (يسقط مخطط auction ويعيد بناءه) — للتطوير والاختبار فقط
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config.js';

const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();
await client.query(sql);
await client.end();
console.log('schema applied');
