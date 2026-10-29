import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Queue } from 'bullmq';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { memberIntentTestDatabaseUrl } from '../../test/memberIntentTestDatabase.js';
import { roomDecisionSettings } from '../../test/roomDecisionSettings.js';
import {
  getPermissionsForRole,
  UserRole,
} from '../userManagementService/index.js';
import { type ManualReviewToolServicePg } from './dbTypes.js';
import { ManualReviewToolService } from './manualReviewToolService.js';
import JobDecisioning from './modules/JobDecisioning.js';
import QueueOperations, {
  jobIdToGuid,
  parseExternalId,
} from './modules/QueueOperations.js';

const databaseName = `coop_ordinary_appeals_${randomUUID().replaceAll('-', '')}`;
const orgId = 'synthetic';
const connection = {
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT),
};
let database: Kysely<ManualReviewToolServicePg>;
let cleanup = async () => {};

beforeAll(async () => {
  const url = memberIntentTestDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url.toString() });
  cleanup = async () => {
    await admin.end();
  };
  await admin.query(`CREATE DATABASE ${databaseName}`);
  database = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: new URL(`/${databaseName}`, url).toString(),
      }),
    }),
  });
  cleanup = async () => {
    await database.destroy();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  };
  await sql`CREATE TABLE public.orgs (id varchar(255) PRIMARY KEY);
    INSERT INTO public.orgs VALUES ('synthetic');
    CREATE SCHEMA manual_review_tool;
    CREATE TABLE manual_review_tool.manual_review_queues (
      id text PRIMARY KEY, org_id text, name text, description text,
      created_at timestamptz DEFAULT now(), is_default_queue boolean DEFAULT false,
      is_appeals_queue boolean, auto_close_jobs boolean,
      clear_reports_disposition text, clear_reports_scope text DEFAULT 'CURRENT_QUEUE'
    );
    CREATE TABLE manual_review_tool.manual_review_decisions (
      id uuid PRIMARY KEY, job_payload jsonb, queue_id text, reviewer_id text,
      org_id text, decision_components jsonb[], related_actions jsonb[],
      enqueue_source_info jsonb, item_created_at timestamptz,
      decision_reason text, created_at timestamptz DEFAULT now()
    )`.execute(database);
  for (const path of [
    '../db/src/scripts/api-server-pg/2026.10.18T00.00.00.add_member_intent_order.sql',
    '../db/src/scripts/api-server-pg/2026.10.19T00.14.35.add_room_operation_lifecycle.sql',
    '../db/src/scripts/api-server-pg/2026.10.19T01.38.51.add_room_execution_acceptances.sql',
  ])
    await sql.raw(await readFile(path, 'utf8')).execute(database);
});

afterAll(async () => {
  await cleanup();
});

async function fixture(autoCloseJobs: boolean, deleted: boolean) {
  const queueId = `ordinary-appeals-${randomUUID()}`;
  await sql`INSERT INTO manual_review_tool.manual_review_queues
    (id, org_id, name, is_appeals_queue, auto_close_jobs)
    VALUES (${queueId}, ${orgId}, 'Ordinary appeals', true, ${autoCloseJobs})`.execute(
    database,
  );
  const queue = new Queue(queueId, { connection, prefix: `{${orgId}}` });
  const config = { getItemType: async () => undefined };
  const queueOps = new QueueOperations(
    database,
    database,
    config as never,
    connection as never,
  );
  const appealItem = {
    itemId: randomUUID(),
    itemTypeIdentifier: { id: 'ordinary-content' },
    submissionId: randomUUID(),
    data: {},
  };
  const job = await queueOps.addAppealJob({
    orgId,
    queueId,
    jobPayload: {
      policyIds: [],
      payload: {
        kind: 'APPEAL',
        appealId: randomUUID(),
        appealReason: 'Please review the original decision',
        item: appealItem as never,
      },
    },
    enqueueSourceInfo: { kind: 'APPEAL' },
  });
  const onRecordDecision = jest.fn(async () => {});
  const getCustomActions = Object.assign(
    async () => [{ id: 'room-remove', name: 'concord_remove_message' }],
    { close: async () => {} },
  );
  const jobDecisioning = new JobDecisioning(
    queueOps,
    database,
    getCustomActions as never,
    onRecordDecision,
    config as never,
    {} as never,
    roomDecisionSettings() as never,
    async () => ({
      id: 'staff',
      orgId,
      role: UserRole.ADMIN,
      approvedByAdmin: true,
      rejectedByAdmin: false,
      getPermissions: () => getPermissionsForRole(UserRole.ADMIN),
    }),
  );
  const getPartialItem = jest.fn(async () => ({
    itemType: {
      schema: [
        {
          name: 'is_deleted',
          type: 'BOOLEAN',
          required: false,
          container: null,
        },
      ],
      schemaFieldRoles: { isDeleted: 'is_deleted' },
    },
    data: { is_deleted: deleted },
  }));
  // Use the public service methods and real queue/decisioning implementations.
  // Avoid unrelated constructor services; only configuration and transport are synthetic.
  const service = Object.assign(
    Object.create(ManualReviewToolService.prototype),
    { queueOps, jobDecisioning, partialItemsService: { getPartialItem } },
  ) as ManualReviewToolService;
  const dequeue = async () =>
    service.dequeueNextJob({ orgId, queueId, userId: 'staff' });
  const decisions = async () =>
    database
      .selectFrom('manual_review_tool.manual_review_decisions')
      .selectAll()
      .where('id', '=', jobIdToGuid(job.id))
      .execute();
  return {
    job,
    queue,
    dequeue,
    decisions,
    service,
    queueId,
    getPartialItem,
    onRecordDecision,
    close: async () => {
      await queueOps.close();
      await queue.obliterate({ force: true });
      await queue.close();
    },
  };
}

