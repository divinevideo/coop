import { randomUUID } from 'node:crypto';
import { type Kysely } from 'kysely';

import { UserRole } from '../../models/types/permissioning.js';
import { lockRoomExecution } from './manualRoomOperations.js';
import {
  type MemberIntentDependencies,
  type MemberIntentPg,
} from './memberIntentTypes.js';
import { recordedRoomExecutionSource } from './recordedRoomExecution.js';
import { type RoomExecutionDisposition } from './roomDispositionTypes.js';
import { RoomResponseError, UUID, validRoomReason } from './service.js';

export function definitiveRoomRefusal(
  error: unknown,
  executionId: string,
): error is RoomResponseError {
  return (
    error instanceof RoomResponseError &&
    error.status === 409 &&
    error.code === 'decision_source_unavailable' &&
    error.details.executionId === executionId
  );
}
async function executionFacts(
  pg: Kysely<MemberIntentPg>,
  orgId: string,
  executionId: string,
) {
  const receipt = await pg
    .selectFrom('concord_integration.room_manual_operations')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
  const intent = await pg
    .selectFrom('concord_integration.member_intents')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
  const quarantine = await pg
    .selectFrom('concord_integration.member_intent_quarantine')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
  const removal = await pg
    .selectFrom('concord_integration.room_execution_acceptances')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
  return {
    retiredUnsent: Boolean(
      receipt?.phase === 'retired' &&
      !receipt.attempted_at &&
      !intent &&
      !quarantine,
    ),
    known: Boolean(receipt || intent || quarantine || removal),
    sourceId:
      receipt?.request_payload.correlationId ??
      intent?.source_id ??
      quarantine?.source_id ??
      removal?.source_id,
    accepted: Boolean(
      receipt?.accepted_decision_id ||
      intent?.accepted_decision_id ||
      quarantine?.accepted_decision_id ||
      removal?.accepted_decision_id,
    ),
    uncertain: Boolean(
      (receipt?.attempted_at || intent?.last_attempt_at || quarantine) &&
      !(
        receipt?.accepted_decision_id ||
        intent?.accepted_decision_id ||
        quarantine?.accepted_decision_id ||
        removal?.accepted_decision_id ||
        intent?.bridge_superseded_by_execution_id
      ),
    ),
  };
}
export async function getRoomExecutionDisposition(
  pg: Kysely<MemberIntentPg>,
  orgId: string,
  executionId: string,
): Promise<RoomExecutionDisposition | null> {
  const state = await pg
    .selectFrom('concord_integration.room_execution_state')
    .selectAll()
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .executeTakeFirst();
  if (!state) return null;
  const refusal = await pg
    .selectFrom('concord_integration.room_execution_dispositions')
    .select('refusal_code')
    .where('org_id', '=', orgId)
    .where('execution_id', '=', executionId)
    .where('kind', '=', 'permanent_refusal')
    .executeTakeFirst();
  const facts = await executionFacts(pg, orgId, executionId);
  return {
    executionId,
    attentionState: state.attention_state,
    automationStopped: state.automation_stopped,
    acceptanceUnknown:
      !refusal &&
      (facts.uncertain ||
        (!facts.known && state.source_id.startsWith('mrt-decision:'))),
    refusalCode: refusal?.refusal_code ?? null,
    latestEventId: state.latest_event_id,
  };
}
async function appendDisposition(
  pg: Kysely<MemberIntentPg>,
  input: {
    orgId: string;
    executionId: string;
    kind: 'permanent_refusal' | 'automation_stopped' | 'closed';
    refusalCode?: 'decision_source_unavailable';
    actorId?: string;
    reason?: string;
    sourceId?: string;
  },
): Promise<RoomExecutionDisposition> {
  if (!UUID.test(input.executionId)) throw new Error('Invalid room execution');
  return pg.transaction().execute(async (tx) => {
    await lockRoomExecution(tx, input.orgId, input.executionId);
    const facts = await executionFacts(tx, input.orgId, input.executionId);
    const current = await getRoomExecutionDisposition(
      tx,
      input.orgId,
      input.executionId,
    );
    const recordedSource =
      !facts.known &&
      !current &&
      !input.sourceId &&
      input.kind === 'automation_stopped'
        ? await recordedRoomExecutionSource(tx, input.orgId, input.executionId)
        : undefined;
    if (!facts.known && !current && !input.sourceId && !recordedSource)
      throw new Error('Unknown room execution');
    if (
      input.kind === 'closed' &&
      (current?.acceptanceUnknown ||
        (!facts.accepted &&
          !current?.refusalCode &&
          !(current?.automationStopped && facts.retiredUnsent)))
    )
      throw new Error('Unsettled room execution cannot close');
    if (
      current &&
      ((input.kind === 'closed' && current.attentionState === 'closed') ||
        (input.kind === 'automation_stopped' && current.automationStopped) ||
        (input.kind === 'permanent_refusal' && current.refusalCode))
    )
      return current;
    const id = randomUUID();
    await tx
      .insertInto('concord_integration.room_execution_dispositions')
      .values({
        id,
        org_id: input.orgId,
        execution_id: input.executionId,
        kind: input.kind,
        refusal_code: input.refusalCode ?? null,
        actor_id: input.actorId ?? null,
        reason: input.reason ?? null,
      })
      .execute();
    await tx
      .insertInto('concord_integration.room_execution_state')
      .values({
        org_id: input.orgId,
        execution_id: input.executionId,
        source_id: facts.sourceId ?? input.sourceId ?? recordedSource ?? '',
        attention_state: input.kind === 'closed' ? 'closed' : 'needs_attention',
        automation_stopped: true,
        latest_event_id: id,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'execution_id']).doUpdateSet({
          attention_state:
            input.kind === 'closed' ? 'closed' : 'needs_attention',
          automation_stopped: true,
          latest_event_id: id,
          updated_at: new Date(),
        }),
      )
      .execute();
    return (await getRoomExecutionDisposition(
      tx,
      input.orgId,
      input.executionId,
    ))!;
  });
}
export async function recordPermanentRefusal(
  pg: Kysely<MemberIntentPg>,
  input: {
    orgId: string;
    executionId: string;
    refusalCode: 'decision_source_unavailable';
    sourceId?: string;
  },
) {
  return appendDisposition(pg, { ...input, kind: 'permanent_refusal' });
}
async function requireAdmin(
  dependencies: MemberIntentDependencies,
  input: { orgId: string; actorId: string; reason: string },
) {
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  if (
    actor.id !== input.actorId ||
    actor.orgId !== input.orgId ||
    actor.role !== UserRole.ADMIN ||
    !actor.approvedByAdmin ||
    actor.rejectedByAdmin ||
    !validRoomReason(input.reason)
  )
    throw new Error('Room administrator and reason required');
}
export async function stopRoomAutomation(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  input: {
    orgId: string;
    actorId: string;
    executionId: string;
    reason: string;
  },
) {
  await requireAdmin(dependencies, input);
  return appendDisposition(pg, { ...input, kind: 'automation_stopped' });
}
export async function closeRoomExecution(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  input: {
    orgId: string;
    actorId: string;
    executionId: string;
    reason: string;
  },
) {
  await requireAdmin(dependencies, input);
  return appendDisposition(pg, { ...input, kind: 'closed' });
}
export async function listRoomNeedsAttention(
  pg: Kysely<MemberIntentPg>,
  dependencies: MemberIntentDependencies,
  input: { orgId: string; actorId: string; cursor?: string; limit: number },
) {
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  if (
    actor.id !== input.actorId ||
    actor.orgId !== input.orgId ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.cursor && !UUID.test(input.cursor))
  )
    throw new Error('Invalid room attention query');
  const rows = await pg
    .selectFrom('concord_integration.room_execution_state')
    .select('execution_id')
    .where('org_id', '=', input.orgId)
    .where('attention_state', '=', 'needs_attention')
    .$if(Boolean(input.cursor), (qb) =>
      qb.where('execution_id', '>', input.cursor!),
    )
    .orderBy('execution_id')
    .limit(input.limit + 1)
    .execute();
  const visible = rows.slice(0, input.limit);
  const items = await Promise.all(
    visible.map(
      async (row) =>
        (await getRoomExecutionDisposition(pg, input.orgId, row.execution_id))!,
    ),
  );
  return {
    items,
    nextCursor: rows.length > input.limit ? visible.at(-1)!.execution_id : null,
  };
}
/** Primary committed evidence only. Absence, a replica or Redis state never completes a room job. */
export async function roomJobQueueComplete(
  pg: Kysely<MemberIntentPg>,
  orgId: string,
  sourceId: string,
  expectedExecutions: number,
) {
  if (expectedExecutions < 1) return false;
  const stopped = await pg
    .selectFrom('concord_integration.room_execution_state')
    .select('execution_id')
    .where('org_id', '=', orgId)
    .where('source_id', '=', sourceId)
    .where('automation_stopped', '=', true)
    .execute();
  const accepted = await pg
    .selectFrom('concord_integration.member_intents')
    .select('execution_id')
    .where('org_id', '=', orgId)
    .where('source_id', '=', sourceId)
    .where((eb) =>
      eb.or([
        eb('accepted_decision_id', 'is not', null),
        eb('bridge_superseded_by_execution_id', 'is not', null),
        eb.and([
          eb('superseded_by_execution_id', 'is not', null),
          eb('last_attempt_at', 'is', null),
        ]),
      ]),
    )
    .execute();
  const removals = await pg
    .selectFrom('concord_integration.room_execution_acceptances')
    .select('execution_id')
    .where('org_id', '=', orgId)
    .where('source_id', '=', sourceId)
    .execute();
  return (
    new Set(
      [...stopped, ...accepted, ...removals].map((row) => row.execution_id),
    ).size === expectedExecutions
  );
}
