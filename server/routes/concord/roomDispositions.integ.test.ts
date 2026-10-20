/* eslint-disable functional/immutable-data -- Local pgQuery URL and test race barriers are deliberately mutable. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import {
  roomActionFixture,
  withRoomTestEnvironment,
} from '../../test/manualRoomClientReceipt.js';
import {
  actor,
  config,
  input,
  prepared,
} from '../../test/memberIntentFixtures.js';
import { memberIntentTestDatabaseUrl } from '../../test/memberIntentTestDatabase.js';
import {
  checkRecordedRoomLookupBoundary,
  checkRecordedRoomLookupBudget,
  checkRecordedRoomRemoval,
  checkRelatedRecordedRoomRemoval,
} from '../../test/recordedRoomRemovals.js';
import { checkRoomRemovalAcceptances } from '../../test/roomRemovalAcceptances.js';
import { checkRoomRemovalPublisher } from '../../test/roomRemovalPublisher.js';
import {
  beginManualRoomOperation,
  claimManualRoomOperation,
  retirePreparedManualRoomOperation,
} from './manualRoomOperations.js';
import {
  deliverMemberIntent,
  registerMemberIntents,
  type MemberIntentPg,
} from './memberIntents.js';
import {
  closeRoomExecution,
  getRoomExecutionDisposition,
  listRoomNeedsAttention,
  recordPermanentRefusal,
  roomJobQueueComplete,
  stopRoomAutomation,
} from './roomDispositions.js';
import { roomExecutionId } from './service.js';

const databaseName = `coop_dispositions_test_${randomUUID().replaceAll('-', '')}`;
let pgQuery: Kysely<MemberIntentPg>;
let cleanup = async () => {};
beforeAll(async () => {
  const url = memberIntentTestDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  pgQuery = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString() }),
    }),
  });
  cleanup = async () => {
    await pgQuery.destroy();
    await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  };
  await sql`CREATE TABLE public.orgs (id varchar(255) PRIMARY KEY)`.execute(
    pgQuery,
  );
  await sql`INSERT INTO public.orgs VALUES (${config.orgId})`.execute(pgQuery);
  await sql`CREATE SCHEMA manual_review_tool; CREATE TABLE manual_review_tool.manual_review_decisions (id uuid PRIMARY KEY, org_id text, job_payload jsonb, decision_components jsonb[], related_actions jsonb[])`.execute(
    pgQuery,
  );
  await sql
    .raw(
      await readFile(
        '../db/src/scripts/api-server-pg/2026.10.18T00.00.00.add_member_intent_order.sql',
        'utf8',
      ),
    )
    .execute(pgQuery);
  await sql
    .raw(
      await readFile(
        '../db/src/scripts/api-server-pg/2026.10.19T00.14.35.add_room_operation_lifecycle.sql',
        'utf8',
      ),
    )
    .execute(pgQuery);
  await sql
    .raw(
      await readFile(
        '../db/src/scripts/api-server-pg/2026.10.19T01.38.51.add_room_execution_acceptances.sql',
        'utf8',
      ),
    )
    .execute(pgQuery);
});
afterAll(async () => cleanup());

const deps = {
  getActor: async (id: string, orgId: string) => ({ ...actor, id, orgId }),
  fetchHTTP: jest.fn(),
};
async function record() {
  const request = input();
  await pgQuery
    .transaction()
    .execute(async (tx) =>
      registerMemberIntents(tx, [await prepared(request)]),
    );
  return request;
}
test.each([false, true])(
  'recorded MRT removal can stop with unknown acceptance before delivery or after a lost response: %s',
  async (attempted) => checkRecordedRoomRemoval(pgQuery, attempted),
);
test('recorded related MRT removal binds the related action and item identity', async () =>
  checkRelatedRecordedRoomRemoval(pgQuery));
test('recorded source lookup rejects inconsistent primary organization, job identity and non-room decisions', async () =>
  checkRecordedRoomLookupBoundary(pgQuery));
test('verified matching refusal commits attention before cleanup and remains idempotent after transport disappears', async () => {
  const request = await record();
  const executionId = roomExecutionId(request);
  const fetchHTTP = jest.fn(async () => ({
    ok: false,
    status: 409,
    body: { error: 'decision_source_unavailable', executionId },
  }));
  expect(
    await deliverMemberIntent(pgQuery, config, { ...deps, fetchHTTP }, request),
  ).toMatchObject({
    outcome: 'refused',
    queueComplete: true,
    acceptanceUnknown: false,
  });
  expect(
    await roomJobQueueComplete(pgQuery, config.orgId, request.correlationId, 1),
  ).toBe(true);
  expect(
    await roomJobQueueComplete(pgQuery, config.orgId, request.correlationId, 2),
  ).toBe(false);
  const listing = await listRoomNeedsAttention(pgQuery, deps, {
    orgId: config.orgId,
    actorId: actor.id,
    limit: 100,
  });
  expect(listing.items).toContainEqual(
    expect.objectContaining({
      executionId,
      attentionState: 'needs_attention',
      refusalCode: 'decision_source_unavailable',
      acceptanceUnknown: false,
    }),
  );
  expect(
    await deliverMemberIntent(pgQuery, config, { ...deps, fetchHTTP }, request),
  ).toMatchObject({ outcome: 'stopped', queueComplete: true });
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
  await recordPermanentRefusal(pgQuery, {
    orgId: config.orgId,
    executionId,
    refusalCode: 'decision_source_unavailable',
  });
  expect(
    await pgQuery
      .selectFrom('concord_integration.room_execution_dispositions')
      .selectAll()
      .where('execution_id', '=', executionId)
      .execute(),
  ).toHaveLength(1);
});
test.each(['wrong_execution', 'generic_409', 'outage', 'timeout'])(
  'uncertain %s never becomes permanent refusal',
  async (kind) => {
    const request = await record();
    const fetchHTTP = async () => {
      if (kind === 'timeout') throw new Error('timeout');
      return {
        ok: false,
        status: kind === 'outage' ? 500 : 409,
        body: {
          error:
            kind === 'generic_409'
              ? 'configuration_invalid'
              : 'decision_source_unavailable',
          executionId:
            kind === 'wrong_execution'
              ? randomUUID()
              : roomExecutionId(request),
        },
      };
    };
    await expect(
      deliverMemberIntent(pgQuery, config, { ...deps, fetchHTTP }, request),
    ).rejects.toThrow();
    expect(
      await getRoomExecutionDisposition(
        pgQuery,
        config.orgId,
        roomExecutionId(request),
      ),
    ).toBeNull();
    expect(
      await roomJobQueueComplete(
        pgQuery,
        config.orgId,
        request.correlationId,
        1,
      ),
    ).toBe(false);
  },
);
test('stopping unknown acceptance preserves attention; close cannot claim successful enforcement', async () => {
  const request = await record();
  await expect(
    deliverMemberIntent(
      pgQuery,
      config,
      {
        ...deps,
        fetchHTTP: async () => {
          throw new Error('lost');
        },
      },
      request,
    ),
  ).rejects.toThrow();
  const identity = {
    orgId: config.orgId,
    actorId: actor.id,
    executionId: roomExecutionId(request),
    reason: 'Stop automatic recovery pending investigation',
  };
  expect(await stopRoomAutomation(pgQuery, deps, identity)).toMatchObject({
    attentionState: 'needs_attention',
    automationStopped: true,
    acceptanceUnknown: true,
  });
  await expect(closeRoomExecution(pgQuery, deps, identity)).rejects.toThrow(
    'Unsettled',
  );
  const fetchHTTP = jest.fn();
  expect(
    await deliverMemberIntent(pgQuery, config, { ...deps, fetchHTTP }, request),
  ).toMatchObject({ outcome: 'stopped', acceptanceUnknown: true });
  expect(fetchHTTP).not.toHaveBeenCalled();
  await expect(
    stopRoomAutomation(pgQuery, deps, {
      ...identity,
      executionId: randomUUID(),
    }),
  ).rejects.toThrow('Unknown');
});
test('ADMIN close records independent audit without rewriting original actor/reason; owner cannot erase safety rows', async () => {
  const request = await record();
  const executionId = roomExecutionId(request);
  await recordPermanentRefusal(pgQuery, {
    orgId: config.orgId,
    executionId,
    refusalCode: 'decision_source_unavailable',
  });
  const close = {
    orgId: config.orgId,
    actorId: 'other-admin',
    executionId,
    reason: 'Reviewed definitive refusal',
  };
  expect(await closeRoomExecution(pgQuery, deps, close)).toMatchObject({
    attentionState: 'closed',
    acceptanceUnknown: false,
  });
  const original = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('execution_id', '=', executionId)
    .executeTakeFirstOrThrow();
  expect(original.actor_id).toBe(actor.id);
  expect(original.request_payload.note).toBe('Synthetic reason');
  const events = await pgQuery
    .selectFrom('concord_integration.room_execution_dispositions')
    .selectAll()
    .where('execution_id', '=', executionId)
    .execute();
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'closed',
      actor_id: close.actorId,
      reason: close.reason,
    }),
  );
  await expect(
    sql`DELETE FROM concord_integration.room_execution_dispositions`.execute(
      pgQuery,
    ),
  ).rejects.toThrow('append-only');
  await expect(
    sql`TRUNCATE concord_integration.room_execution_state`.execute(pgQuery),
  ).rejects.toThrow('append-only');
});

test('stopped and durably retired unsent receipt can close without erasing its fence', async () => {
  const { correlationId: _, ...request } = input('concord_remove_message');
  const receipt = await beginManualRoomOperation(pgQuery, config, deps, {
    orgId: config.orgId,
    actorId: actor.id,
    clientNonce: randomUUID(),
    request,
  });
  const identity = {
    orgId: config.orgId,
    actorId: actor.id,
    executionId: receipt.executionId,
    reason: 'Reviewed unsent request',
  };
  await stopRoomAutomation(pgQuery, deps, identity);
  await expect(closeRoomExecution(pgQuery, deps, identity)).rejects.toThrow(
    'Unsettled',
  );
  await retirePreparedManualRoomOperation(pgQuery, deps, {
    ...identity,
    operationId: receipt.operationId,
  });
  expect(await closeRoomExecution(pgQuery, deps, identity)).toMatchObject({
    attentionState: 'closed',
    acceptanceUnknown: false,
  });
  const row = await pgQuery
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('execution_id', '=', receipt.executionId)
    .executeTakeFirstOrThrow();
  expect(row.phase).toBe('retired');
  expect(row.attempted_at).toBeNull();
  expect(row.request_payload.note).toBe(request.note);
});

test('accepted MRT removal survives cleanup loss and completes the queue without another POST', async () => {
  await withRoomTestEnvironment(async () => {
    const fixture = roomActionFixture(pgQuery, 'concord_remove_message');
    expect((await fixture.sendMrt())[0].success).toBe(true);
    expect(
      await roomJobQueueComplete(
        pgQuery,
        config.orgId,
        fixture.request.correlationId,
        1,
      ),
    ).toBe(true);
    expect(
      await roomJobQueueComplete(
        pgQuery,
        config.orgId,
        fixture.request.correlationId,
        2,
      ),
    ).toBe(false);
    fixture.investigation.getItemByIdentifier.mockRejectedValueOnce(
      new Error('Transient source deleted'),
    );
    expect((await fixture.sendMrt())[0].success).toBe(true);
    expect(fixture.investigation.getItemByIdentifier).toHaveBeenCalledTimes(1);
    expect(
      fixture.fetchHTTP.mock.calls.filter(([wire]) => wire.method === 'post'),
    ).toHaveLength(1);
  });
});

test('closing a retired receipt fences an already prepared late registration', async () => {
  const { correlationId: _, ...request } = input();
  const receipt = await beginManualRoomOperation(pgQuery, config, deps, {
    orgId: config.orgId,
    actorId: actor.id,
    clientNonce: randomUUID(),
    request,
  });
  const captured = await prepared({
    ...request,
    correlationId: `manual-action-run:${receipt.operationId}`,
  });
  let release!: () => void;
  let entered!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const late = pgQuery.transaction().execute(async (tx) => {
    entered();
    await pause;
    return registerMemberIntents(tx, [captured]);
  });
  const rejectedLate = expect(late).rejects.toThrow(/receipt|operation/i);
  await ready;
  const identity = {
    orgId: config.orgId,
    actorId: actor.id,
    executionId: receipt.executionId,
    reason: 'Retire before late registration',
  };
  try {
    await stopRoomAutomation(pgQuery, deps, identity);
    await retirePreparedManualRoomOperation(pgQuery, deps, {
      ...identity,
      operationId: receipt.operationId,
    });
    expect(await closeRoomExecution(pgQuery, deps, identity)).toMatchObject({
      attentionState: 'closed',
    });
  } finally {
    release();
  }
  await rejectedLate;
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .where('execution_id', '=', receipt.executionId)
      .execute(),
  ).toEqual([]);
});

test('claimed manual removal cannot retire or close while its request may be in flight', async () => {
  const { correlationId: _, ...request } = input('concord_remove_message');
  const receipt = await beginManualRoomOperation(pgQuery, config, deps, {
    orgId: config.orgId,
    actorId: actor.id,
    clientNonce: randomUUID(),
    request,
  });
  const access = {
    orgId: config.orgId,
    actorId: actor.id,
    operationId: receipt.operationId,
  };
  expect(await claimManualRoomOperation(pgQuery, deps, access)).toMatchObject({
    kind: 'send',
  });
  const identity = {
    ...access,
    executionId: receipt.executionId,
    reason: 'Stop an in-flight request',
  };
  await stopRoomAutomation(pgQuery, deps, identity);
  await expect(
    retirePreparedManualRoomOperation(pgQuery, deps, identity),
  ).rejects.toThrow('attempted');
  await expect(closeRoomExecution(pgQuery, deps, identity)).rejects.toThrow(
    'Unsettled',
  );
  expect(
    await getRoomExecutionDisposition(
      pgQuery,
      config.orgId,
      receipt.executionId,
    ),
  ).toMatchObject({
    attentionState: 'needs_attention',
    acceptanceUnknown: true,
  });
});

test('actual publisher forwards trusted actor/reason, rejects unauthorized retries and replays stable acceptance', async () => {
  await withRoomTestEnvironment(async () => checkRoomRemovalPublisher(pgQuery));
});
test('removal journal binds responses and requests, rejects malformed facts, and survives owner mutation attempts', async () => {
  await checkRoomRemovalAcceptances(pgQuery);
});
test('exhausting the primary lookup budget reports incomplete and records no disposition', async () =>
  checkRecordedRoomLookupBudget(pgQuery));
