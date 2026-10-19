import { type Kysely } from 'kysely';

import {
  claimManualRoomOperation,
  lockRoomExecution,
  manualRoomRequest,
  settleManualRoomOperation,
} from './manualRoomOperations.js';
import { deliverMemberIntent } from './memberIntents.js';
import {
  type MemberDeliveryOutcome,
  type MemberIntentDependencies,
  type MemberIntentPg,
} from './memberIntentTypes.js';
import {
  definitiveRoomRefusal,
  getRoomExecutionDisposition,
  recordPermanentRefusal,
} from './roomDispositions.js';
import {
  isServerRoomOperationId,
  parseRoomStatus,
  publishRoomDecision,
  roomAction,
  roomExecutionId,
  roomRequest,
  RoomResponseError,
  type ConcordConfig,
  type RoomDecisionInput,
} from './service.js';

export async function deliverManualRoomOperation(
  pg: Kysely<MemberIntentPg>,
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: RoomDecisionInput,
): Promise<MemberDeliveryOutcome> {
  const operationId = input.correlationId.slice('manual-action-run:'.length);
  if (!isServerRoomOperationId(operationId)) {
    // The legacy quarantine binds all immutable claims before lookup and never sends.
    return deliverMemberIntent(pg, config, dependencies, input);
  }
  const request = await manualRoomRequest(pg, dependencies, input);
  const disposition = await getRoomExecutionDisposition(
    pg,
    input.orgId,
    roomExecutionId(input),
  );
  if (disposition?.automationStopped)
    return {
      outcome: 'stopped',
      executionId: roomExecutionId(input),
      queueComplete: true,
      acceptanceUnknown: disposition.acceptanceUnknown,
    };
  const claim = await claimManualRoomOperation(pg, dependencies, {
    orgId: input.orgId,
    actorId: input.actorId!,
    operationId,
  });
  if (claim.kind === 'blocked' && !claim.status.successorExecutionId)
    throw new Error('Room operation blocked');
  const outcome =
    roomAction(input.actionName) !== 'remove_message'
      ? await deliverMemberIntent(pg, config, dependencies, request)
      : await deliverRemoval(pg, config, dependencies, request, claim.kind);
  await settleManualRoomOperation(pg, {
    orgId: input.orgId,
    executionId: roomExecutionId(input),
    outcome,
  });
  return outcome;
}
async function deliverRemoval(
  pg: Kysely<MemberIntentPg>,
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: RoomDecisionInput,
  claim: 'send' | 'lookup' | 'blocked',
): Promise<MemberDeliveryOutcome> {
  const executionId = roomExecutionId(input);
  const stored = await pg
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('org_id', '=', input.orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirstOrThrow();
  if (stored.accepted_status)
    return { outcome: 'accepted', status: stored.accepted_status };
  if (claim === 'lookup') {
    try {
      const status = parseRoomStatus(
        await roomRequest(
          config,
          dependencies.fetchHTTP,
          await dependencies.getActor(input.actorId!, input.orgId),
          'get',
          `/v1/decision-executions/${executionId}`,
        ),
      );
      return { outcome: 'accepted', status };
    } catch (error) {
      if (!(error instanceof RoomResponseError) || error.status !== 404)
        throw error;
      // A 404 is not cancellation. The sole permitted resend retains the exact
      // receipt identity and fingerprint, and never resets bridge delivery state.
      await pg.transaction().execute(async (tx) => {
        await lockRoomExecution(tx, input.orgId, executionId);
        const current = await tx
          .selectFrom('concord_integration.room_manual_operations')
          .selectAll()
          .where('org_id', '=', input.orgId)
          .where('execution_id', '=', executionId)
          .executeTakeFirstOrThrow();
        if (
          (await getRoomExecutionDisposition(tx, input.orgId, executionId))
            ?.automationStopped ||
          current.phase !== 'acceptance_unknown' ||
          current.accepted_decision_id
        )
          throw new Error('Room operation recovery state changed');
      });
    }
  }
  try {
    return {
      outcome: 'accepted',
      status: await publishRoomDecision(config, dependencies, input),
    };
  } catch (error) {
    if (!definitiveRoomRefusal(error, executionId)) throw error;
    await recordPermanentRefusal(pg, {
      orgId: input.orgId,
      executionId,
      refusalCode: 'decision_source_unavailable',
      sourceId: input.correlationId,
    });
    return {
      outcome: 'refused',
      executionId,
      refusalCode: 'decision_source_unavailable',
      queueComplete: true,
      acceptanceUnknown: false,
    };
  }
}
