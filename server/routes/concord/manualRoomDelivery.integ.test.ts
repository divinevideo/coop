/* eslint-disable functional/immutable-data -- Local pgQuery URL and test race barriers are deliberately mutable. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { checkManualRoomClientReceipt } from '../../test/manualRoomClientReceipt.js';
import {
  actor,
  config,
  input,
  prepared,
  response,
} from '../../test/memberIntentFixtures.js';
import { memberIntentTestDatabaseUrl } from '../../test/memberIntentTestDatabase.js';
import { deliverManualRoomOperation } from './manualRoomDelivery.js';
import {
  beginManualRoomOperation,
  getManualRoomOperation,
} from './manualRoomOperations.js';
import { prepareReversalMemberIntent } from './memberIntentIdentity.js';
import { registerMemberIntents, type MemberIntentPg } from './memberIntents.js';
import { roomAction, roomExecutionId, type RoomRequest } from './service.js';

const databaseName = `coop_manual_delivery_test_${randomUUID().replaceAll('-', '')}`;
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
});
afterAll(async () => cleanup());
const dependencies = {
  getActor: async (id: string, orgId: string) => ({ ...actor, id, orgId }),
  fetchHTTP: jest.fn(),
};
function beginArgs(action = 'concord_ban_member') {
  const { correlationId: _, ...request } = input(action);
  return {
    orgId: request.orgId,
    actorId: actor.id,
    clientNonce: randomUUID(),
    request,
  };
}
function access(status: { operationId: string }) {
  return {
    orgId: config.orgId,
    actorId: actor.id,
    operationId: status.operationId,
  };
}
async function payload(status: { executionId: string }) {
  return (
    await pgQuery
      .selectFrom('concord_integration.room_manual_operations')
      .select('request_payload')
      .where('execution_id', '=', status.executionId)
      .executeTakeFirstOrThrow()
  ).request_payload;
}
test.each([
  'concord_remove_message',
  'concord_ban_member',
  'concord_unban_member',
])(
  'lost response for %s recovers original acceptance without resending',
  async (action) => {
    const receipt = await beginManualRoomOperation(
      pgQuery,
      config,
      dependencies,
      beginArgs(action),
    );
    const request = await payload(receipt);
    if (action !== 'concord_remove_message')
      await pgQuery
        .transaction()
        .execute(async (tx) =>
          registerMemberIntents(tx, [await prepared(request)]),
        );
    const intent = await pgQuery
      .selectFrom('concord_integration.member_intents')
      .select('revision')
      .where('execution_id', '=', receipt.executionId)
      .executeTakeFirst();
    const accepted = {
      ...response(request, intent?.revision ?? '1'),
      action: roomAction(action)!,
      sourceOrder: intent
        ? { version: 1 as const, revision: intent.revision }
        : null,
    };
    const fetchHTTP = jest.fn(async (wire: RoomRequest) => {
      if (wire.method === 'post') throw new Error('Lost response');
      return { ok: true, status: 200, body: accepted };
    });
    await expect(
      deliverManualRoomOperation(
        pgQuery,
        config,
        { ...dependencies, fetchHTTP },
        request,
      ),
    ).rejects.toThrow('Lost response');
    expect(
      await getManualRoomOperation(pgQuery, dependencies, access(receipt)),
    ).toMatchObject({ acceptanceUnknown: true });
    expect(
      await deliverManualRoomOperation(
        pgQuery,
        config,
        { ...dependencies, fetchHTTP },
        request,
      ),
    ).toMatchObject({
      outcome: 'accepted',
      status: { decisionId: accepted.decisionId },
    });
    expect(fetchHTTP.mock.calls.map(([wire]) => wire.method)).toEqual([
      'post',
      'get',
    ]);
    expect(
      await getManualRoomOperation(pgQuery, dependencies, access(receipt)),
    ).toMatchObject({ phase: 'accepted', acceptanceUnknown: false });
  },
);
test('changed request never reaches transport; exact 404 recovery preserves removal identity and attempt timestamp', async () => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs('concord_remove_message'),
  );
  const request = await payload(receipt);
  const accepted = {
    ...response(request, '1'),
    action: 'remove_message' as const,
    sourceOrder: null,
  };
  const lost = jest.fn(async () => {
    throw new Error('Lost response');
  });
  for (const change of [
    { actorId: 'other' },
    { note: 'other reason' },
    { actionName: 'concord_ban_member' },
  ])
    await expect(
      deliverManualRoomOperation(
        pgQuery,
        config,
        { ...dependencies, fetchHTTP: lost },
        { ...request, ...change },
      ),
    ).rejects.toThrow('conflict');
  expect(lost).not.toHaveBeenCalled();
  await expect(
    deliverManualRoomOperation(
      pgQuery,
      config,
      { ...dependencies, fetchHTTP: lost },
      request,
    ),
  ).rejects.toThrow('Lost');
  const before = await pgQuery
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('execution_id', '=', receipt.executionId)
    .executeTakeFirstOrThrow();
  const fetchHTTP = jest.fn(async (wire: RoomRequest) =>
    wire.method === 'get'
      ? { ok: false, status: 404, body: { error: 'not_found' } }
      : { ok: true, status: 202, body: accepted },
  );
  expect(
    await deliverManualRoomOperation(
      pgQuery,
      config,
      { ...dependencies, fetchHTTP },
      request,
    ),
  ).toMatchObject({ outcome: 'accepted' });
  expect(fetchHTTP.mock.calls.map(([wire]) => wire.method)).toEqual([
    'get',
    'post',
  ]);
  const after = await pgQuery
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('execution_id', '=', receipt.executionId)
    .executeTakeFirstOrThrow();
  expect(after.attempted_at).toEqual(before.attempted_at);
  expect(after.fingerprint).toBe(before.fingerprint);
});
test('new B during lookup404 prevents every retry POST for old A', async () => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs(),
  );
  const request = await payload(receipt);
  await pgQuery
    .transaction()
    .execute(async (tx) =>
      registerMemberIntents(tx, [await prepared(request)]),
    );
  await expect(
    deliverManualRoomOperation(
      pgQuery,
      config,
      {
        ...dependencies,
        fetchHTTP: async () => {
          throw new Error('Lost');
        },
      },
      request,
    ),
  ).rejects.toThrow('Lost');
  const replacement = input('concord_unban_member');
  const fetchHTTP = jest.fn(async (wire: RoomRequest) => {
    expect(wire.method).toBe('get');
    await pgQuery
      .transaction()
      .execute(async (tx) =>
        registerMemberIntents(tx, [await prepared(replacement)]),
      );
    return { ok: false, status: 404, body: { error: 'not_found' } };
  });
  expect(
    await deliverManualRoomOperation(
      pgQuery,
      config,
      { ...dependencies, fetchHTTP },
      request,
    ),
  ).toMatchObject({ outcome: 'superseded', acceptanceUnknown: true });
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
});
test('runtime table owner cannot truncate receipt safety records', async () => {
  await expect(
    sql`TRUNCATE concord_integration.room_manual_operations`.execute(pgQuery),
  ).rejects.toThrow('append-only');
});

test('reversal after case deletion uses authenticated prior target and next same-member revision', async () => {
  const ban = input();
  await pgQuery
    .transaction()
    .execute(async (tx) => registerMemberIntents(tx, [await prepared(ban)]));
  const priorDecisionId = randomUUID();
  const {
    caseId: _,
    correlationId: __,
    ...base
  } = input('concord_unban_member');
  const args = {
    orgId: config.orgId,
    actorId: actor.id,
    clientNonce: randomUUID(),
    request: { ...base, priorDecisionId },
  };
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    args,
  );
  const request = await payload(receipt);
  const context = {
    decisionId: priorDecisionId,
    caseId: ban.caseId,
    action: 'ban_member',
    communityId: 'a'.repeat(64),
    channelId: 'b'.repeat(64),
    rumorId: 'c'.repeat(64),
    author: 'd'.repeat(64),
    discordGuildConfirmed: true,
  };
  const fetchHTTP = jest.fn(async (wire: RoomRequest) => {
    expect(wire.url).not.toContain('/v1/cases/');
    if (wire.method === 'get') return { ok: true, status: 200, body: context };
    const stored = await pgQuery
      .selectFrom('concord_integration.member_intents')
      .select('revision')
      .where('execution_id', '=', receipt.executionId)
      .executeTakeFirstOrThrow();
    return {
      ok: true,
      status: 202,
      body: {
        ...response(request, stored.revision),
        discordRestriction: {
          state: 'present',
          checkedAt: '2026-10-19T00:00:00Z',
          code: 'guild_ban_present',
        },
        auditAvailable: true,
      },
    };
  });
  const preparedReversal = await prepareReversalMemberIntent(
    config,
    { ...dependencies, fetchHTTP },
    request,
  );
  await pgQuery
    .transaction()
    .execute(async (tx) => registerMemberIntents(tx, [preparedReversal]));
  const previous = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('execution_id', '=', roomExecutionId(ban))
    .executeTakeFirstOrThrow();
  const next = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('execution_id', '=', receipt.executionId)
    .executeTakeFirstOrThrow();
  expect(next.revision).toBe((BigInt(previous.revision) + 1n).toString());
  expect(next.case_id).toBeNull();
  expect(next.prior_decision_id).toBe(priorDecisionId);
  expect(next.target_key).toBe(previous.target_key);
  expect(
    await deliverManualRoomOperation(
      pgQuery,
      config,
      { ...dependencies, fetchHTTP },
      request,
    ),
  ).toMatchObject({
    outcome: 'accepted',
    status: { discordRestriction: { state: 'present' }, auditAvailable: true },
  });
  const post = fetchHTTP.mock.calls.find(
    ([wire]) => wire.method === 'post',
  )![0];
  expect(post.url).toBe(
    `${config.origin}/v1/decisions/${priorDecisionId}/reversals`,
  );
  expect(post.body).not.toContain('caseId');
  expect(post.body).not.toContain('author');
  expect(
    await getManualRoomOperation(pgQuery, dependencies, access(receipt)),
  ).toMatchObject({
    phase: 'accepted',
    sourceOrder: { revision: next.revision },
  });
});

test.each([
  'concord_remove_message',
  'concord_ban_member',
  'concord_unban_member',
])(
  'ItemAction begin/bulk contract delivers %s through actual API, publisher and PG',
  async (action) => {
    const environment = {
      CONCORD_MODERATION_ORIGIN: config.origin,
      CONCORD_ORG_ID: config.orgId,
      CONCORD_MODERATION_HMAC_KEY: config.hmacKey,
      CONCORD_COOP_ORIGIN: config.coopOrigin,
      CONCORD_ACCESS_ISSUER: config.accessIssuer,
      CONCORD_ACCESS_AUDIENCE: config.accessAudience,
      CONCORD_QUEUE_ID: config.queueId,
    };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment);
    try {
      await checkManualRoomClientReceipt(pgQuery, action);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  },
);
