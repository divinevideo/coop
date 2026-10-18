import { type Kysely } from 'kysely';

import { type MemberIntentPg } from './memberIntentTypes.js';
import { type RoomStatus } from './service.js';

type AcceptanceFacts = {
  last_attempt_at: Date | null;
  accepted_decision_id: string | null;
  bridge_superseded_by_execution_id: string | null;
};
export function memberIntentAcceptanceUnknown(
  intent: AcceptanceFacts,
): boolean {
  return (
    intent.last_attempt_at !== null &&
    intent.accepted_decision_id === null &&
    intent.bridge_superseded_by_execution_id === null
  );
}
export async function memberIntentStatuses(
  pg: Kysely<MemberIntentPg> | undefined,
  orgId: string,
  caseId: string,
) {
  if (!pg) return [];
  const intents = await pg
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('case_id', '=', caseId)
    .execute();
  return intents.map((intent) => ({
    executionId: intent.execution_id,
    sourceOrder: { version: 1 as const, revision: intent.revision },
    deliveryState: intent.delivery_state,
    acceptedDecisionId: intent.accepted_decision_id,
    supersededByExecutionId:
      intent.superseded_by_execution_id ??
      intent.bridge_superseded_by_execution_id,
    acceptanceUnknown: memberIntentAcceptanceUnknown(intent),
  }));
}

export function assertMemberIntentStatus(
  status: RoomStatus,
  intent: { execution_id: string; action: string; revision: string },
) {
  if (
    status.executionId !== intent.execution_id ||
    status.action !== intent.action ||
    status.sourceOrder?.version !== 1 ||
    status.sourceOrder?.revision !== intent.revision
  )
    throw new MemberIntentReconciliationError(
      'Mismatched membership reconciliation',
    );
}

export class MemberIntentReconciliationError extends Error {}
