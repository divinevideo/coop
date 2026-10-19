import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { UserRole } from '../../models/types/permissioning.js';
import { jsonStringify } from '../../utils/encoding.js';
import { type ManualRoomOperationStatus } from './manualRoomOperationTypes.js';
import {
  type MemberDeliveryOutcome,
  type MemberIntentDependencies,
  type MemberIntentPg,
} from './memberIntentTypes.js';
import {
  MANUAL_ROOM_OPERATION_PREFIX,
  roomAction,
  roomExecutionId,
  UUID,
  validateRoomActionPermission,
  validRoomReason,
  type ConcordConfig,
  type RoomDecisionInput,
} from './service.js';

export type ManualOperationAccess = {
  orgId: string;
  actorId: string;
  operationId: string;
};
export async function lockRoomExecution(
  pg: Kysely<MemberIntentPg>,
  orgId: string,
  executionId: string,
) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${jsonStringify([orgId, executionId])}, 0))`.execute(
    pg,
  );
}
function fingerprint(request: Omit<RoomDecisionInput, 'correlationId'>) {
  return createHash('sha256').update(jsonStringify(request)).digest('hex');
}
async function authorizedReceipt(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  access: ManualOperationAccess,
) {
  const actor = await dependencies.getActor(access.actorId, access.orgId);
  const receipt = await pg
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('org_id', '=', access.orgId)
    .where('operation_id', '=', access.operationId)
    .executeTakeFirst();
  if (
    !receipt ||
    actor.orgId !== access.orgId ||
    actor.id !== access.actorId ||
    (receipt.actor_id !== actor.id && actor.role !== UserRole.ADMIN)
  )
    throw new Error('Room operation unavailable');
  return receipt;
}
async function statusOf(
  pg: Kysely<MemberIntentPg>,
  receipt: Awaited<ReturnType<typeof authorizedReceipt>>,
): Promise<ManualRoomOperationStatus> {
  const intent = await pg
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('org_id', '=', receipt.org_id)
    .where('execution_id', '=', receipt.execution_id)
    .executeTakeFirst();
  const recorded = Boolean(intent);
  const acceptedDecisionId =
    receipt.accepted_decision_id ?? intent?.accepted_decision_id ?? null;
  const attempted =
    receipt.attempted_at !== null || intent?.last_attempt_at != null;
  const successorExecutionId =
    intent?.superseded_by_execution_id ??
    intent?.bridge_superseded_by_execution_id ??
    null;
  const phase =
    receipt.phase === 'prepared' && recorded ? 'registered' : receipt.phase;
  const acceptanceUnknown =
    attempted &&
    !acceptedDecisionId &&
    !receipt.refusal_code &&
    !intent?.bridge_superseded_by_execution_id;
  return {
    operationId: receipt.operation_id,
    executionId: receipt.execution_id,
    phase,
    recorded,
    acceptanceUnknown,
    acceptedDecisionId,
    sourceOrder: intent ? { version: 1, revision: intent.revision } : null,
    refusalCode: receipt.refusal_code,
    disposition: receipt.refusal_code ? 'needs_attention' : 'none',
    successorExecutionId,
    allowedNextActions:
      phase === 'retired'
        ? ['replace']
        : !attempted && !recorded
          ? ['send', 'retire']
          : acceptanceUnknown
            ? ['recover']
            : [],
  };
}
export async function beginManualRoomOperation(
  pg: Kysely<MemberIntentPg>,
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: {
    orgId: string;
    actorId: string;
    clientNonce: string;
    request: Omit<RoomDecisionInput, 'correlationId'>;
  },
): Promise<ManualRoomOperationStatus> {
  const { request } = input;
  const action = roomAction(request.actionName);
  if (
    !UUID.test(input.clientNonce) ||
    !action ||
    request.orgId !== input.orgId ||
    input.orgId !== config.orgId ||
    request.actorId !== input.actorId ||
    !UUID.test(request.caseId) ||
    !request.itemId ||
    !request.itemTypeId ||
    !request.actionId ||
    !['concord_message', 'concord_member'].includes(request.itemTypeName) ||
    !validRoomReason(request.note)
  )
    throw new Error('Invalid manual room operation');
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  if (actor.id !== input.actorId || actor.orgId !== input.orgId)
    throw new Error('Room actor conflict');
  validateRoomActionPermission(
    actor,
    request.actionName,
    request.parameters ?? {},
  );
  const operationId = `${MANUAL_ROOM_OPERATION_PREFIX}${action}_${randomUUID()}`;
  const payload = {
    ...request,
    correlationId: `manual-action-run:${operationId}`,
  };
  return pg.transaction().execute(async (tx) => {
    await tx
      .insertInto('concord_integration.room_manual_operations')
      .values({
        org_id: input.orgId,
        execution_id: roomExecutionId(payload),
        operation_id: operationId,
        actor_id: input.actorId,
        client_nonce: input.clientNonce,
        item_id: request.itemId,
        item_type_id: request.itemTypeId,
        action,
        case_id: request.caseId,
        fingerprint: fingerprint(request),
        request_payload: payload,
        phase: 'prepared',
        accepted_decision_id: null,
        accepted_status: null,
        refusal_code: null,
        attempted_at: null,
        retired_at: null,
        retiring_actor: null,
        retirement_audit: null,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'actor_id', 'client_nonce']).doNothing(),
      )
      .execute();
    const receipt = await tx
      .selectFrom('concord_integration.room_manual_operations')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('actor_id', '=', input.actorId)
      .where('client_nonce', '=', input.clientNonce)
      .executeTakeFirstOrThrow();
    if (receipt.fingerprint !== fingerprint(request))
      throw new Error('Room operation nonce conflict');
    return statusOf(tx, receipt);
  });
}
export async function getManualRoomOperation(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  access: ManualOperationAccess,
) {
  return statusOf(pg, await authorizedReceipt(pg, dependencies, access));
}
export async function retirePreparedManualRoomOperation(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  access: ManualOperationAccess & { reason: string },
) {
  if (!validRoomReason(access.reason))
    throw new Error('Invalid retirement reason');
  const initial = await authorizedReceipt(pg, dependencies, access);
  return pg.transaction().execute(async (tx) => {
    await lockRoomExecution(tx, access.orgId, initial.execution_id);
    const receipt = await authorizedReceipt(tx, dependencies, access);
    const status = await statusOf(tx, receipt);
    if (receipt.phase === 'retired') return status;
    if (
      status.recorded ||
      receipt.attempted_at ||
      !['prepared', 'refused'].includes(receipt.phase)
    )
      throw new ManualRoomOperationConflict(status);
    const updated = await tx
      .updateTable('concord_integration.room_manual_operations')
      .set({
        phase: 'retired',
        retired_at: new Date(),
        retiring_actor: access.actorId,
        retirement_audit: access.reason,
        updated_at: new Date(),
      })
      .where('org_id', '=', access.orgId)
      .where('execution_id', '=', receipt.execution_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return statusOf(tx, updated);
  });
}
export class ManualRoomOperationConflict extends Error {
  constructor(readonly status: ManualRoomOperationStatus) {
    super('Room operation already recorded or attempted');
  }
}
/** Call under the existing execution lock, after awaited authoritative preparation. */
export async function guardManualRoomRegistration(
  pg: Kysely<MemberIntentPg>,
  input: RoomDecisionInput,
) {
  if (!input.correlationId.startsWith('manual-action-run:')) return;
  const receipt = await pg
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('org_id', '=', input.orgId)
    .where('execution_id', '=', roomExecutionId(input))
    .executeTakeFirst();
  if (
    !receipt ||
    receipt.phase !== 'prepared' ||
    jsonStringify(receipt.request_payload) !== jsonStringify(input)
  )
    throw new Error(
      'Valid prepared server-owned room operation receipt required',
    );
}
export async function claimManualRoomOperation(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  access: ManualOperationAccess,
) {
  const initial = await authorizedReceipt(pg, dependencies, access);
  if (initial.actor_id !== access.actorId)
    throw new Error('Original room operation actor required');
  validateRoomActionPermission(
    await dependencies.getActor(access.actorId, access.orgId),
    initial.request_payload.actionName,
    initial.request_payload.parameters ?? {},
  );
  return pg.transaction().execute(async (tx) => {
    await lockRoomExecution(tx, access.orgId, initial.execution_id);
    const receipt = await authorizedReceipt(tx, dependencies, access);
    const status = await statusOf(tx, receipt);
    if (
      ['retired', 'refused'].includes(receipt.phase) ||
      status.successorExecutionId
    )
      return { kind: 'blocked' as const, status, request: null };
    if (receipt.action !== 'remove_message' && !status.recorded)
      return { kind: 'blocked' as const, status, request: null };
    if (receipt.attempted_at || receipt.accepted_decision_id)
      return {
        kind: 'lookup' as const,
        status,
        request: receipt.request_payload,
      };
    const updated = await tx
      .updateTable('concord_integration.room_manual_operations')
      .set({
        phase: 'acceptance_unknown',
        attempted_at: new Date(),
        updated_at: new Date(),
      })
      .where('org_id', '=', access.orgId)
      .where('execution_id', '=', receipt.execution_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      kind: 'send' as const,
      status: await statusOf(tx, updated),
      request: receipt.request_payload,
    };
  });
}
export async function settleManualRoomOperation(
  pg: Kysely<MemberIntentPg>,
  input: { orgId: string; executionId: string; outcome: MemberDeliveryOutcome },
) {
  return pg.transaction().execute(async (tx) => {
    await lockRoomExecution(tx, input.orgId, input.executionId);
    const receipt = await tx
      .selectFrom('concord_integration.room_manual_operations')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', input.executionId)
      .executeTakeFirstOrThrow();
    if (receipt.phase === 'retired')
      throw new Error('Room operation receipt retired');
    if (input.outcome.outcome === 'accepted') {
      const accepted = input.outcome.status;
      if (
        accepted.executionId !== input.executionId ||
        accepted.action !== receipt.action ||
        (receipt.action === 'remove_message' && accepted.sourceOrder !== null)
      )
        throw new Error('Mismatched room operation acceptance');
      const updated = await tx
        .updateTable('concord_integration.room_manual_operations')
        .set({
          phase: 'accepted',
          accepted_decision_id: accepted.decisionId,
          accepted_status: accepted,
          updated_at: new Date(),
        })
        .where('org_id', '=', input.orgId)
        .where('execution_id', '=', input.executionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return statusOf(tx, updated);
    }
    return statusOf(tx, receipt);
  });
}