test.each([false, true])(
  'ordinary APPEAL retains typed payload and submits with auto-close disabled; deleted=%s',
  async (deleted) => {
    const f = await fixture(false, deleted);
    try {
      const next = await f.dequeue();
      expect(next?.job.id).toBe(f.job.id);
      expect(next?.job.payload).toEqual(f.job.payload);
      expect(f.getPartialItem).not.toHaveBeenCalled();
      await f.service.submitDecision({
        orgId,
        queueId: f.queueId,
        jobId: f.job.id,
        lockToken: 'staff',
        reviewerId: 'staff',
        reviewerEmail: 'staff@example.invalid',
        reportHistory: [],
        decisionComponents: [
          { type: 'ACCEPT_APPEAL', appealId: f.job.payload.appealId },
        ],
        relatedActions: [],
        decisionReason: 'Original action overturned',
      });
      const [decision] = await f.decisions();
      expect(decision.job_payload.payload).toEqual(f.job.payload);
      expect(decision.decision_components).toEqual([
        { type: 'ACCEPT_APPEAL', appealId: f.job.payload.appealId },
      ]);
      expect(f.onRecordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ payload: f.job.payload }),
        }),
      );
      expect(
        await f.queue.getJob(parseExternalId(f.job.id).bullId),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])(
  'ordinary APPEAL honors configured auto-close; deleted=%s',
  async (deleted) => {
    const f = await fixture(true, deleted);
    try {
      const next = await f.dequeue();
      expect(f.getPartialItem).toHaveBeenCalledTimes(1);
      if (deleted) {
        expect(next).toBeNull();
        const [decision] = await f.decisions();
        expect(decision.job_payload.payload).toEqual(f.job.payload);
        expect(decision.decision_components).toEqual([
          { type: 'AUTOMATIC_CLOSE', reason: 'ITEM_DELETED_BEFORE_REVIEW' },
        ]);
        expect(
          await f.queue.getJob(parseExternalId(f.job.id).bullId),
        ).toBeUndefined();
      } else {
        expect(next?.job.payload).toEqual(f.job.payload);
        expect(await f.decisions()).toEqual([]);
        expect(
          await f.queue.getJob(parseExternalId(f.job.id).bullId),
        ).toBeDefined();
      }
      expect(f.onRecordDecision).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

test('pending recorded room recovery precedes appeal auto-close even when the item is deleted', async () => {
  const f = await fixture(true, true);
  try {
    const decisionComponents = [
      {
        type: 'CUSTOM_ACTION' as const,
        actions: [{ id: 'room-remove' }],
        policies: [],
        itemIds: [f.job.payload.item.itemId],
        itemTypeId: f.job.payload.item.itemTypeIdentifier.id,
      },
    ];
    await database
      .insertInto('manual_review_tool.manual_review_decisions')
      .values({
        id: jobIdToGuid(f.job.id),
        org_id: orgId,
        queue_id: f.queueId,
        reviewer_id: 'staff',
        job_payload: { ...f.job, roomDeliveryRequired: true },
        decision_components: decisionComponents,
        related_actions: [],
        decision_reason: 'Original recorded room decision',
      } as never)
      .execute();
    f.onRecordDecision.mockRejectedValue(
      new Error('Synthetic delivery pending'),
    );
    expect((await f.dequeue())?.job.id).toBe(f.job.id);
    expect(f.getPartialItem).not.toHaveBeenCalled();
    expect(f.onRecordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionComponents,
        decisionReason: 'Original recorded room decision',
        roomDeliveryRequired: true,
      }),
    );
    expect((await f.decisions())[0].decision_components).toEqual(
      decisionComponents,
    );
    expect(
      await f.queue.getJob(parseExternalId(f.job.id).bullId),
    ).toBeDefined();
  } finally {
    await f.close();
  }
});
