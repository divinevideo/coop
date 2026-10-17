import { type Kysely } from 'kysely';

import {
  type MemberIntentDependencies,
  type MemberIntentPg,
} from './memberIntentTypes.js';
import {
  parseRoomStatus,
  roomAction,
  roomExecutionId,
  roomRequest,
  validateRoomActionPermission,
  type ConcordConfig,
  type RoomDecisionInput,
  type RoomStatus,
} from './service.js';

/** Reconcile a quarantined pre-cutover execution without assigning it new order. */
export async function reconcileLegacyMemberIntent(
  pg: Kysely<MemberIntentPg>,
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: RoomDecisionInput,
): Promise<RoomStatus> {
  const executionId = roomExecutionId(input);
  if (!input.actorId) throw new Error('Original staff actor required');
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  validateRoomActionPermission(actor, input.actionName, input.parameters ?? {});
  const status = parseRoomStatus(
    await roomRequest(
      config,
      dependencies.fetchHTTP,
      actor,
      'get',
      `/v1/decision-executions/${executionId}`,
    ),
  );
  if (
    status.executionId !== executionId ||
    status.action !== roomAction(input.actionName) ||
    status.sourceOrder !== null
  )
    throw new Error(
      'Legacy execution or source counter requires reconciliation',
    );
  await pg
    .updateTable('concord_integration.member_intent_quarantine')
    .set({ accepted_decision_id: status.decisionId, accepted_status: status })
    .where('org_id', '=', input.orgId)
    .where('execution_id', '=', executionId)
    .execute();
  return status;
}
