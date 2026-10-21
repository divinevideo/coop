/* eslint-disable functional/immutable-data -- Tests deliberately vary authorization fixtures and record side-effect order. */ import {
  getPermissionsForRole,
  UserRole,
} from '../../services/userManagementService/index.js';
import { roomHandler } from './index.js';

const caseId = '10000000-0000-4000-8000-000000000001';
const decisionId = '10000000-0000-4000-8000-000000000002';
const env = {
  CONCORD_MODERATION_ORIGIN: 'https://moderation.example',
  CONCORD_ORG_ID: 'org',
  CONCORD_MODERATION_HMAC_KEY: 'ab'.repeat(32),
  CONCORD_COOP_ORIGIN: 'https://coop.example',
  CONCORD_ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
  CONCORD_ACCESS_AUDIENCE: 'audience',
  CONCORD_QUEUE_ID: 'room-queue',
};
function fixture() {
  const actor = {
    id: 'staff',
    orgId: 'org',
    email: 'synthetic@example.invalid',
    role: UserRole.MODERATOR,
    approvedByAdmin: true,
    rejectedByAdmin: false,
    getPermissions() {
      return getPermissionsForRole(this.role);
    },
  };
  const decision = {
    decisionId,
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
  const data = {
    caseId,
    evidenceAvailable: true,
    content: 'Synthetic evidence',
    reason: 'Synthetic report',
    expiresAt: '2030-01-01T00:00:00Z',
    decisions: [decision],
  };
  const deps = {
    fetchHTTP: jest.fn(async () => ({
      ok: true,
      status: 200,
      body: data,
    })),
    getItemTypeEventuallyConsistent: jest.fn(async () => ({
      name: 'concord_message',
    })),
    UserAPIDataSource: { getGraphQLUserFromId: jest.fn(async () => actor) },
    ManualReviewToolService: {
      getReviewableQueuesForUser: jest.fn(async () => [{ id: 'room-queue' }]),
    },
    ItemInvestigationService: {
      getItemByIdentifier: jest.fn(async () => ({
        latestSubmission: { data: { case_id: caseId } },
      })),
    },
  };
  const verify = jest.fn(async () => {});
  const handler = roomHandler(deps as never, env, verify);
  const request = {
    method: 'GET',
    params: { typeId: 'type', itemId: 'item', decisionId },
    user: { id: 'staff', orgId: 'org' },
    isAuthenticated: () => true,
    get: (name: string) =>
      name === 'origin' ? env.CONCORD_COOP_ORIGIN : 'synthetic-access-token',
  };
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  return {
    actor,
    data,
    decision,
    deps,
    verify,
    request,
    response,
    run: () => handler(request as never, response as never, jest.fn()),
  };
}
test('staff reads use the stored case reference and verify session, organization, queue and Access identity', async () => {
  const f = fixture();
  await f.run();
  expect(f.verify).toHaveBeenCalledWith(
    'synthetic-access-token',
    'synthetic@example.invalid',
  );
  expect(f.deps.fetchHTTP.mock.calls[0]).toBeDefined();
  expect(f.response.json).toHaveBeenCalledWith(
    expect.objectContaining({
      applicable: true,
      caseId,
      decisions: [f.decision],
    }),
  );
  expect(f.response.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
});
test.each(['session', 'org', 'queue', 'role', 'access', 'origin'])(
  'rejects invalid %s before forwarding evidence',
  async (boundary) => {
    const f = fixture();
    if (boundary === 'session') f.request.isAuthenticated = () => false;
    if (boundary === 'org') f.request.user.orgId = 'other';
    if (boundary === 'queue')
      f.deps.ManualReviewToolService.getReviewableQueuesForUser.mockResolvedValue(
        [],
      );
    if (boundary === 'role') f.actor.approvedByAdmin = false;
    if (boundary === 'access')
      f.verify.mockRejectedValue(new Error('Invalid Access token'));
    if (boundary === 'origin') {
      f.request.method = 'POST';
      f.request.get = () => 'https://untrusted.example';
    }
    await f.run();
    expect(f.response.status).toHaveBeenCalledWith(403);
    expect(f.deps.fetchHTTP).not.toHaveBeenCalled();
  },
);
test('a reviewer cannot retry a ban, or a decision belonging to another case', async () => {
  for (const mismatch of ['action', 'case']) {
    const f = fixture();
    f.request.method = 'POST';
    if (mismatch === 'action') f.decision.action = 'ban_member';
    else f.request.params.decisionId = '10000000-0000-4000-8000-000000000003';
    await f.run();
    expect(f.response.status).toHaveBeenCalledWith(403);
    expect(f.deps.fetchHTTP).toHaveBeenCalledTimes(1);
  }
});
test('authorized retry returns accepted status without claiming enforcement', async () => {
  const f = fixture();
  f.request.method = 'POST';
  f.deps.fetchHTTP
    .mockResolvedValueOnce({ ok: true, status: 200, body: f.data })
    .mockResolvedValueOnce({ ok: true, status: 202, body: f.decision });
  await f.run();
  expect(f.response.status).toHaveBeenCalledWith(202);
  expect(f.response.json).toHaveBeenCalledWith({
    applicable: true,
    decision: f.decision,
  });
});

test('expired evidence keeps enforcement results visible without retaining report text', async () => {
  const f = fixture();
  f.deps.fetchHTTP.mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      ...f.data,
      evidenceAvailable: false,
      content: null,
      reason: null,
      expiresAt: null,
    },
  });
  await f.run();
  expect(f.response.json).toHaveBeenCalledWith(
    expect.objectContaining({
      applicable: true,
      evidenceAvailable: false,
      content: null,
      decisions: [f.decision],
    }),
  );
});
