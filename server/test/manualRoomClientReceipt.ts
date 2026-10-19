import { randomUUID } from 'node:crypto';
import { type Kysely } from 'kysely';

import { ActionAPI } from '../graphql/datasources/ActionApi.js';
import { type MemberIntentPg } from '../routes/concord/memberIntentTypes.js';
import { roomAction, type RoomRequest } from '../routes/concord/service.js';
import { ActionPublisher } from '../rule_engine/ActionPublisher.js';
import { toCorrelationId } from '../utils/correlationIds.js';
import { tryJsonParse } from '../utils/encoding.js';
import { actor, config, input, response } from './memberIntentFixtures.js';

/** Exercise the exact begin/bulk boundary used by ItemAction with the real publisher and PG. */
export function roomActionFixture(
  pgQuery: Kysely<MemberIntentPg>,
  actionName: string,
) {
  const request = input(actionName);
  const action = {
    id: actionName,
    name: actionName,
    orgId: config.orgId,
    actionType: 'CUSTOM_ACTION',
    callbackUrl: config.origin + '/v1/decisions',
    callbackUrlHeaders: null,
    callbackUrlBody: null,
    customMrtApiParams: null,
    applyUserStrikes: false,
    penalty: 'NONE',
  };
  const itemType = {
    id: request.itemTypeId,
    kind: 'USER' as const,
    name: request.itemTypeName,
  };
  const investigation = {
    getItemByIdentifier: jest.fn(async () => ({
      latestSubmission: {
        itemId: request.itemId,
        itemType,
        data: { case_id: request.caseId },
      },
    })),
  };
  const fetchHTTP = jest.fn(async (wire: RoomRequest) => {
    if (wire.url.includes('/v1/cases/'))
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
    if (wire.method === 'get')
      return { ok: false, status: 404, body: { error: 'not_found' } };
    const body = tryJsonParse(wire.body!) as {
      executionId: string;
      sourceOrder?: { version: number; revision: string };
    };
    return {
      ok: true,
      status: 202,
      body: {
        ...response(request, '1'),
        executionId: body.executionId,
        action: roomAction(actionName),
        sourceOrder: body.sourceOrder ?? null,
      },
    };
  });
  const tracer = {
    addActiveSpan: async (_: unknown, run: (span: unknown) => unknown) =>
      run({ setAttribute: () => {}, recordException: () => {} }),
  };
  const publisher = new ActionPublisher(
    { logActionExecutions: async () => {} } as never,
    tracer as never,
    fetchHTTP as never,
    {} as never,
    {
      getReviewableQueuesForUser: async () => [{ id: config.queueId }],
    } as never,
    {} as never,
    investigation as never,
    { applyUserStrikeFromPublishedActions: async () => {} } as never,
    {
      getGraphQLUserFromId: async () => ({
        ...actor,
        getPermissions: () => [],
      }),
    } as never,
    pgQuery,
  );
  const api = new ActionAPI(
    publisher,
    {
      getActions: async () => [action],
      getPoliciesByIds: async () => [],
    } as never,
    tracer as never,
    investigation as never,
    (async () => itemType) as never,
  );
  const bulk = {
    orgId: config.orgId,
    actorId: actor.id,
    actorEmail: 'synthetic@example.invalid',
    itemTypeId: request.itemTypeId,
    itemIds: [request.itemId],
    actionIds: [action.id],
    policyIds: [],
    actorNote: request.note,
  };
  const sendMrt = async () =>
    publisher.publishActions(
      [
        {
          action: action as never,
          policies: [],
          matchingRules: undefined,
          ruleEnvironment: undefined,
        },
      ],
      {
        orgId: config.orgId,
        targetItem: { itemId: request.itemId, itemType },
        correlationId: toCorrelationId({
          type: 'mrt-decision',
          id: request.correlationId.slice('mrt-decision:'.length),
        }),
        actorId: actor.id,
        actorNote: request.note,
      },
    );
  return { api, request, fetchHTTP, bulk, action, sendMrt, investigation };
}

export async function checkManualRoomClientReceipt(
  pgQuery: Kysely<MemberIntentPg>,
  actionName: string,
) {
  const { api, request, fetchHTTP, bulk, action } = roomActionFixture(
    pgQuery,
    actionName,
  );
  // Before this client fix, a brand-new browser v1 ID could only look up, never send.
  const legacy = await api.bulkExecuteActions({
    ...bulk,
    operationId: `source-order-v1_${roomAction(actionName)}_${randomUUID()}`,
  });
  expect(legacy[0][0].success).toBe(false);
  expect(
    fetchHTTP.mock.calls.filter(([wire]) => wire.method === 'post'),
  ).toHaveLength(0);
  const begin = {
    orgId: config.orgId,
    actorId: actor.id,
    clientNonce: randomUUID(),
    actionId: action.id,
    itemId: request.itemId,
    itemTypeId: request.itemTypeId,
    note: request.note!,
    parameters: {},
  };
  // Discard the first response, as if transport lost it, then retry the same immutable claim.
  const lost = await api.beginRoomOperation(begin);
  const recovered = await api.beginRoomOperation(begin);
  expect(recovered).toEqual(lost);
  await expect(
    api.beginRoomOperation({ ...begin, note: 'Changed reason' }),
  ).rejects.toThrow('nonce conflict');
  expect(
    await pgQuery
      .selectFrom('concord_integration.room_manual_operations')
      .select('operation_id')
      .where('client_nonce', '=', begin.clientNonce)
      .execute(),
  ).toEqual([{ operation_id: recovered.operationId }]);
  const sent = await api.bulkExecuteActions({
    ...bulk,
    operationId: recovered.operationId,
  });
  expect(sent[0][0].success).toBe(true);
  expect(
    fetchHTTP.mock.calls.filter(([wire]) => wire.method === 'post'),
  ).toHaveLength(1);
  const status = await api.beginRoomOperation(begin);
  expect(status).toMatchObject({
    operationId: recovered.operationId,
    phase: 'accepted',
    acceptanceUnknown: false,
  });
  expect(status.acceptedDecisionId).toBeTruthy();
}

export async function withRoomTestEnvironment(run: () => Promise<void>) {
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
  // eslint-disable-next-line functional/immutable-data -- Scoped test configuration is restored below.
  Object.assign(process.env, environment);
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      // eslint-disable-next-line functional/immutable-data -- Restore scoped test configuration.
      else process.env[key] = value;
    }
  }
}
