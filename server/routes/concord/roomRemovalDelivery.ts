import { createHash } from 'node:crypto';
import { type Kysely } from 'kysely';

import { jsonStringify } from '../../utils/encoding.js';
import { makeKyselyTransactionWithRetry } from '../../utils/kyselyTransactionWithRetry.js';
import { lockRoomExecution } from './manualRoomOperations.js';
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
  parseRoomStatus,
  publishRoomDecision,
  roomExecutionId,
  validateRoomActionPermission,
  type ConcordConfig,
  type RoomDecisionInput,
  type RoomStatus,
} from './service.js';

const fingerprint = (input: RoomDecisionInput) =>
  createHash('sha256').update(jsonStringify(input)).digest('hex');
export async function storedRoomRemoval(
  pg: Kysely<MemberIntentPg>,
  orgId: string,
  executionId: string,
) {
  return pg
    .selectFrom('concord_integration.room_execution_acceptances')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
}
function validatedAcceptance(input: RoomDecisionInput, value: RoomStatus) {
  const status = parseRoomStatus(value);
  if (
    input.actionName !== 'concord_remove_message' ||
    !input.correlationId.startsWith('mrt-decision:') ||
    status.executionId !== roomExecutionId(input) ||
    status.action !== 'remove_message' ||
    status.sourceOrder != null
  )
    throw new Error('Mismatched removal acceptance');
  return status;
}
function replay(
  input: RoomDecisionInput,
  row: NonNullable<Awaited<ReturnType<typeof storedRoomRemoval>>>,
) {
  if (
    row.source_id !== input.correlationId ||
    row.fingerprint !== fingerprint(input) ||
    jsonStringify(row.request_payload) !== jsonStringify(input)
  )
    throw new Error('Removal acceptance request conflict');
  const status = validatedAcceptance(input, row.accepted_status);
  if (status.decisionId !== row.accepted_decision_id)
    throw new Error('Removal acceptance identity conflict');
  return status;
}
/** Append only a validated exact-execution response; lost/404 responses never settle. */
export async function recordRoomRemovalAcceptance(
  pg: Kysely<MemberIntentPg>,
  input: RoomDecisionInput,
  value: RoomStatus,
) {
  const status = validatedAcceptance(input, value);
  return makeKyselyTransactionWithRetry(pg)(async (tx) => {
    await lockRoomExecution(tx, input.orgId, roomExecutionId(input));
    const existing = await storedRoomRemoval(
      tx,
      input.orgId,
      roomExecutionId(input),
    );
    if (existing) {
      const accepted = replay(input, existing);
      if (accepted.decisionId !== status.decisionId)
        throw new Error('Removal acceptance identity conflict');
      return accepted;
    }
    await tx
      .insertInto('concord_integration.room_execution_acceptances')
      .values({
        org_id: input.orgId,
        execution_id: roomExecutionId(input),
        source_id: input.correlationId,
        fingerprint: fingerprint(input),
        request_payload: input,
        accepted_decision_id: status.decisionId,
        accepted_status: status,
      })
      .execute();
    return status;
  });
}
export async function deliverMrtRemoval(
  pg: Kysely<MemberIntentPg>,
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: RoomDecisionInput,
): Promise<MemberDeliveryOutcome> {
  if (
    input.actionName !== 'concord_remove_message' ||
    !input.correlationId.startsWith('mrt-decision:') ||
    input.orgId !== config.orgId
  )
    throw new Error('Recorded MRT removal required');
  validateRoomActionPermission(
    await dependencies.getActor(input.actorId ?? '', input.orgId),
    input.actionName,
    input.parameters ?? {},
  );
  const executionId = roomExecutionId(input);
  const existing = await storedRoomRemoval(pg, input.orgId, executionId);
  if (existing) return { outcome: 'accepted', status: replay(input, existing) };
  const disposition = await getRoomExecutionDisposition(
    pg,
    input.orgId,
    executionId,
  );
  if (disposition?.automationStopped)
    return {
      outcome: 'stopped',
      executionId,
      queueComplete: true,
      acceptanceUnknown: disposition.acceptanceUnknown,
    };
  try {
    const status = await publishRoomDecision(config, dependencies, input);
    return {
      outcome: 'accepted',
      status: await recordRoomRemovalAcceptance(pg, input, status),
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
