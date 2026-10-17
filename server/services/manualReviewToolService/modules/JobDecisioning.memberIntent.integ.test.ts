import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { UserRole } from '../../../models/types/permissioning.js';
import { prepareMemberIntent } from '../../../routes/concord/memberIntents.js';
import { type ManualReviewToolServicePg } from '../dbTypes.js';
import JobDecisioning from './JobDecisioning.js';

const databaseName = `coop_ordering_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let pgQuery: Kysely<ManualReviewToolServicePg>;
const config = {
  origin: 'https://moderation.example',
  orgId: 'synthetic',
  hmacKey: 'ab'.repeat(32),
  coopOrigin: 'https://coop.example',
  accessIssuer: 'https://test.cloudflareaccess.com',
  accessAudience: 'test',
  queueId: 'queue',
};
const getActor = async () => ({
  id: 'staff',
  orgId: 'synthetic',
  role: UserRole.ADMIN,
  approvedByAdmin: true,
  rejectedByAdmin: false,
});
beforeAll(async () => {
  const value = process.env.MEMBER_INTENT_TEST_DATABASE_URL;
  if (!value)
    throw new Error(
      'Dedicated loopback MEMBER_INTENT_TEST_DATABASE_URL required',
    );
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Loopback test database required');
  admin = new pg.Pool({ connectionString: value });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const databaseUrl = new URL(`/${databaseName}`, url);
  pgQuery = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: databaseUrl.toString() }),
    }),
  });
  await sql`CREATE TABLE public.orgs (id varchar(255) PRIMARY KEY); INSERT INTO public.orgs VALUES ('synthetic'); CREATE SCHEMA manual_review_tool; CREATE TABLE manual_review_tool.manual_review_decisions (id uuid PRIMARY KEY, job_payload jsonb, queue_id text, reviewer_id text, org_id text, decision_components jsonb[], related_actions jsonb[], enqueue_source_info jsonb, item_created_at timestamptz, decision_reason text, created_at timestamptz DEFAULT now())`.execute(
    pgQuery,
  );
  await sql
    .raw(
      await readFile(
        new URL(
          '../../../../db/src/scripts/api-server-pg/2026.10.18T00.00.00.add_member_intent_order.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    .execute(pgQuery);
});
afterAll(async () => {
  await pgQuery?.destroy();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});
beforeEach(async () => {
  await sql`TRUNCATE manual_review_tool.manual_review_decisions, concord_integration.member_intent_heads, concord_integration.member_intents, concord_integration.member_intent_quarantine`.execute(
    pgQuery,
  );
});
test.each([false, true])(
  'MRT immutable audit and normalized member intent commit together; registration failure rolls both back: %s',
  async (failRegistration) => {
    const guid = randomUUID();
    const caseId = randomUUID();
    const job = {
      id: `aXRlbQ:${Buffer.from(guid).toString('base64url')}`,
      orgId: 'synthetic',
      payload: {
        kind: 'DEFAULT',
        item: {
          itemId: 'case',
          itemTypeIdentifier: { id: 'room-type' },
          data: { case_id: caseId },
        },
      },
    };
    const removeJob = jest.fn(async () => {});
    const onRecord = jest.fn(async () => {
      expect(
        await pgQuery
          .selectFrom('concord_integration.member_intents')
          .selectAll()
          .execute(),
      ).toHaveLength(1);
      throw new Error('Synthetic post-commit delivery loss');
    });
    const service = new JobDecisioning(
      { getJobs: async () => [job], removeJob } as never,
      pgQuery,
      Object.assign(
        async () => [{ id: 'action', name: 'concord_ban_member' }],
        { close: async () => {} },
      ) as never,
      onRecord,
      { getItemType: async () => undefined } as never,
      {} as never,
      getActor,
      async () => {
        const prepared = await prepareMemberIntent(
          config,
          {
            getActor,
            fetchHTTP: async () => ({
              ok: true,
              status: 200,
              body: {
                caseId,
                author: 'd'.repeat(64),
                target: {
                  communityId: 'a'.repeat(64),
                  channelId: 'b'.repeat(64),
                  rumorId: 'c'.repeat(64),
                },
              },
            }),
          },
          {
            orgId: 'synthetic',
            actionId: 'action',
            actionName: 'concord_ban_member',
            itemId: 'case',
            itemTypeId: 'room-type',
            itemTypeName: 'concord_member',
            caseId,
            actorId: 'staff',
            note: 'Original synthetic reason',
            correlationId: `mrt-decision:${job.id}`,
            parameters: {},
          },
        );
        return failRegistration ? [prepared, prepared] : [prepared];
      },
    );
    await expect(
      service.submitDecision({
        queueId: 'queue',
        orgId: 'synthetic',
        jobId: job.id,
        lockToken: 'lock',
        reviewerId: 'staff',
        reviewerEmail: 'staff@example.invalid',
        decisionReason: 'Original synthetic reason',
        reportHistory: [],
        relatedActions: [],
        decisionComponents: [
          {
            type: 'CUSTOM_ACTION',
            actions: [{ id: 'action' }],
            policies: [],
            itemIds: ['case'],
            itemTypeId: 'room-type',
          },
        ],
      } as never),
    ).rejects.toThrow();
    expect(
      await pgQuery
        .selectFrom('manual_review_tool.manual_review_decisions')
        .selectAll()
        .execute(),
    ).toHaveLength(failRegistration ? 0 : 1);
    expect(
      await pgQuery
        .selectFrom('concord_integration.member_intents')
        .selectAll()
        .execute(),
    ).toHaveLength(failRegistration ? 0 : 1);
    expect(removeJob).not.toHaveBeenCalled();
    expect(onRecord).toHaveBeenCalledTimes(failRegistration ? 0 : 1);
  },
);
