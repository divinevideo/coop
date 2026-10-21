import { randomUUID } from 'node:crypto';

import {
  prepareMemberIntent,
  type PreparedMemberIntent,
} from '../routes/concord/memberIntents.js';
import {
  roomExecutionId,
  type RoomDecisionInput,
  type RoomStatus,
} from '../routes/concord/service.js';
import {
  getPermissionsForRole,
  UserRole,
} from '../services/userManagementService/index.js';

export const config = {
  origin: 'https://moderation.example',
  orgId: 'synthetic-org',
  hmacKey: 'ab'.repeat(32),
  coopOrigin: 'https://coop.example',
  accessIssuer: 'https://test.cloudflareaccess.com',
  accessAudience: 'test',
  queueId: 'queue',
};
export const actor = {
  id: 'synthetic-staff',
  orgId: config.orgId,
  getPermissions() {
    return getPermissionsForRole(this.role);
  },
  role: UserRole.ADMIN,
  approvedByAdmin: true,
  rejectedByAdmin: false,
};
export const getActor = async () => actor;
export const response = (
  input: RoomDecisionInput,
  revision: string,
): RoomStatus => ({
  executionId: roomExecutionId(input),
  sourceOrder: { version: 1, revision },
  decisionId: randomUUID(),
  action:
    input.actionName === 'concord_ban_member' ? 'ban_member' : 'unban_member',
  target: {
    communityId: 'a'.repeat(64),
    channelId: 'b'.repeat(64),
    rumorId: 'c'.repeat(64),
  },
  deliveries: ['divine_relay', 'concord', 'discord'].map((target) => ({
    target: target as 'concord',
    state: 'pending',
    attempts: 0,
    resultCode: null,
  })),
});
export const input = (
  action = 'concord_ban_member',
): RoomDecisionInput & { caseId: string } => ({
  orgId: config.orgId,
  actionId: action,
  actionName: action,
  itemId: 'synthetic-item',
  itemTypeId: 'synthetic-type',
  itemTypeName: 'concord_member',
  caseId: randomUUID(),
  correlationId: `mrt-decision:${randomUUID()}`,
  actorId: actor.id,
  note: 'Synthetic reason',
  parameters: {},
});
export async function prepared(
  value: RoomDecisionInput,
  author = 'd'.repeat(64),
): Promise<PreparedMemberIntent> {
  return prepareMemberIntent(
    config,
    {
      getActor,
      fetchHTTP: async () => ({
        ok: true,
        status: 200,
        body: {
          caseId: value.caseId,
          author,
          target: {
            communityId: 'a'.repeat(64),
            channelId: 'b'.repeat(64),
            rumorId: 'c'.repeat(64),
          },
        },
      }),
    },
    value,
  );
}
