/* eslint-disable functional/immutable-data -- Local pgQuery URL and test race barriers are deliberately mutable. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { UserRole } from '../../models/types/permissioning.js';
import {
  actor,
  config,
  input,
  prepared,
} from '../../test/memberIntentFixtures.js';
import { memberIntentTestDatabaseUrl } from '../../test/memberIntentTestDatabase.js';
import { jsonStringify } from '../../utils/encoding.js';
import {
  beginManualRoomOperation,
  claimManualRoomOperation,
  getManualRoomOperation,
  retirePreparedManualRoomOperation,
} from './manualRoomOperations.js';
import {
  prepareMemberIntent,
  registerMemberIntents,
  type MemberIntentPg,
} from './memberIntents.js';

const databaseName = `coop_receipts_test_${randomUUID().replaceAll('-', '')}`;
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
test('unissued v2 execution cannot allocate a member revision', async () => {
  const value = {
    ...input(),
    correlationId: `manual-action-run:source-order-v2_ban_member_${randomUUID()}`,
  };
  await expect(
    pgQuery
      .transaction()
      .execute(async (tx) =>
        registerMemberIntents(tx, [await prepared(value)]),
      ),
  ).rejects.toThrow('receipt');
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intent_heads')
      .selectAll()
      .execute(),
  ).toHaveLength(0);
});

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
test('duplicate nonce reuses identity; action, reason and item changes conflict', async () => {
  const args = beginArgs();
  const first = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    args,
  );
  expect(
    await beginManualRoomOperation(pgQuery, config, dependencies, args),
  ).toEqual(first);
  for (const change of [
    { note: 'Changed' },
    { actionName: 'concord_unban_member' },
    { itemId: 'other' },
  ]) {
    await expect(
      beginManualRoomOperation(pgQuery, config, dependencies, {
        ...args,
        request: { ...args.request, ...change },
      }),
    ).rejects.toThrow('conflict');
  }
  await expect(
    beginManualRoomOperation(pgQuery, config, dependencies, {
      ...args,
      request: { ...args.request, actorId: 'other' },
    }),
  ).rejects.toThrow('Invalid');
});
test('denied membership or invalid reason creates no usable receipt', async () => {
  const args = beginArgs();
  await expect(
    beginManualRoomOperation(
      pgQuery,
      config,
      {
        ...dependencies,
        getActor: async () => ({ ...actor, role: UserRole.ANALYST }),
      },
      args,
    ),
  ).rejects.toThrow('permission');
  await expect(
    beginManualRoomOperation(pgQuery, config, dependencies, {
      ...args,
      request: { ...args.request, note: 'x'.repeat(2049) },
    }),
  ).rejects.toThrow('Invalid');
  expect(
    await pgQuery
      .selectFrom('concord_integration.room_manual_operations')
      .selectAll()
      .where('client_nonce', '=', args.clientNonce)
      .execute(),
  ).toHaveLength(0);
});
test('receipt access requires owner or current ADMIN in the same organization', async () => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs(),
  );
  const ordinary = {
    ...dependencies,
    getActor: async (id: string, orgId: string) => ({
      ...actor,
      id,
      orgId,
      role: UserRole.MODERATOR_MANAGER,
    }),
  };
  await expect(
    getManualRoomOperation(pgQuery, ordinary, {
      ...access(receipt),
      actorId: 'other',
    }),
  ).rejects.toThrow('unavailable');
  await expect(
    getManualRoomOperation(pgQuery, dependencies, {
      ...access(receipt),
      orgId: 'other-org',
    }),
  ).rejects.toThrow('unavailable');
  expect(
    await getManualRoomOperation(pgQuery, dependencies, {
      ...access(receipt),
      actorId: 'admin-other',
    }),
  ).toMatchObject({ operationId: receipt.operationId });
  await expect(
    claimManualRoomOperation(pgQuery, dependencies, {
      ...access(receipt),
      actorId: 'admin-other',
    }),
  ).rejects.toThrow('Original');
});
test('retirement while authoritative preparation is delayed prevents any order or send', async () => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs(),
  );
  const request = await payload(receipt);
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const intent = prepareMemberIntent(
    config,
    {
      ...dependencies,
      fetchHTTP: async () => {
        entered();
        await paused;
        return {
          ok: true,
          status: 200,
          body: {
            caseId: request.caseId,
            author: 'd'.repeat(64),
            target: {
              communityId: 'a'.repeat(64),
              channelId: 'b'.repeat(64),
              rumorId: 'c'.repeat(64),
            },
          },
        };
      },
    },
    request,
  );
  await preparing;
  const retired = await retirePreparedManualRoomOperation(
    pgQuery,
    dependencies,
    { ...access(receipt), reason: 'Replace before send' },
  );
  resume();
  await expect(
    pgQuery
      .transaction()
      .execute(async (tx) => registerMemberIntents(tx, [await intent])),
  ).rejects.toThrow('receipt');
  expect(retired).toMatchObject({
    phase: 'retired',
    recorded: false,
    acceptanceUnknown: false,
    allowedNextActions: ['replace'],
  });
  expect(
    await claimManualRoomOperation(pgQuery, dependencies, access(receipt)),
  ).toMatchObject({ kind: 'blocked', request: null });
  expect(
    await pgQuery
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .where('execution_id', '=', receipt.executionId)
      .execute(),
  ).toHaveLength(0);
  expect(
    await retirePreparedManualRoomOperation(pgQuery, dependencies, {
      ...access(receipt),
      reason: 'Duplicate retire',
    }),
  ).toEqual(retired);
  expect(
    await getManualRoomOperation(pgQuery, dependencies, access(receipt)),
  ).toEqual(retired);
});
test('registration wins the same execution lock: retirement reports recorded conflict', async () => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs(),
  );
  const intent = await prepared(await payload(receipt));
  await pgQuery
    .transaction()
    .execute(async (tx) => registerMemberIntents(tx, [intent]));
  await expect(
    retirePreparedManualRoomOperation(pgQuery, dependencies, {
      ...access(receipt),
      reason: 'Too late',
    }),
  ).rejects.toMatchObject({ status: { recorded: true, phase: 'registered' } });
  expect(
    await claimManualRoomOperation(pgQuery, dependencies, access(receipt)),
  ).toMatchObject({ kind: 'send', status: { acceptanceUnknown: true } });
  expect(
    await claimManualRoomOperation(pgQuery, dependencies, access(receipt)),
  ).toMatchObject({ kind: 'lookup' });
});
test.each([
  'concord_remove_message',
  'concord_ban_member',
  'concord_unban_member',
])('retired %s cannot later claim an attempt', async (action) => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs(action),
  );
  await retirePreparedManualRoomOperation(pgQuery, dependencies, {
    ...access(receipt),
    reason: 'Superseded preparation',
  });
  expect(
    await claimManualRoomOperation(pgQuery, dependencies, access(receipt)),
  ).toMatchObject({ kind: 'blocked' });
  const row = await pgQuery
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('execution_id', '=', receipt.executionId)
    .executeTakeFirstOrThrow();
  expect(row.attempted_at).toBeNull();
  await expect(
    sql`DELETE FROM concord_integration.room_manual_operations WHERE execution_id = ${receipt.executionId}::uuid`.execute(
      pgQuery,
    ),
  ).rejects.toThrow('cannot be deleted');
});
test('unknown operation cannot retire and an attempted removal cannot be cancelled', async () => {
  await expect(
    retirePreparedManualRoomOperation(pgQuery, dependencies, {
      ...access({ operationId: 'unknown' }),
      reason: 'Unknown',
    }),
  ).rejects.toThrow('unavailable');
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs('concord_remove_message'),
  );
  await claimManualRoomOperation(pgQuery, dependencies, access(receipt));
  await expect(
    retirePreparedManualRoomOperation(pgQuery, dependencies, {
      ...access(receipt),
      reason: 'Too late',
    }),
  ).rejects.toMatchObject({ status: { acceptanceUnknown: true } });
});
test('raw late INSERT also rejects a retired receipt and leaves target revision unchanged', async () => {
  const receipt = await beginManualRoomOperation(
    pgQuery,
    config,
    dependencies,
    beginArgs(),
  );
  const intent = await prepared(await payload(receipt));
  await retirePreparedManualRoomOperation(pgQuery, dependencies, {
    ...access(receipt),
    reason: 'Before insertion',
  });
  await expect(
    sql`INSERT INTO concord_integration.member_intents (org_id, execution_id, target_key, revision, case_id, source_kind, source_id, action, actor_id, fingerprint, request_payload, delivery_state) VALUES (${config.orgId}, ${receipt.executionId}::uuid, ${intent.targetKey}, 123, ${intent.input.caseId}::uuid, 'manual-action-run', ${intent.input.correlationId}, ${intent.action}, ${actor.id}, ${intent.fingerprint}, ${jsonStringify(intent.input)}::jsonb, 'registered')`.execute(
      pgQuery,
    ),
  ).rejects.toThrow('retired');
});
