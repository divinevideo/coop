import { createHash } from 'node:crypto';

import { jsonStringify } from '../../utils/encoding.js';
import {
  type MemberIntentDependencies,
  type PreparedMemberIntent,
} from './memberIntentTypes.js';
import {
  object,
  roomAction,
  roomExecutionId,
  roomRequest,
  UUID,
  validateRoomActionPermission,
  validRoomReason,
  type ConcordConfig,
  type RoomDecisionInput,
} from './service.js';

export function memberTargetKey(
  orgId: string,
  communityId: string,
  author: string,
) {
  return createHash('sha256')
    .update(jsonStringify([orgId, communityId, author]))
    .digest('hex');
}
export async function prepareMemberIntent(
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: RoomDecisionInput,
): Promise<PreparedMemberIntent> {
  const action = roomAction(input.actionName);
  if (
    (action !== 'ban_member' && action !== 'unban_member') ||
    !['concord_message', 'concord_member'].includes(input.itemTypeName) ||
    !input.actorId ||
    input.orgId !== config.orgId ||
    !UUID.test(input.caseId) ||
    !validRoomReason(input.note) ||
    !/^(mrt-decision|manual-action-run):.+/.test(input.correlationId)
  )
    throw new Error('Invalid membership staff intent');
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  validateRoomActionPermission(actor, input.actionName, input.parameters ?? {});
  const response = object(
    await roomRequest(
      config,
      dependencies.fetchHTTP,
      actor,
      'get',
      `/v1/cases/${input.caseId}`,
    ),
  );
  const target = object(response.target);
  if (
    response.caseId !== input.caseId ||
    typeof response.author !== 'string' ||
    !/^[0-9a-f]{64}$/.test(response.author) ||
    !['communityId', 'channelId', 'rumorId'].every(
      (key) =>
        typeof target[key] === 'string' &&
        /^[0-9a-f]{64}$/.test(String(target[key])),
    )
  )
    throw new Error('Invalid authoritative room case target');
  const targetKey = memberTargetKey(
    input.orgId,
    String(target.communityId),
    response.author,
  );
  const executionId = roomExecutionId(input);
  const fingerprint = memberIntentFingerprint(input, targetKey);
  return { input, targetKey, executionId, fingerprint, action };
}
export function memberIntentFingerprint(
  input: RoomDecisionInput,
  targetKey: string,
) {
  return createHash('sha256')
    .update(jsonStringify([targetKey, input]))
    .digest('hex');
}
