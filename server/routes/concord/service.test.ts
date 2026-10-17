/* eslint-disable functional/immutable-data -- Tests deliberately vary authorization fixtures and record side-effect order. */
import type { RoomRequest } from './service.js';

import { UserRole } from '../../models/types/permissioning.js';
import { tryJsonParse } from '../../utils/encoding.js';
import {
  loadConcordConfig,
  object,
  publishRoomDecision,
  roomPermissions,
} from './service.js';

const config = {
  origin: 'https://moderation.example',
  orgId: 'synthetic-org',
  hmacKey: 'ab'.repeat(32),
  coopOrigin: 'https://coop.example',
  accessIssuer: 'https://synthetic.cloudflareaccess.com',
  accessAudience: 'synthetic-audience',
  queueId: 'synthetic-queue',
};
const actor = {
  id: 'synthetic-staff',
  orgId: 'synthetic-org',
  role: UserRole.MODERATOR,
  approvedByAdmin: true,
  rejectedByAdmin: false,
};
const input = {
  orgId: 'synthetic-org',
  actionId: 'synthetic-action',
  actionName: 'concord_remove_message',
  itemId: 'synthetic-item',
  itemTypeId: 'synthetic-type',
  itemTypeName: 'concord_message',
  caseId: '10000000-0000-4000-8000-000000000001',
  correlationId: 'mrt-decision:synthetic-stable',
  actorId: actor.id,
  note: 'Synthetic decision',
  parameters: {},
};
test('ordinary reviewers cannot mint community or guild ban permission', () => {
  expect(roomPermissions(actor)).toContain('remove_message');
  expect(roomPermissions(actor)).not.toContain('ban_member');
  expect(roomPermissions(actor)).not.toContain('discord_guild_ban');
});
test('room actions preserve staff and execution identity across retries without logging evidence', async () => {
  const requests: unknown[] = [];
  const fetchHTTP = jest.fn(async (request) => {
    requests.push(request);
    return {
      ok: true,
      status: 202,
      body: {
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
      },
    };
  });
  const deps = { fetchHTTP, getActor: async () => actor };
  await publishRoomDecision(config, deps, input);
  await publishRoomDecision(config, deps, input);
  const first = fetchHTTP.mock.calls[0][0],
    second = fetchHTTP.mock.calls[1][0];
  expect(first.body).toBe(second.body);
  expect(first.logRequestAndResponseBody).toBe('NEVER');
  expect(first.url).toBe('https://moderation.example/v1/decisions');
  const headerActor = object(
    tryJsonParse(
      Buffer.from(first.headers['x-coop-actor'], 'base64').toString(),
    ),
  );
  expect(headerActor.actorId).toBe(actor.id);
  expect(headerActor.orgId).toBe(actor.orgId);
  expect(object(tryJsonParse(first.body)).executionId).toMatch(
    /^[0-9a-f-]{36}$/,
  );
});
test('missing actor, API-key impersonation, wrong org and malformed replies fail explicitly', async () => {
  const deps = {
    fetchHTTP: jest.fn(async () => ({ ok: true, status: 202, body: {} })),
    getActor: async () => actor,
  };
  await expect(
    publishRoomDecision(config, deps, { ...input, actorId: undefined }),
  ).rejects.toThrow();
  await expect(
    publishRoomDecision(config, deps, {
      ...input,
      correlationId: 'post-actions:synthetic',
    }),
  ).rejects.toThrow();
  await expect(
    publishRoomDecision(config, deps, { ...input, orgId: 'other' }),
  ).rejects.toThrow();
  await expect(publishRoomDecision(config, deps, input)).rejects.toThrow();
  await expect(
    publishRoomDecision(config, deps, {
      ...input,
      actionName: 'concord_ban_member',
    }),
  ).rejects.toThrow();
});

test('internal enforcement origin is fixed, never an arbitrary cleartext endpoint', () => {
  const env = {
    CONCORD_MODERATION_ORIGIN:
      'http://concord-moderation.armada-chat.svc.cluster.local:8080',
    CONCORD_COOP_ORIGIN: config.coopOrigin,
    CONCORD_ACCESS_ISSUER: config.accessIssuer,
    CONCORD_MODERATION_HMAC_KEY: config.hmacKey,
    CONCORD_ORG_ID: config.orgId,
    CONCORD_ACCESS_AUDIENCE: config.accessAudience,
    CONCORD_QUEUE_ID: config.queueId,
  };
  expect(loadConcordConfig(env).origin).toBe(env.CONCORD_MODERATION_ORIGIN);
  expect(() =>
    loadConcordConfig({
      ...env,
      CONCORD_MODERATION_ORIGIN: 'http://attacker.example',
    }),
  ).toThrow();
});

test('cross-cluster requests authenticate to Access without forwarding credentials on redirects', async () => {
  const fetchHTTP = jest.fn(
    async (_request: RoomRequest) => ({
      ok: true,
      status: 202,
      body: {
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
      },
    }),
  );
  await publishRoomDecision(
    {
      ...config,
      accessClientId: 'synthetic-id',
      accessClientSecret: 'synthetic-secret',
    },
    { fetchHTTP, getActor: async () => actor },
    input,
  );
  const request = fetchHTTP.mock.calls[0][0];
  expect(request.headers['CF-Access-Client-Id']).toBe('synthetic-id');
  expect(request.headers['CF-Access-Client-Secret']).toBe('synthetic-secret');
  expect(request.redirect).toBe('error');
  expect(request.logRequestAndResponseBody).toBe('NEVER');
});
