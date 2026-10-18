/* eslint-disable functional/immutable-data -- Tests deliberately vary authorization fixtures and record side-effect order. */
import { UserRole } from '../models/types/permissioning.js';
import { ActionType } from '../services/moderationConfigService/index.js';
import { toCorrelationId } from '../utils/correlationIds.js';
import { tryJsonParse } from '../utils/encoding.js';
import { ActionPublisher } from './ActionPublisher.js';

const config = {
  CONCORD_MODERATION_ORIGIN: 'https://moderation.example',
  CONCORD_ORG_ID: 'synthetic',
  CONCORD_MODERATION_HMAC_KEY: 'ab'.repeat(32),
  CONCORD_COOP_ORIGIN: 'https://coop.example',
  CONCORD_ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  CONCORD_ACCESS_AUDIENCE: 'audience',
  CONCORD_QUEUE_ID: 'room-queue',
};
const original = Object.fromEntries(
  Object.keys(config).map((key) => [key, process.env[key]]),
);
beforeAll(() => Object.assign(process.env, config));
afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});
test('manual membership rejects an invalid callback before durable registration', async () => {
  const register = jest.fn(async () => {});
  const query = {
    selectAll: () => query,
    where: () => query,
    executeTakeFirst: async () => undefined,
  };
  const fetchHTTP = jest.fn(async () => ({
    ok: true,
    status: 200,
    body: {
      caseId: '10000000-0000-4000-8000-000000000001',
      author: 'd'.repeat(64),
      target: {
        communityId: 'a'.repeat(64),
        channelId: 'b'.repeat(64),
        rumorId: 'c'.repeat(64),
      },
    },
  }));
  const publisher = new ActionPublisher(
    {} as never,
    {} as never,
    fetchHTTP as never,
    {} as never,
    { getReviewableQueuesForUser: async () => [{ id: 'room-queue' }] } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      getGraphQLUserFromId: async () => ({
        id: 'staff',
        orgId: 'synthetic',
        role: UserRole.ADMIN,
        approvedByAdmin: true,
        rejectedByAdmin: false,
        getPermissions: () => [],
      }),
    } as never,
    {
      selectFrom: () => query,
      transaction: () => ({ execute: register }),
    } as never,
  );
  await expect(
    Reflect.apply(publisher.recordManualRoomIntent, publisher, [
      {
        orgId: 'synthetic',
        actionId: 'ban',
        actionName: 'concord_ban_member',
        itemId: 'item',
        itemTypeId: 'room-type',
        itemTypeName: 'concord_member',
        caseId: '10000000-0000-4000-8000-000000000001',
        correlationId: 'manual-action-run:stable',
        actorId: 'staff',
        note: 'Synthetic reason',
        parameters: {},
      },
      'https://wrong-callback.example/v1/decisions',
    ]),
  ).rejects.toThrow();
  expect(register).not.toHaveBeenCalled();
  expect(fetchHTTP).not.toHaveBeenCalled();
});
test('actual publisher forwards trusted actor, reason and stable execution while dropping unrelated parameters', async () => {
  const actor = {
    id: 'staff',
    orgId: 'synthetic',
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
  const fetchHTTP = jest.fn(async () => ({
    ok: true,
    status: 202,
    body: status,
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
    { getReviewableQueuesForUser: async () => [{ id: 'room-queue' }] } as never,
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
  );
  const action = {
    id: 'action',
    orgId: 'synthetic',
    description: null,
    applyUserStrikes: false,
    penalty: 'NONE' as const,
    callbackUrlHeaders: null,
    callbackUrlBody: null,
    customMrtApiParams: null,
    actionType: ActionType.CUSTOM_ACTION,
    name: 'concord_remove_message',
    callbackUrl: config.CONCORD_MODERATION_ORIGIN + '/v1/decisions',
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
        orgId: 'synthetic',
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
  expect(requests[0][0].body).toBe(requests[1][0].body);
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
  ).toEqual(expect.objectContaining({ actorId: 'staff', orgId: 'synthetic' }));
  expect(await send()).toBe(false);
  expect(fetchHTTP).toHaveBeenCalledTimes(2);
  actor.approvedByAdmin = false;
  expect(await send('staff')).toBe(false);
  expect(fetchHTTP).toHaveBeenCalledTimes(2);
});
