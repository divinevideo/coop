/* eslint-disable functional/immutable-data -- Each test owns its temporary database and connection cleanup. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { memberIntentTestDatabaseUrl } from '../../../test/memberIntentTestDatabase.js';
import { type ManualReviewToolServicePg } from '../dbTypes.js';
import ManualReviewToolSettings from './ManualReviewToolSettings.js';

const databaseName = `coop_settings_test_${randomUUID().replaceAll('-', '')}`;
let db: Kysely<ManualReviewToolServicePg>;
let cleanup = async () => {};
let settings: ManualReviewToolSettings;

beforeAll(async () => {
  const url = memberIntentTestDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  db = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString() }),
    }),
  });
  cleanup = async () => {
    await db.destroy();
    await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  };
  const initial = await readFile(
    '../db/src/scripts/api-server-pg/2025.12.01T00.00.00.initial-schema.sql',
    'utf8',
  );
  const table = initial.match(
    /CREATE TABLE manual_review_tool.manual_review_tool_settings \([\s\S]*?\n\);/,
  )?.[0];
  if (!table) throw new Error('Initial settings schema not found');
  await sql
    .raw(
      `CREATE SCHEMA manual_review_tool; ${table} ALTER TABLE manual_review_tool.manual_review_tool_settings ADD PRIMARY KEY(org_id);`,
    )
    .execute(db);
  await sql`INSERT INTO manual_review_tool.manual_review_tool_settings (org_id, mrt_requires_decision_reason, requires_policy_for_decisions, ignore_callback_url) VALUES ('existing', true, true, 'https://callback.example/ignore')`.execute(
    db,
  );
  await sql
    .raw(
      await readFile(
        '../db/src/scripts/api-server-pg/2026.06.15T12.00.00.split_mrt_requires_decision_reason.sql',
        'utf8',
      ),
    )
    .execute(db);
  settings = new ManualReviewToolSettings(db);
});
afterAll(async () => cleanup());

test('upgraded settings preserve both reason flags and existing ordinary settings', async () => {
  expect(await settings.getRequiresDecisionReason('existing')).toBe(true);
  expect(await settings.getRequiresDecisionReasonOnIgnore('existing')).toBe(
    true,
  );
  await settings.upsertDefaultSettings({ orgId: 'existing' });
  expect(await settings.getRequiresPolicyForDecisions('existing')).toBe(true);
  expect(await settings.getIgnoreCallbackUrl('existing')).toBe(
    'https://callback.example/ignore',
  );
  expect(await settings.getRequiresDecisionReason('existing')).toBe(true);
  expect(await settings.getRequiresDecisionReasonOnIgnore('existing')).toBe(
    true,
  );
  await settings.updateRequiresDecisionReason('existing', false);
  expect(await settings.getRequiresDecisionReason('existing')).toBe(false);
  expect(await settings.getRequiresDecisionReasonOnIgnore('existing')).toBe(
    true,
  );
});

test('fresh org defaults and independent writes use the1.0.2 columns', async () => {
  await settings.upsertDefaultSettings({ orgId: 'fresh' });
  expect(await settings.getRequiresDecisionReason('fresh')).toBe(false);
  expect(await settings.getRequiresDecisionReasonOnIgnore('fresh')).toBe(false);
  await settings.updateRequiresDecisionReasonOnIgnore('fresh', true);
  expect(await settings.getRequiresDecisionReason('fresh')).toBe(false);
  expect(await settings.getRequiresDecisionReasonOnIgnore('fresh')).toBe(true);
});

test('upsert of an organization without a settings row preserves independently written fields', async () => {
  await settings.updateRequiresDecisionReason('missing', true);
  await settings.updateRequiresDecisionReasonOnIgnore('missing', true);
  await settings.updateRequiresDecisionReason('missing', false);
  expect(await settings.getRequiresDecisionReason('missing')).toBe(false);
  expect(await settings.getRequiresDecisionReasonOnIgnore('missing')).toBe(
    true,
  );
});
