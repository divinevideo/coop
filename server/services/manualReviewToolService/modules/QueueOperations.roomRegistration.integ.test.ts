/* eslint-disable functional/immutable-data -- Owned async barriers and service resources model concurrent requests. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Queue, Worker } from 'bullmq';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { type MemberIntentPg } from '../../../routes/concord/memberIntentTypes.js';
import { stopRoomAutomation } from '../../../routes/concord/roomDispositions.js';
import { recordRoomRemovalAcceptance } from '../../../routes/concord/roomRemovalDelivery.js';
import {
  roomExecutionId,
  type RoomDecisionInput,
  type RoomStatus,
} from '../../../routes/concord/service.js';
import {
  duplicateRoomTargetCases,
  duplicateRoomTargetFixture,
} from '../../../test/duplicateRoomTargetFixtures.js';
import { memberIntentTestDatabaseUrl } from '../../../test/memberIntentTestDatabase.js';
import { roomDecisionSettings } from '../../../test/roomDecisionSettings.js';
import {
  getPermissionsForRole,
  UserPermission,
  UserRole,
} from '../../userManagementService/index.js';
import { type ManualReviewToolServicePg } from '../dbTypes.js';
import JobDecisioning from './JobDecisioning.js';
import QueueOperations from './QueueOperations.js';

function barrier() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const databaseName = `coop_queue_race_${randomUUID().replaceAll('-', '')}`;
let database: Kysely<ManualReviewToolServicePg>;
let cleanup = async () => {};
const connection = {
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT),
};
const paths = [
  'direct',
  'same-invoker',
  'completion',
  'purge',
  'delete',
] as const;
type RemovalPath = (typeof paths)[number];

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
  await sql`CREATE TABLE public.orgs (id varchar(255) PRIMARY KEY); INSERT INTO public.orgs VALUES ('synthetic'); CREATE SCHEMA manual_review_tool; CREATE TABLE manual_review_tool.manual_review_decisions (id uuid PRIMARY KEY, job_payload jsonb, queue_id text, reviewer_id text, org_id text, decision_components jsonb[], related_actions jsonb[], enqueue_source_info jsonb, item_created_at timestamptz, decision_reason text, created_at timestamptz DEFAULT now()); CREATE TABLE manual_review_tool.manual_review_queues (id text PRIMARY KEY, org_id text, is_default_queue boolean NOT NULL DEFAULT false, is_appeals_queue boolean NOT NULL DEFAULT false); INSERT INTO manual_review_tool.manual_review_queues (id, org_id, is_default_queue) VALUES ('default-test-queue', 'synthetic', true); CREATE TABLE manual_review_tool.users_and_accessible_queues (queue_id text, user_id text)`.execute(
    database,
  );
  const migrations = await Promise.all([
    readFile(
      '../db/src/scripts/api-server-pg/2026.10.18T00.00.00.add_member_intent_order.sql',
      'utf8',
    ),
    readFile(
      '../db/src/scripts/api-server-pg/2026.10.19T00.14.35.add_room_operation_lifecycle.sql',
      'utf8',
    ),
    readFile(
      '../db/src/scripts/api-server-pg/2026.10.19T01.38.51.add_room_execution_acceptances.sql',
      'utf8',
    ),
  ]);
  for (const migration of migrations)
    await sql.raw(migration).execute(database);
});
afterAll(async () => {
  await cleanup();
});

async function fixture(path: RemovalPath, isAppealsQueue = false) {
  const guid = randomUUID();
  const queueId = `race-${guid}`;
  await sql`INSERT INTO manual_review_tool.manual_review_queues (id, org_id) VALUES (${queueId}, 'synthetic')`.execute(
    database,
  );
  const prefix = `test-f1-${guid}`;
  const queue = new Queue(queueId, { connection, prefix });
  const job = {
    id: `${Buffer.from(guid).toString('base64url')}:${Buffer.from(guid).toString('base64url')}`,
    orgId: 'synthetic',
    payload: {
      kind: 'DEFAULT',
      item: {
        itemId: 'case',
        itemTypeIdentifier: { id: 'room-type' },
        data: { case_id: randomUUID() },
      },
    },
  };
  await queue.add('review', job, { jobId: guid, removeOnComplete: true });
  const worker = new Worker(queueId, undefined, {
    connection,
    prefix,
    autorun: false,
  });
  if (path === 'same-invoker' || path === 'completion') {
    expect(await worker.getNextJob('staff')).toBeTruthy();
  }
  const ops = new QueueOperations(database, database, {} as never, {} as never);
  let paused:
    | {
        entered: ReturnType<typeof barrier>;
        resume: ReturnType<typeof barrier>;
      }
    | undefined;
  // Keep real SQL and real BullMQ operations, injecting only the producer boundary.
  const producer = async () => {
    const current = paused;
    paused = undefined;
    if (current) {
      current.entered.release();
      await current.resume.wait;
    }
    return queue;
  };
  Object.assign(ops, {
    getOrCreateBullQueue: isAppealsQueue
      ? async () => {
          throw new Error('Wrong ordinary queue');
        }
      : producer,
    getOrCreateBullAppealQueue: producer,
  });
  jest.spyOn(ops, 'checkQueueExists').mockResolvedValue(undefined);
  // Model a submission that already loaded its immutable job before removal.
  jest.spyOn(ops, 'getJobs').mockResolvedValue([job] as never);
  jest.spyOn(ops, 'getAppealJobs').mockResolvedValue([job] as never);
  const delivery = jest.fn(async () => {
    throw new Error('Synthetic acceptance pending');
  });
  let prepared:
    | {
        entered: ReturnType<typeof barrier>;
        resume: ReturnType<typeof barrier>;
      }
    | undefined;
  const service = new JobDecisioning(
    ops,
    database,
    Object.assign(
      async () => [{ id: 'remove', name: 'concord_remove_message' }],
      { close: async () => {} },
    ) as never,
    delivery,
    { getItemType: async () => undefined } as never,
    {} as never,
    roomDecisionSettings() as never,
    async () => ({
      id: 'staff',
      orgId: 'synthetic',
      role: UserRole.ADMIN,
      approvedByAdmin: true,
      rejectedByAdmin: false,
      getPermissions() {
        return getPermissionsForRole(UserRole.ADMIN);
      },
    }),
    async () => {
      if (prepared) {
        prepared.entered.release();
        await prepared.resume.wait;
      }
      return [];
    },
  );
  const submit = async () =>
    service.submitDecision({
      queueId,
      orgId: 'synthetic',
      jobId: job.id,
      lockToken: 'staff',
      reviewerId: 'staff',
      reviewerEmail: 'staff@example.invalid',
      isAppealsQueue,
      decisionReason: 'Synthetic room moderation reason',
      reportHistory: [],
      relatedActions: [],
      decisionComponents: [
        {
          type: 'CUSTOM_ACTION',
          actions: [{ id: 'remove' }],
          policies: [],
          itemIds: ['case'],
          itemTypeId: 'room-type',
        },
      ],
    } as never);
  const remove = async () =>
    path === 'delete'
      ? ops.deleteManualReviewQueue('synthetic', queueId)
      : path === 'purge'
        ? ops.deleteAllJobsFromQueue({
            orgId: 'synthetic',
            queueId,
            userPermissions: [UserPermission.MANAGE_ORG],
          })
        : path === 'completion'
          ? ops.removeJob({
              orgId: 'synthetic',
              queueId,
              jobId: job.id as never,
              lockToken: 'staff',
            })
          : ops.removeJobAllowingInvokerLock({
              orgId: 'synthetic',
              queueId,
              jobId: job.id as never,
              invokerUserId: 'staff',
            });
  const hold = () => {
    const gate = { entered: barrier(), resume: barrier() };
    paused = gate;
    return gate;
  };
  return {
    submit,
    remove,
    ops,
    delivery,
    queue,
    guid,
    job,
    hold,
    holdPreparation: () => {
      prepared = { entered: barrier(), resume: barrier() };
      return prepared;
    },
    recorded: async () =>
      database
        .selectFrom('manual_review_tool.manual_review_decisions')
        .selectAll()
        .where('id', '=', guid)
        .execute(),
    exists: async () => Boolean(await queue.getJob(guid)),
    close: async () => {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    },
  };
}

test.each(paths)(
  'registration holds exclusion against %s and preserves pending recovery',
  async (path) => {
    const f = await fixture(path);
    const gate = f.hold();
    const submission = f.submit().catch((error: unknown) => error);
    try {
      await gate.entered.wait;
      if (path === 'direct' || path === 'same-invoker')
        await expect(f.remove()).resolves.toBe(false);
      else await expect(f.remove()).rejects.toThrow('mutation in progress');
      expect(await f.exists()).toBe(true);
      expect(await f.recorded()).toHaveLength(0);
      gate.resume.release();
      expect(await submission).toBeInstanceOf(Error);
      expect(await f.recorded()).toHaveLength(1);
      expect(f.delivery).toHaveBeenCalledTimes(1);
      if (path === 'direct' || path === 'same-invoker')
        expect(await f.remove()).toBe(false);
      else await expect(f.remove()).rejects.toThrow('Room');
      expect(await f.exists()).toBe(true);
    } finally {
      gate.resume.release();
      await submission;
      await f.close();
    }
  },
);

test.each(paths)(
  '%s holds exclusion against stale submission; post-delete retry cannot record or deliver',
  async (path) => {
    const f = await fixture(path);
    const gate = f.hold();
    const removal = f.remove();
    try {
      await gate.entered.wait;
      await expect(f.submit()).rejects.toThrow();
      expect(await f.recorded()).toHaveLength(0);
      expect(f.delivery).not.toHaveBeenCalled();
      gate.resume.release();
      await removal;
      expect(await f.exists()).toBe(false);
      await expect(f.submit()).rejects.toThrow();
      expect(await f.recorded()).toHaveLength(0);
      expect(f.delivery).not.toHaveBeenCalled();
    } finally {
      gate.resume.release();
      await removal;
      await f.close();
    }
  },
);

test.each(paths)(
  'prepared but unrecorded submission cannot survive a completed %s',
  async (path) => {
    const f = await fixture(path);
    const gate = f.holdPreparation();
    const submission = f.submit().catch((error: unknown) => error);
    try {
      await gate.entered.wait;
      await f.remove();
      expect(await f.exists()).toBe(false);
      gate.resume.release();
      expect(await submission).toBeInstanceOf(Error);
      expect(await f.recorded()).toHaveLength(0);
      expect(f.delivery).not.toHaveBeenCalled();
    } finally {
      gate.resume.release();
      await submission;
      await f.close();
    }
  },
);

test('appeal registration revalidates the exact appeal job rather than the ordinary queue', async () => {
  const f = await fixture('direct', true);
  try {
    await expect(f.submit()).rejects.toThrow('Synthetic acceptance pending');
    expect(await f.recorded()).toHaveLength(1);
    expect(f.delivery).toHaveBeenCalledTimes(1);
    expect(await f.exists()).toBe(true);
  } finally {
    await f.close();
  }
});

test.each(
  (['direct', 'same-invoker', 'completion'] as const).flatMap((path) =>
    duplicateRoomTargetCases.map((duplicates) => ({ path, duplicates })),
  ),
)(
  '$path preserves accepted and audited-stop completion ($duplicates)',
  async ({ path, duplicates }) => {
    for (const settlement of ['accepted', 'stopped']) {
      const f = await fixture(path);
      const input: RoomDecisionInput = {
        orgId: 'synthetic',
        actionId: 'remove',
        actionName: 'concord_remove_message',
        itemId: 'case',
        itemTypeId: 'room-type',
        itemTypeName: 'concord_message',
        caseId: f.job.payload.item.data.case_id,
        actorId: 'staff',
        note: 'Synthetic room moderation reason',
        correlationId: `mrt-decision:${f.job.id}`,
        parameters: {},
      };
      try {
        await expect(f.submit()).rejects.toThrow(
          'Synthetic acceptance pending',
        );
        // Model an already-recorded pre-validation decision. Never rewrite such
        // intent in production: only completion counts use unique identities.
        await database
          .updateTable('manual_review_tool.manual_review_decisions')
          .set(duplicateRoomTargetFixture(duplicates))
          .where('id', '=', f.guid)
          .execute();
        const ledger = database as unknown as Kysely<MemberIntentPg>;
        if (duplicates !== 'none') {
          if (path === 'completion')
            await expect(f.remove()).rejects.toThrow('Room');
          else expect(await f.remove()).toBe(false);
          expect(await f.exists()).toBe(true);
        }
        if (settlement === 'accepted') {
          const status: RoomStatus = {
            executionId: roomExecutionId(input),
            decisionId: randomUUID(),
            action: 'remove_message',
            target: {
              communityId: 'a'.repeat(64),
              channelId: 'b'.repeat(64),
              rumorId: 'c'.repeat(64),
            },
            deliveries: ['divine_relay', 'concord', 'discord'].map(
              (target) => ({
                target: target as 'concord',
                state: 'pending',
                attempts: 0,
                resultCode: null,
              }),
            ),
          };
          await recordRoomRemovalAcceptance(ledger, input, status);
        } else {
          await stopRoomAutomation(
            ledger,
            {
              getActor: async () => ({
                id: 'staff',
                orgId: 'synthetic',
                role: UserRole.ADMIN,
                approvedByAdmin: true,
                rejectedByAdmin: false,
                getPermissions: () => getPermissionsForRole(UserRole.ADMIN),
              }),
              fetchHTTP: async () => {
                throw new Error('No external delivery during stop');
              },
            },
            {
              orgId: 'synthetic',
              actorId: 'staff',
              executionId: roomExecutionId(input),
              manualReviewDecisionId: f.guid,
              reason: 'Synthetic operator stop',
            },
          );
        }
        await f.remove();
        expect(await f.exists()).toBe(false);
        expect(f.delivery).toHaveBeenCalledTimes(1);
      } finally {
        await f.close();
      }
    }
  },
);

test('another invoker cannot complete the active job during ordinary removal', async () => {
  const f = await fixture('same-invoker');
  try {
    expect(
      await f.ops.removeJobAllowingInvokerLock({
        orgId: 'synthetic',
        queueId: f.queue.name,
        jobId: f.job.id as never,
        invokerUserId: 'different-staff',
      }),
    ).toBe(false);
    expect(await f.exists()).toBe(true);
    expect(await f.recorded()).toHaveLength(0);
    expect(await f.remove()).toBe(true);
    expect(await f.exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test('a replacement job with the same Bull id cannot register the stale execution identity', async () => {
  const f = await fixture('direct');
  try {
    await f.queue.remove(f.guid);
    const successor = {
      ...f.job,
      id: `${Buffer.from(f.guid).toString('base64url')}:${Buffer.from(randomUUID()).toString('base64url')}`,
    };
    await f.queue.add('replacement', successor, {
      jobId: f.guid,
      removeOnComplete: true,
    });
    await expect(f.submit()).rejects.toThrow();
    expect(await f.recorded()).toHaveLength(0);
    expect(f.delivery).not.toHaveBeenCalled();
    expect((await f.queue.getJob(f.guid))?.data.id).toBe(successor.id);
  } finally {
    await f.close();
  }
});
