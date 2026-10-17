/* eslint-disable functional/immutable-data -- Test barriers and transport capture deliberately model concurrent delivery. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { UserRole } from '../../models/types/permissioning.js';
import {
  deliverMemberIntent,
  memberTargetKey,
  prepareMemberIntent,
  registerMemberIntents,
  type MemberIntentPg,
  type PreparedMemberIntent,
} from './memberIntents.js';
import {
  roomExecutionId,
  type RoomDecisionInput,
  type RoomRequest,
  type RoomStatus,
} from './service.js';

const databaseName = `coop_ordering_test_${randomUUID().replaceAll('-', '')}`;
const config = {
  origin: 'https://moderation.example',
  orgId: 'synthetic-org',
  hmacKey: 'ab'.repeat(32),
  coopOrigin: 'https://coop.example',
  accessIssuer: 'https://test.cloudflareaccess.com',
  accessAudience: 'test',
  queueId: 'queue',
};
const actor = {
  id: 'synthetic-staff',
  orgId: config.orgId,
  role: UserRole.ADMIN,
  approvedByAdmin: true,
  rejectedByAdmin: false,
};
let admin: pg.Pool;
let pgQuery: Kysely<MemberIntentPg>;
const getActor = async () => actor;
const response = (input: RoomDecisionInput, revision: string): RoomStatus => ({
  executionId: roomExecutionId(input),
  sourceOrder: { version: 1, revision },
  decisionId: randomUUID(),
  action:
    input.actionName === 'concord_ban_member' ? 'ban_member' : 'unban_member',
  target: {
    communityId: 'a'.repeat(64),
    channelId: 'b'.repeat(64),
    rumorId: 'c'.repeat(64),
  },
  deliveries: ['divine_relay', 'concord', 'discord'].map((target) => ({
    target: target as 'concord',
    state: 'pending',
    attempts: 0,
    resultCode: null,
  })),
});
const input = (action = 'concord_ban_member'): RoomDecisionInput => ({
  orgId: config.orgId,
  actionId: action,
  actionName: action,
  itemId: 'synthetic-item',
  itemTypeId: 'synthetic-type',
  itemTypeName: 'concord_member',
  caseId: randomUUID(),
  correlationId: `mrt-decision:${randomUUID()}`,
  actorId: actor.id,
  note: 'Synthetic reason',
  parameters: {},
});
async function prepared(
  value: RoomDecisionInput,
  author = 'd'.repeat(64),
): Promise<PreparedMemberIntent> {
  return prepareMemberIntent(
    config,
    {
      getActor,
      fetchHTTP: async () => ({
        ok: true,
        status: 200,
        body: {
          caseId: value.caseId,
          author,
          target: {
            communityId: 'a'.repeat(64),
            channelId: 'b'.repeat(64),
            rumorId: 'c'.repeat(64),
          },
        },
      }),
    },
    value,
  );
}
async function record(value: RoomDecisionInput, author?: string) {
  const intent = await prepared(value, author);
  await pgQuery
    .transaction()
    .execute(async (tx) => registerMemberIntents(tx, [intent]));
  return intent;
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  const connectionString = process.env.MEMBER_INTENT_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error(
      'Set MEMBER_INTENT_TEST_DATABASE_URL to a dedicated loopback PostgreSQL test container',
    );
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Member intent tests require loopback PostgreSQL');
  admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
  pgQuery = new Kysely({ dialect: new PostgresDialect({ pool }) });
  await sql`CREATE TABLE public.orgs (id varchar(255) PRIMARY KEY)`.execute(
    pgQuery,
  );
  await sql`INSERT INTO public.orgs (id) VALUES (${config.orgId})`.execute(
    pgQuery,
  );
  await sql
    .raw(
      await readFile(
        new URL(
          '../../../db/src/scripts/api-server-pg/2026.10.18T00.00.00.add_member_intent_order.sql',
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
  await sql`TRUNCATE concord_integration.member_intent_heads, concord_integration.member_intents, concord_integration.member_intent_quarantine`.execute(
    pgQuery,
  );
});
test('concurrent cross-case staff records serialize once per target and duplicate execution reuses revision', async () => {
  const a = input(),
    b = input('concord_unban_member');
  await Promise.all([record(a), record(b)]);
  const rows = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .orderBy('revision')
    .execute();
  expect(rows.map((row) => row.revision)).toEqual(['1', '2']);
  expect(rows[0].superseded_by_execution_id).toBe(rows[1].execution_id);
  await Promise.all([record(b), record(b)]);
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .execute(),
  ).toHaveLength(2);
  await expect(
    record({ ...b, note: 'Changed original reason' }),
  ).rejects.toThrow('conflict');
  expect(
    (
      await pgQuery
        .selectFrom('concord_integration.member_intent_heads')
        .selectAll()
        .executeTakeFirstOrThrow()
    ).revision,
  ).toBe('2');
});
test('failed transaction preserves counter; different targets and deterministic multi-target locks remain independent', async () => {
  const a = await prepared(input()),
    b = await prepared(input(), 'e'.repeat(64));
  await expect(
    pgQuery.transaction().execute(async (tx) => {
      await registerMemberIntents(tx, [a]);
      throw new Error('Synthetic rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intent_heads')
      .selectAll()
      .execute(),
  ).toHaveLength(0);
  await Promise.all([
    pgQuery
      .transaction()
      .execute(async (tx) => registerMemberIntents(tx, [a, b])),
    pgQuery
      .transaction()
      .execute(async (tx) => registerMemberIntents(tx, [b, a])),
  ]);
  const heads = await pgQuery
    .selectFrom('concord_integration.member_intent_heads')
    .selectAll()
    .execute();
  expect(heads.map((head) => head.revision)).toEqual(['1', '1']);
  expect(memberTargetKey('other-org', 'a'.repeat(64), 'd'.repeat(64))).not.toBe(
    a.targetKey,
  );
});
test('A never accepted, B recorded: recovery A is terminal superseded with zero POST', async () => {
  const a = input(),
    b = input('concord_unban_member');
  await record(a);
  await record(b);
  const fetchHTTP = jest.fn();
  expect(
    await deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).toMatchObject({
    outcome: 'superseded',
    supersededByExecutionId: roomExecutionId(b),
    acceptanceUnknown: false,
  });
  expect(fetchHTTP).not.toHaveBeenCalled();
});
test('accepted response lost then B accepted: reconcile original A via lookup with zero resend', async () => {
  const a = input(),
    b = input('concord_unban_member');
  await record(a);
  const accepted = response(a, '1');
  const fetchHTTP = jest.fn(async (request: RoomRequest) => {
    if (request.method === 'post') throw new Error('Synthetic response loss');
    return { ok: true, status: 200, body: accepted };
  });
  await expect(
    deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('response loss');
  await record(b);
  expect(
    await deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).toMatchObject({
    outcome: 'superseded',
    acceptedDecisionId: accepted.decisionId,
    acceptanceUnknown: false,
  });
  expect(fetchHTTP.mock.calls.map(([request]) => request.method)).toEqual([
    'post',
    'get',
  ]);
  const stored = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('execution_id', '=', roomExecutionId(a))
    .executeTakeFirstOrThrow();
  expect(stored.delivery_state).toBe('superseded');
  expect(stored.accepted_decision_id).toBe(accepted.decisionId);
});
test('late A acknowledgement preserves supersession by latest C and accepted history', async () => {
  const a = input(),
    b = input('concord_unban_member'),
    c = input();
  await record(a);
  const entered = barrier(),
    release = barrier();
  const accepted = response(a, '1');
  const delivering = deliverMemberIntent(
    pgQuery,
    config,
    {
      getActor,
      fetchHTTP: async () => {
        entered.resolve();
        await release.promise;
        return { ok: true, status: 202, body: accepted };
      },
    },
    a,
  );
  await entered.promise;
  await record(b);
  await record(c);
  release.resolve();
  expect(await delivering).toMatchObject({
    outcome: 'superseded',
    supersededByExecutionId: roomExecutionId(b),
    acceptedDecisionId: accepted.decisionId,
  });
  const stored = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('execution_id', '=', roomExecutionId(a))
    .executeTakeFirstOrThrow();
  expect(stored.delivery_state).toBe('superseded');
  expect(stored.superseded_by_execution_id).toBe(roomExecutionId(b));
  expect(
    (
      await pgQuery
        .selectFrom('concord_integration.member_intent_heads')
        .selectAll()
        .executeTakeFirstOrThrow()
    ).current_execution_id,
  ).toBe(roomExecutionId(c));
});
test('concurrent delivery claims produce one POST and uncertain lookup404 never resends', async () => {
  const a = input();
  await record(a);
  const entered = barrier(),
    release = barrier();
  const fetchHTTP = jest.fn(async (request: RoomRequest) => {
    if (request.method === 'get')
      return { ok: false, status: 404, body: { error: 'not_found' } };
    entered.resolve();
    await release.promise;
    throw new Error('Synthetic response loss');
  });
  const delivering = deliverMemberIntent(
    pgQuery,
    config,
    { getActor, fetchHTTP },
    a,
  );
  await entered.promise;
  await expect(
    deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).rejects.toMatchObject({ status: 404 });
  release.resolve();
  await expect(delivering).rejects.toThrow('response loss');
  await expect(
    deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    fetchHTTP.mock.calls.filter(([request]) => request.method === 'post'),
  ).toHaveLength(1);
});
test('old unregistered payload is quarantined without assigning a source revision or posting', async () => {
  const a = input();
  const fetchHTTP = jest.fn(async () => ({
    ok: false,
    status: 404,
    body: { error: 'not_found' },
  }));
  await expect(
    deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('quarantined');
  expect(fetchHTTP.mock.calls).toHaveLength(1);
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intent_quarantine')
      .selectAll()
      .execute(),
  ).toHaveLength(1);
  await expect(record(a)).rejects.toThrow('reconciliation');
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intent_heads')
      .selectAll()
      .execute(),
  ).toHaveLength(0);
});
test('authoritative target validation fails closed before registration', async () => {
  const a = input();
  await expect(
    prepareMemberIntent(
      config,
      {
        getActor,
        fetchHTTP: async () => ({
          ok: true,
          status: 200,
          body: {
            caseId: a.caseId,
            author: 'invalid',
            target: { communityId: 'a'.repeat(64) },
          },
        }),
      },
      a,
    ),
  ).rejects.toThrow('target');
  const intent = await prepared(a);
  await expect(
    pgQuery
      .transaction()
      .execute(async (tx) =>
        registerMemberIntents(tx, [
          intent,
          { ...intent, executionId: randomUUID() },
        ]),
      ),
  ).rejects.toThrow('per target');
});

test('accepted legacy execution is retained by lookup without inventing revision; changed legacy intent conflicts', async () => {
  const a = input();
  const legacy = { ...response(a, '1'), sourceOrder: null };
  const fetchHTTP = jest.fn(async (request: RoomRequest) => {
    expect(request.method).toBe('get');
    return { ok: true, status: 200, body: legacy };
  });
  expect(
    await deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).toMatchObject({
    outcome: 'accepted',
    status: { decisionId: legacy.decisionId, sourceOrder: null },
  });
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intent_heads')
      .selectAll()
      .execute(),
  ).toHaveLength(0);
  const stored = await pgQuery
    .selectFrom('concord_integration.member_intent_quarantine')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(stored.accepted_decision_id).toBe(legacy.decisionId);
  await expect(
    deliverMemberIntent(
      pgQuery,
      config,
      { getActor, fetchHTTP },
      { ...a, note: 'Changed legacy reason' },
    ),
  ).rejects.toThrow('conflict');
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
});
test('counter mismatch after restore fails closed; exhausted bigint never wraps or advances', async () => {
  const a = input();
  await record(a);
  await pgQuery
    .updateTable('concord_integration.member_intent_heads')
    .set({ revision: '0' })
    .execute();
  const fetchHTTP = jest.fn();
  await expect(
    deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('reconciliation');
  expect(fetchHTTP).not.toHaveBeenCalled();
  await pgQuery
    .updateTable('concord_integration.member_intent_heads')
    .set({ revision: '9223372036854775807' })
    .execute();
  await expect(record(input('concord_unban_member'))).rejects.toThrow(
    'exhausted',
  );
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .execute(),
  ).toHaveLength(1);
});
