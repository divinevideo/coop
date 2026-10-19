/* eslint-disable functional/immutable-data -- Test barriers and transport capture deliberately model concurrent delivery. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import {
  config,
  getActor,
  input,
  prepared,
  response,
} from '../../test/memberIntentFixtures.js';
import {
  checkConcurrentRecovery,
  checkNullOrderReconciliation,
  checkTransportRecovery,
} from '../../test/memberIntentRecoveryChecks.js';
import { memberIntentTestDatabaseUrl } from '../../test/memberIntentTestDatabase.js';
import {
  deliverMemberIntent,
  memberTargetKey,
  prepareMemberIntent,
  registerMemberIntents,
  type MemberIntentPg,
} from './memberIntents.js';
import { memberIntentStatuses } from './memberIntentStatus.js';
import {
  roomExecutionId,
  type RoomDecisionInput,
  type RoomRequest,
} from './service.js';

const databaseName = `coop_ordering_test_${randomUUID().replaceAll('-', '')}`;
let cleanup = async () => {};
let pgQuery: Kysely<MemberIntentPg>;
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
  const url = memberIntentTestDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url.toString() });
  cleanup = async () => {
    await admin.end();
  };
  await admin.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 12 });
  pgQuery = new Kysely({ dialect: new PostgresDialect({ pool }) });
  cleanup = async () => {
    await pgQuery.destroy();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  };
  await sql`CREATE TABLE public.orgs (id varchar(255) PRIMARY KEY)`.execute(
    pgQuery,
  );
  await sql`INSERT INTO public.orgs (id) VALUES (${config.orgId})`.execute(
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
});
afterAll(async () => {
  await cleanup();
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
test('concurrent uncertain recovery repeats only the same execution and accepted retries never resend', async () => {
  await checkConcurrentRecovery(pgQuery);
});

test('pre-commit transport failure recovers after lookup404 without allocating new order', async () => {
  await checkTransportRecovery(pgQuery);
});

test('registered execution with legacy null order requires reconciliation, never acceptance', async () => {
  await checkNullOrderReconciliation(pgQuery);
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

test('validated bridge stale refusal settles uncertainty and never performs another lookup or POST', async () => {
  const a = input();
  await record(a);
  const successor = randomUUID();
  const fetchHTTP = jest.fn(async () => ({
    ok: false,
    status: 409,
    body: {
      error: 'member_intent_superseded',
      executionId: roomExecutionId(a),
      currentRevision: '2',
      supersededByExecutionId: successor,
    },
  }));
  const first = await deliverMemberIntent(
    pgQuery,
    config,
    { getActor, fetchHTTP },
    a,
  );
  expect(first).toMatchObject({
    outcome: 'superseded',
    acceptanceUnknown: false,
    supersededByExecutionId: successor,
  });
  expect(
    await deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).toEqual(first);
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
  const stored = await pgQuery
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(stored.last_attempt_at).toBeInstanceOf(Date);
  expect(await memberIntentStatuses(pgQuery, a.orgId, a.caseId)).toEqual([
    expect.objectContaining({
      deliveryState: 'superseded',
      acceptanceUnknown: false,
      supersededByExecutionId: successor,
    }),
  ]);
});
test('local supersession after an uncertain send and lookup404 retains uncertainty in recovery and public status', async () => {
  const a = input();
  await record(a);
  await expect(
    deliverMemberIntent(
      pgQuery,
      config,
      {
        getActor,
        fetchHTTP: async () => {
          throw new Error('Synthetic lost response');
        },
      },
      a,
    ),
  ).rejects.toThrow('lost response');
  await record(input('concord_unban_member'));
  const fetchHTTP = jest.fn(async () => ({
    ok: false,
    status: 404,
    body: { error: 'not_found' },
  }));
  expect(
    await deliverMemberIntent(pgQuery, config, { getActor, fetchHTTP }, a),
  ).toMatchObject({ outcome: 'superseded', acceptanceUnknown: true });
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
  expect(await memberIntentStatuses(pgQuery, a.orgId, a.caseId)).toEqual([
    expect.objectContaining({ acceptanceUnknown: true }),
  ]);
});
