import { type Kysely } from 'kysely';

import {
  deliverMemberIntent,
  registerMemberIntents,
  type MemberIntentPg,
} from '../routes/concord/memberIntents.js';
import {
  type RoomDecisionInput,
  type RoomRequest,
} from '../routes/concord/service.js';
import {
  config,
  getActor,
  input,
  prepared,
  response,
} from './memberIntentFixtures.js';

async function record(pg: Kysely<MemberIntentPg>, value: RoomDecisionInput) {
  const intent = await prepared(value);
  await pg
    .transaction()
    .execute(async (tx) => registerMemberIntents(tx, [intent]));
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function checkConcurrentRecovery(pg: Kysely<MemberIntentPg>) {
  const a = input();
  await record(pg, a);
  const entered = barrier(),
    release = barrier(),
    replayEntered = barrier();
  const accepted = response(a, '1');
  let posts = 0;
  const fetchHTTP = jest.fn(async (request: RoomRequest) => {
    if (request.method === 'get')
      return { ok: false, status: 404, body: { error: 'not_found' } };
    posts += 1;
    if (posts === 1) entered.resolve();
    else replayEntered.resolve();
    await release.promise;
    return { ok: true, status: 202, body: accepted };
  });
  const delivering = deliverMemberIntent(
    pg,
    config,
    { getActor, fetchHTTP },
    a,
  );
  await entered.promise;
  const recovering = deliverMemberIntent(
    pg,
    config,
    { getActor, fetchHTTP },
    a,
  );
  await replayEntered.promise;
  release.resolve();
  for (const outcome of await Promise.all([delivering, recovering]))
    expect(outcome).toMatchObject({
      outcome: 'accepted',
      status: { decisionId: accepted.decisionId },
    });
  const requests = fetchHTTP.mock.calls.filter(
    ([request]) => request.method === 'post',
  );
  expect(requests).toHaveLength(2);
  expect(requests[0][0].body).toBe(requests[1][0].body);
  await expect(
    deliverMemberIntent(pg, config, { getActor, fetchHTTP }, a),
  ).resolves.toMatchObject({
    outcome: 'accepted',
    status: { decisionId: accepted.decisionId },
  });
  expect(
    fetchHTTP.mock.calls.filter(([request]) => request.method === 'post'),
  ).toHaveLength(2);
}
export async function checkTransportRecovery(pg: Kysely<MemberIntentPg>) {
  const a = input();
  await record(pg, a);
  const accepted = response(a, '1');
  let firstPost = true;
  const fetchHTTP = jest.fn(async (request: RoomRequest) => {
    if (request.method === 'get')
      return { ok: false, status: 404, body: { error: 'not_found' } };
    if (firstPost) {
      firstPost = false;
      throw new Error('Connection refused before commit');
    }
    return { ok: true, status: 202, body: accepted };
  });
  await expect(
    deliverMemberIntent(pg, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('Connection refused');
  await expect(
    deliverMemberIntent(pg, config, { getActor, fetchHTTP }, a),
  ).resolves.toMatchObject({
    outcome: 'accepted',
    status: { decisionId: accepted.decisionId },
  });
  const posts = fetchHTTP.mock.calls.filter(
    ([request]) => request.method === 'post',
  );
  expect(posts).toHaveLength(2);
  expect(posts[0][0].body).toBe(posts[1][0].body);
  const rows = await pg
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .execute();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    revision: '1',
    delivery_state: 'accepted',
    accepted_decision_id: accepted.decisionId,
  });
}
export async function checkNullOrderReconciliation(pg: Kysely<MemberIntentPg>) {
  const a = input();
  await record(pg, a);
  const fetchHTTP = jest.fn(async () => ({
    ok: true,
    status: 202,
    body: { ...response(a, '1'), sourceOrder: null },
  }));
  await expect(
    deliverMemberIntent(pg, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('Mismatched');
  const row = await pg
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(row.delivery_state).toBe('reconciliation_required');
  expect(row.accepted_decision_id).toBeNull();
  await expect(
    deliverMemberIntent(pg, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('requires reconciliation');
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
  const legacy = { ...response(a, '1'), sourceOrder: null };
  await pg
    .updateTable('concord_integration.member_intents')
    .set({
      delivery_state: 'accepted',
      accepted_decision_id: legacy.decisionId,
      accepted_status: legacy,
    })
    .execute();
  await expect(
    deliverMemberIntent(pg, config, { getActor, fetchHTTP }, a),
  ).rejects.toThrow('Mismatched');
  const retained = await pg
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .executeTakeFirstOrThrow();
  expect(retained.delivery_state).toBe('reconciliation_required');
  expect(retained.accepted_decision_id).toBe(legacy.decisionId);
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
}
