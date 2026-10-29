/** Run in the migrator image against an owned, fully migrated acceptance DB.
 * Verifies the installed forward data migration never resets an existing cursor.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

assert.match(
  process.env.API_SERVER_DATABASE_NAME ?? '',
  /^coop_task2_(upgrade|fresh)$/,
);
const require = createRequire('/app/db/package.json');
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.API_SERVER_DATABASE_HOST,
  port: Number(process.env.API_SERVER_DATABASE_PORT),
  database: process.env.API_SERVER_DATABASE_NAME,
  user: process.env.API_SERVER_DATABASE_USER,
  password: process.env.API_SERVER_DATABASE_PASSWORD,
});
try {
  const table = 'manual_review_tool.dim_mrt_decisions_materialized';
  const before = await pool.query(
    'SELECT last_insert::text AS watermark FROM public.view_maintenance_metadata WHERE table_name=$1',
    [table],
  );
  assert.equal(before.rows.length, 1);
  assert.equal(before.rows[0].watermark, '-infinity');
  await pool.query(
    'UPDATE public.view_maintenance_metadata SET last_insert=$1 WHERE table_name=$2',
    ['2020-01-02 03:04:05', table],
  );
  const migration = await readFile(
    '/app/db/build/scripts/api-server-pg/2026.10.21T04.34.29.bootstrap_mrt_view_maintenance.sql',
    'utf8',
  );
  await pool.query(migration);
  await pool.query(migration);
  const after = await pool.query(
    'SELECT last_insert::text AS watermark FROM public.view_maintenance_metadata WHERE table_name=$1',
    [table],
  );
  assert.deepEqual(after.rows, [{ watermark: '2020-01-02 03:04:05' }]);
  console.log(
    'PASS installed forward data migration: existing nondefault watermark preserved on two reapplications; no duplicate row',
  );
} finally {
  await pool.end();
}
