/* eslint-disable functional/immutable-data -- Authorization boundary fixtures vary deliberately. */
import { randomUUID } from 'node:crypto';

import { UserRole } from '../../models/types/permissioning.js';
import {
  actor,
  config,
  input,
  response,
} from '../../test/memberIntentFixtures.js';
import { prepareReversalMemberIntent } from './memberIntentIdentity.js';
import { roomLifecycleHandler } from './roomLifecycle.js';
import {
  parseRoomStatus,
  roomExecutionId,
  roomPermissions,
  roomRequest,
  type RoomRequest,
} from './service.js';

const prior = '10000000-0000-4000-8000-000000000001';
test.each(['org', 'permission', 'forged_target', 'wrong_prior'])(
  'reversal rejects %s before registration',
  async (kind) => {
    const { caseId: _, ...base } = input('concord_unban_member');
    const request = {
      ...base,
      priorDecisionId: prior,
      orgId: kind === 'org' ? 'other' : config.orgId,
    };
    await expect(
      prepareReversalMemberIntent(
        config,
        {
          getActor: async () => ({
            ...actor,
            role: kind === 'permission' ? UserRole.MODERATOR : UserRole.ADMIN,
          }),
          fetchHTTP: async () => ({
            ok: true,
            status: 200,
            body: {
              decisionId: kind === 'wrong_prior' ? randomUUID() : prior,
              caseId: randomUUID(),
              action: 'ban_member',
              communityId: kind === 'forged_target' ? 'forged' : 'a'.repeat(64),
              channelId: 'b'.repeat(64),
              rumorId: 'c'.repeat(64),
              author: 'd'.repeat(64),
              discordGuildConfirmed: true,
            },
          }),
        },
        request,
      ),
    ).rejects.toThrow();
  },
);
test('restriction observation survives status parsing independently from enforcement delivery', () => {
  const request = input();
  const status = {
    ...response(request, '1'),
    executionId: roomExecutionId(request),
    discordRestriction: {
      state: 'present',
      checkedAt: '2026-10-19T00:00:00Z',
      code: 'guild_ban_present',
    },
    auditAvailable: false,
  };
  expect(parseRoomStatus(status)).toEqual(status);
  expect(
    roomPermissions({ ...actor, role: UserRole.MODERATOR_MANAGER }),
  ).not.toContain('view_held_evidence');
  expect(roomPermissions(actor)).toEqual(
    expect.arrayContaining(['view_held_evidence', 'manage_moderation_records']),
  );
});
function fixture(operation: string, role: UserRole = UserRole.ADMIN) {
  const staff = {
    ...actor,
    role,
    email: 'staff@example.invalid',
    getPermissions: () => [],
  };
  const accepted = response(input(), '1');
  const fetchHTTP = jest.fn(async (_wire: RoomRequest) => ({
    ok: true,
    status: 202,
    body: accepted as unknown,
  }));
  const deps = {
    fetchHTTP,
    UserAPIDataSource: { getGraphQLUserFromId: async () => staff },
    ManualReviewToolService: {
      getReviewableQueuesForUser: async () => [{ id: config.queueId }],
    },
    ItemInvestigationService: {
      getItemByIdentifier: jest.fn(async () => {
        throw new Error('Expired case');
      }),
    },
  };
  const env = {
    CONCORD_MODERATION_ORIGIN: config.origin,
    CONCORD_ORG_ID: config.orgId,
    CONCORD_MODERATION_HMAC_KEY: config.hmacKey,
    CONCORD_COOP_ORIGIN: config.coopOrigin,
    CONCORD_ACCESS_ISSUER: config.accessIssuer,
    CONCORD_ACCESS_AUDIENCE: config.accessAudience,
    CONCORD_QUEUE_ID: config.queueId,
  };
  const req = {
    isAuthenticated: () => true,
    user: { id: actor.id, orgId: actor.orgId },
    method: operation ? 'POST' : 'GET',
    params: { resource: 'decisions', id: prior, operation },
    body: {},
    get: (key: string) => (key === 'origin' ? config.coopOrigin : 'access'),
  };
  const res = {
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const verify = jest.fn(async () => {});
  return {
    req,
    res,
    deps,
    fetchHTTP,
    verify,
    run: () =>
      roomLifecycleHandler(deps as never, env, verify)(
        req as never,
        res as never,
        jest.fn(),
      ),
  };
}
test('decision status remains accessible after evidence expiry without reading stored content', async () => {
  const f = fixture('');
  await f.run();
  expect(f.res.json).toHaveBeenCalledWith(
    expect.objectContaining({ decisionId: expect.any(String) }),
  );
  expect(
    f.deps.ItemInvestigationService.getItemByIdentifier,
  ).not.toHaveBeenCalled();
  expect(f.verify).toHaveBeenCalledWith('access', 'staff@example.invalid');
});
test('publication refresh forwards only the authenticated command and returns asynchronous status', async () => {
  const f = fixture('publication-refresh');
  await f.run();
  expect(f.res.status).toHaveBeenCalledWith(202);
  expect(f.fetchHTTP.mock.calls[0][0].url).toBe(
    `${config.origin}/v1/decisions/${prior}/publication-refresh`,
  );
});
test('held evidence requires separate current ADMIN capability and a bounded audit reason', async () => {
  const f = fixture('held-evidence', UserRole.MODERATOR_MANAGER);
  f.req.params.resource = 'cases';
  await f.run();
  expect(f.res.status).toHaveBeenCalledWith(403);
  expect(f.fetchHTTP).not.toHaveBeenCalled();
  const allowed = fixture('held-evidence');
  allowed.req.params.resource = 'cases';
  allowed.req.body = { reason: 'Authorized held record review' };
  await allowed.run();
  expect(allowed.fetchHTTP.mock.calls[0][0].url).toBe(
    `${config.origin}/v1/cases/${prior}/held-evidence`,
  );
});

test('hold creation accepts the bridge 201 response for the hold route only', async () => {
  const hold = {
    holdId: randomUUID(),
    caseId: prior,
    holdUntil: '2026-11-01T00:00:00Z',
    releasedAt: null,
  };
  const deps = async () => ({ ok: true, status: 201, body: hold });
  await expect(
    roomRequest(config, deps, actor, 'post', `/v1/cases/${prior}/holds`, {
      reason: 'Preserve appeal evidence',
      holdUntil: hold.holdUntil,
    }),
  ).resolves.toEqual(hold);
  await expect(
    roomRequest(config, deps, actor, 'get', `/v1/decisions/${prior}`),
  ).rejects.toThrow();
});
