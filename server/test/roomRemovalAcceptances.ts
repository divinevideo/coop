import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { type MemberIntentPg } from '../routes/concord/memberIntentTypes.js';
import { roomJobQueueComplete } from '../routes/concord/roomDispositions.js';
import {
  deliverMrtRemoval,
  recordRoomRemovalAcceptance,
  storedRoomRemoval,
} from '../routes/concord/roomRemovalDelivery.js';
import { roomExecutionId } from '../routes/concord/service.js';
import { actor, config, input, response } from './memberIntentFixtures.js';

export async function checkRoomRemovalAcceptances(
  pgQuery: Kysely<MemberIntentPg>,
) {
  const request = input('concord_remove_message');
  const status = {
    ...response(request, '1'),
    action: 'remove_message' as const,
    sourceOrder: null,
  };
  const dependencies = { getActor: async () => actor, fetchHTTP: jest.fn() };
  const executionId = roomExecutionId(request);
  // A lost, absent or mismatched response is not an acceptance fact.
  for (const executionId of [undefined, randomUUID()]) {
    await expect(
      recordRoomRemovalAcceptance(pgQuery, request, { ...status, executionId }),
    ).rejects.toThrow();
  }
  await expect(
    deliverMrtRemoval(
      pgQuery,
      config,
      {
        ...dependencies,
        fetchHTTP: async () => ({
          ok: false,
          status: 404,
          body: { error: 'not_found' },
        }),
      },
      request,
    ),
  ).rejects.toThrow();
  expect(
    await roomJobQueueComplete(pgQuery, config.orgId, request.correlationId, 1),
  ).toBe(false);
  // Concurrent recovery of the same accepted execution appends exactly one fact.
  await Promise.all(
    [1, 2].map(async () =>
      recordRoomRemovalAcceptance(pgQuery, request, status),
    ),
  );
  expect(
    await pgQuery
      .selectFrom('concord_integration.room_execution_acceptances')
      .selectAll()
      .where('execution_id', '=', executionId)
      .execute(),
  ).toHaveLength(1);
  expect(
    await deliverMrtRemoval(pgQuery, config, dependencies, request),
  ).toMatchObject({ outcome: 'accepted', status });
  expect(dependencies.fetchHTTP).not.toHaveBeenCalled();
  await expect(
    deliverMrtRemoval(pgQuery, config, dependencies, {
      ...request,
      note: 'Changed immutable reason',
    }),
  ).rejects.toThrow('request conflict');
  await expect(
    recordRoomRemovalAcceptance(pgQuery, request, {
      ...status,
      decisionId: randomUUID(),
    }),
  ).rejects.toThrow('identity conflict');
  const row = (await storedRoomRemoval(pgQuery, config.orgId, executionId))!;
  // Run as the actual table owner; GRANT revocation alone does not protect these facts.
  const ownership = await sql<{
    owned: boolean;
  }>`SELECT tableowner = current_user AS owned FROM pg_tables WHERE schemaname = 'concord_integration' AND tablename = 'room_execution_acceptances'`.execute(
    pgQuery,
  );
  expect(ownership.rows[0].owned).toBe(true);
  for (const statement of [
    'DELETE FROM concord_integration.room_execution_acceptances',
    'TRUNCATE concord_integration.room_execution_acceptances',
    "UPDATE concord_integration.room_execution_acceptances SET source_id = 'mrt-decision:recycled'",
  ])
    await expect(sql.raw(statement).execute(pgQuery)).rejects.toThrow(
      'append-only',
    );
  // SQL CHECK must reject null/missing JSON keys, rather than passing UNKNOWN.
  for (const malformed of [{}, null, [], { ...request, orgId: null }]) {
    const malformedExecution = randomUUID();
    await expect(
      pgQuery
        .insertInto('concord_integration.room_execution_acceptances')
        .values({
          ...row,
          execution_id: malformedExecution,
          accepted_status: { ...status, executionId: malformedExecution },
          request_payload: malformed as never,
        })
        .execute(),
    ).rejects.toThrow();
  }
  for (const malformed of [{}, null, [], { ...status, action: null }]) {
    const malformedExecution = randomUUID();
    await expect(
      pgQuery
        .insertInto('concord_integration.room_execution_acceptances')
        .values({
          ...row,
          execution_id: malformedExecution,
          accepted_status: (malformed && !Array.isArray(malformed)
            ? { ...malformed, executionId: malformedExecution }
            : malformed) as never,
        })
        .execute(),
    ).rejects.toThrow();
  }
  expect(await storedRoomRemoval(pgQuery, config.orgId, executionId)).toEqual(
    row,
  );
  expect(
    await roomJobQueueComplete(pgQuery, config.orgId, request.correlationId, 1),
  ).toBe(true);
}
