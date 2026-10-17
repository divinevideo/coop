import { UserRole } from '../../models/types/permissioning.js';
import {
  object,
  parseRoomStatus,
  publishRoomDecision,
  roomRequest,
} from './service.js';

const config = {
  origin: 'https://moderation.example',
  orgId: 'org',
  hmacKey: 'ab'.repeat(32),
  coopOrigin: 'https://coop.example',
  accessIssuer: 'https://test.cloudflareaccess.com',
  accessAudience: 'test',
  queueId: 'queue',
};
const actor = {
  id: 'staff',
  orgId: 'org',
  role: UserRole.ADMIN,
  approvedByAdmin: true,
  rejectedByAdmin: false,
};
test('new membership publication requires a durable registration', async () => {
  const fetchHTTP = jest.fn();
  await expect(
    publishRoomDecision(
      config,
      { fetchHTTP, getActor: async () => actor },
      {
        orgId: 'org',
        actionId: 'action',
        actionName: 'concord_ban_member',
        itemId: 'item',
        itemTypeId: 'type',
        itemTypeName: 'concord_member',
        caseId: '10000000-0000-4000-8000-000000000001',
        correlationId: 'mrt-decision:job',
        actorId: actor.id,
        note: 'Synthetic reason',
      },
    ),
  ).rejects.toThrow('registered');
  expect(fetchHTTP).not.toHaveBeenCalled();
});
test('typed bridge supersession is preserved before generic delivery errors', async () => {
  const executionId = '10000000-0000-4000-8000-000000000001';
  const fetchHTTP = jest.fn(async () => ({
    ok: false,
    status: 409,
    body: {
      error: 'member_intent_superseded',
      executionId,
      currentRevision: '42',
      supersededByExecutionId: '10000000-0000-4000-8000-000000000002',
    },
  }));
  await expect(
    roomRequest(config, fetchHTTP, actor, 'post', '/v1/decisions', {}),
  ).rejects.toMatchObject({ code: 'member_intent_superseded', status: 409 });
});
test('status retains exact source order and legacy null', () => {
  const status = {
    decisionId: '10000000-0000-4000-8000-000000000001',
    executionId: '10000000-0000-4000-8000-000000000002',
    sourceOrder: { version: 1, revision: '9223372036854775807' },
    action: 'ban_member',
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
  expect(object(parseRoomStatus(status)).sourceOrder).toEqual(
    status.sourceOrder,
  );
  expect(
    object(parseRoomStatus({ ...status, sourceOrder: null })).sourceOrder,
  ).toBeNull();
  for (const revision of ['0', '01', '9223372036854775808', '1.5'])
    expect(() =>
      parseRoomStatus({ ...status, sourceOrder: { version: 1, revision } }),
    ).toThrow();
});
