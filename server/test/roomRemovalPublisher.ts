/* eslint-disable functional/immutable-data -- Authorization fixtures deliberately change between requests. */
import { type Kysely } from 'kysely';

import { UserRole } from '../models/types/permissioning.js';
import { type MemberIntentPg } from '../routes/concord/memberIntentTypes.js';
import { type RoomRequest } from '../routes/concord/service.js';
import { ActionPublisher } from '../rule_engine/ActionPublisher.js';
import { ActionType } from '../services/moderationConfigService/index.js';
import { toCorrelationId } from '../utils/correlationIds.js';
import { tryJsonParse } from '../utils/encoding.js';
import { config } from './memberIntentFixtures.js';

/** The publisher wire contract needs the real durable acceptance transaction. */
export async function checkRoomRemovalPublisher(
  pgQuery: Kysely<MemberIntentPg>,
) {
  const actor = {
    id: 'staff',
    orgId: config.orgId,
    role: UserRole.MODERATOR,
    approvedByAdmin: true,
    rejectedByAdmin: false,
    getPermissions: () => [],
  };
  const status = {
    decisionId: '10000000-0000-4000-8000-000000000002',
    action: 'remove_message',
    target: {
      communityId: 'a'.repeat(64),
      channelId: 'b'.repeat(64),
      rumorId: 'c'.repeat(64),
    },
    deliveries: ['divine_relay', 'concord', 'discord'].map((target) => ({
      target,
      state: 'pending',
      attempts: 0,
      resultCode: null,
    })),
  };
  const fetchHTTP = jest.fn(async (wire: RoomRequest) => ({
    ok: true,
    status: 202,
    body: {
      ...status,
      executionId: (tryJsonParse(wire.body!) as { executionId: string })
        .executionId,
    },
  }));
  const trace = {
    addActiveSpan: async (_: unknown, run: (span: unknown) => unknown) =>
      run({ setAttribute: () => {}, recordException: () => {} }),
  };
  const publisher = new ActionPublisher(
    { logActionExecutions: async () => {} } as never,
    trace as never,
    fetchHTTP as never,
    {} as never,
    {
      getReviewableQueuesForUser: async () => [{ id: config.queueId }],
    } as never,
    {} as never,
    {
      getItemByIdentifier: async () => ({
        latestSubmission: {
          data: { case_id: '10000000-0000-4000-8000-000000000001' },
        },
      }),
    } as never,
    { applyUserStrikeFromPublishedActions: async () => {} } as never,
    { getGraphQLUserFromId: async () => actor } as never,
    pgQuery,
  );
  const action = {
    id: 'action',
    orgId: config.orgId,
    description: null,
    applyUserStrikes: false,
    penalty: 'NONE' as const,
    callbackUrlHeaders: null,
    callbackUrlBody: null,
    customMrtApiParams: null,
    actionType: ActionType.CUSTOM_ACTION,
    name: 'concord_remove_message',
    callbackUrl: config.origin + '/v1/decisions',
  };
  const item = {
    itemId: 'item',
    itemType: { id: 'room-type', kind: 'CONTENT', name: 'concord_message' },
  } as const;
  const send = async (actorId?: string) => {
    const outcomes = await publisher.publishActions(
      [
        {
          action,
          policies: [],
          matchingRules: undefined,
          ruleEnvironment: undefined,
          customMrtApiParamDecisionPayload: {
            reportHistory: ['must not leave Coop'],
            actorId: 'forged',
          },
        },
      ],
      {
        orgId: config.orgId,
        targetItem: item,
        correlationId: toCorrelationId({ type: 'mrt-decision', id: 'stable' }),
        actorEmail: 'synthetic@example.invalid',
        decisionReason: 'Synthetic reason',
        actorId,
      },
    );
    return outcomes.every((outcome) => outcome.success);
  };
  expect(await send('staff')).toBe(true);
  expect(await send('staff')).toBe(true);
  const requests = fetchHTTP.mock.calls as unknown as [
    { body: string; headers: Record<string, string> },
  ][];
  expect(requests).toHaveLength(1);
  expect(tryJsonParse(requests[0][0].body)).toEqual(
    expect.objectContaining({
      reason: 'Synthetic reason',
      scope: 'message',
      action: 'remove_message',
    }),
  );
  expect(requests[0][0].body).not.toContain('reportHistory');
  expect(
    tryJsonParse(
      Buffer.from(requests[0][0].headers['x-coop-actor'], 'base64').toString(),
    ),
  ).toEqual(expect.objectContaining({ actorId: 'staff', orgId: config.orgId }));
  expect(await send()).toBe(false);
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
  actor.approvedByAdmin = false;
  expect(await send('staff')).toBe(false);
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
}
