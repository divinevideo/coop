/* eslint-disable functional/immutable-data -- Tests deliberately vary authorization fixtures and record side-effect order. */
import { UserRole } from '../models/types/permissioning.js';
import { memberIntentFingerprint } from '../routes/concord/memberIntents.js';
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
test.each([
  'callback',
  'unseen_legacy',
  'registered_legacy',
  'reason',
  'denied',
])(
  'manual membership validates recording configuration and generation: %s',
  async (kind) => {
    const input = {
      orgId: 'synthetic',
      actionId: 'ban',
      actionName: 'concord_ban_member',
      itemId: 'item',
      itemTypeId: 'room-type',
      itemTypeName: 'concord_member',
      caseId: '10000000-0000-4000-8000-000000000001',
      correlationId: ['reason', 'denied'].includes(kind)
        ? 'manual-action-run:source-order-v1_ban_member_10000000-0000-4000-8000-000000000002'
        : 'manual-action-run:10000000-0000-4000-8000-000000000002',
      actorId: 'staff',
      note: kind === 'reason' ? 'x'.repeat(2049) : 'Synthetic reason',
      parameters: {},
    };
    const prior = {
      case_id: input.caseId,
      target_key: 'a'.repeat(64),
      fingerprint: memberIntentFingerprint(input, 'a'.repeat(64)),
    };
    const register = jest.fn(async () => {});
    const query = {
      selectAll: () => query,
      where: () => query,
      executeTakeFirst: async () =>
        kind === 'registered_legacy' ? prior : undefined,
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
      {
        getReviewableQueuesForUser: async () => [{ id: 'room-queue' }],
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getGraphQLUserFromId: async () => ({
          id: 'staff',
          orgId: 'synthetic',
          role: UserRole.ADMIN,
          approvedByAdmin: kind !== 'denied',
          rejectedByAdmin: false,
          getPermissions: () => [],
        }),
      } as never,
      {
        selectFrom: () => query,
        transaction: () => ({ execute: register }),
      } as never,
    );
    const result = publisher.recordManualRoomIntent(
      input,
      kind === 'callback'
        ? 'https://wrong-callback.example/v1/decisions'
        : config.CONCORD_MODERATION_ORIGIN + '/v1/decisions',
    );
    if (['registered_legacy', 'unseen_legacy'].includes(kind))
      await expect(result).resolves.toBeUndefined();
    else if (kind === 'reason')
      await expect(result).rejects.toMatchObject({
        extensions: { roomAttemptOutcome: 'NOT_RECORDED' },
      });
    else if (kind === 'denied')
      await expect(result).rejects.toThrow('permission');
    else
      await expect(result).rejects.toThrow(
        kind === 'callback'
          ? 'configuration unavailable'
          : 'legacy manual operation',
      );
    expect(register).not.toHaveBeenCalled();
    expect(fetchHTTP).not.toHaveBeenCalled();
  },
);
