import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { jsonStringify } from '../../utils/encoding.js';
import { reconcileLegacyMemberIntent } from './legacyMemberIntents.js';
import {
  type MemberDeliveryOutcome,
  type MemberIntentDependencies,
  type MemberIntentPg,
  type PreparedMemberIntent,
} from './memberIntentTypes.js';
import {
  object,
  parseRoomStatus,
  publishRoomDecision,
  roomAction,
  roomExecutionId,
  roomRequest,
  RoomResponseError,
  UUID,
  validateRoomActionPermission,
  validRoomReason,
  type ConcordConfig,
  type RoomDecisionInput,
} from './service.js';

export { reconcileLegacyMemberIntent } from './legacyMemberIntents.js';

export type {
  MemberDeliveryState,
  MemberIntentPg,
  MemberIntentDependencies,
  PreparedMemberIntent,
  MemberDeliveryOutcome,
} from './memberIntentTypes.js';
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
/** Caller owns this transaction: immutable audit and revision must commit together. */
export async function registerMemberIntents(
  pg: Kysely<MemberIntentPg>,
  intents: readonly PreparedMemberIntent[],
  manualReviewDecisionId: string | null = null,
) {
  const unique = new Map(intents.map((intent) => [intent.executionId, intent]));
  if (unique.size !== intents.length)
    throw new Error('Duplicate membership execution in submission');
  const targets = new Set(intents.map((intent) => intent.targetKey));
  if (targets.size !== intents.length)
    throw new Error(
      'One membership intent per target per staff submission required',
    );
  for (const intent of [...intents].sort((a, b) =>
    a.executionId.localeCompare(b.executionId),
  ))
    await sql`select pg_advisory_xact_lock(hashtextextended(${jsonStringify([intent.input.orgId, intent.executionId])}, 0))`.execute(
      pg,
    );
  for (const intent of [...intents].sort((a, b) =>
    a.targetKey.localeCompare(b.targetKey),
  )) {
    const { input, executionId, targetKey, fingerprint, action } = intent;
    const prior = await pg
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .executeTakeFirst();
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Membership execution intent conflict');
      continue;
    }
    const quarantined = await pg
      .selectFrom('concord_integration.member_intent_quarantine')
      .select('execution_id')
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .executeTakeFirst();
    if (quarantined)
      throw new Error('Legacy membership intent requires reconciliation');
    await pg
      .insertInto('concord_integration.member_intent_heads')
      .values({
        org_id: input.orgId,
        target_key: targetKey,
        revision: '0',
        current_execution_id: null,
      })
      .onConflict((oc) => oc.columns(['org_id', 'target_key']).doNothing())
      .execute();
    const head = await pg
      .selectFrom('concord_integration.member_intent_heads')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('target_key', '=', targetKey)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const revision = (BigInt(head.revision) + 1n).toString();
    if (BigInt(revision) > 9223372036854775807n)
      throw new Error('Membership source revision exhausted');
    await pg
      .insertInto('concord_integration.member_intents')
      .values({
        org_id: input.orgId,
        execution_id: executionId,
        target_key: targetKey,
        revision,
        case_id: input.caseId,
        source_kind: input.correlationId.startsWith('mrt-decision:')
          ? 'mrt-decision'
          : 'manual-action-run',
        source_id: input.correlationId,
        manual_review_decision_id: manualReviewDecisionId,
        action,
        actor_id: input.actorId!,
        fingerprint,
        request_payload: input,
        delivery_state: 'registered',
        accepted_decision_id: null,
        accepted_status: null,
        superseded_by_execution_id: null,
        last_attempt_at: null,
      })
      .execute();
    await pg
      .updateTable('concord_integration.member_intents')
      .set((eb) => ({
        superseded_by_execution_id: executionId,
        delivery_state: eb
          .case()
          .when('delivery_state', 'in', ['registered', 'acceptance_unknown'])
          .then('superseded' as const)
          .else(eb.ref('delivery_state'))
          .end(),
      }))
      .where('org_id', '=', input.orgId)
      .where('target_key', '=', targetKey)
      .where('execution_id', '!=', executionId)
      .where('superseded_by_execution_id', 'is', null)
      .execute();
    await pg
      .updateTable('concord_integration.member_intent_heads')
      .set({
        revision,
        current_execution_id: executionId,
        updated_at: new Date(),
      })
      .where('org_id', '=', input.orgId)
      .where('target_key', '=', targetKey)
      .execute();
  }
}
/** No HTTP while a transaction is held. An uncertain send is reconciled by lookup only. */
export async function deliverMemberIntent(
  pg: Kysely<MemberIntentPg>,
  config: ConcordConfig,
  dependencies: MemberIntentDependencies,
  input: RoomDecisionInput,
): Promise<MemberDeliveryOutcome> {
  if (!input.actorId || input.orgId !== config.orgId)
    throw new Error('Room staff intent required');
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  validateRoomActionPermission(actor, input.actionName, input.parameters ?? {});
  const executionId = roomExecutionId(input);
  const claim = await pg.transaction().execute(async (tx) => {
    const intent = await tx
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .executeTakeFirst();
    if (!intent) {
      await tx
        .insertInto('concord_integration.member_intent_quarantine')
        .values({
          org_id: input.orgId,
          execution_id: executionId,
          source_id: input.correlationId,
          request_payload: input,
        })
        .onConflict((oc) => oc.columns(['org_id', 'execution_id']).doNothing())
        .execute();
      const quarantined = await tx
        .selectFrom('concord_integration.member_intent_quarantine')
        .selectAll()
        .where('org_id', '=', input.orgId)
        .where('execution_id', '=', executionId)
        .executeTakeFirstOrThrow();
      if (jsonStringify(quarantined.request_payload) !== jsonStringify(input))
        throw new Error('Membership execution intent conflict');
      return { kind: 'missing' as const };
    }
    if (
      intent.fingerprint !== memberIntentFingerprint(input, intent.target_key)
    )
      throw new Error('Membership execution intent conflict');
    const head = await tx
      .selectFrom('concord_integration.member_intent_heads')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('target_key', '=', intent.target_key)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // Reload after acquiring the scope lock: a concurrent staff record may supersede us.
    const fresh = await tx
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      fresh.superseded_by_execution_id ||
      fresh.delivery_state === 'superseded'
    )
      return { kind: 'superseded' as const, intent: fresh };
    if (
      head.revision !== fresh.revision ||
      head.current_execution_id !== executionId
    ) {
      await tx
        .updateTable('concord_integration.member_intents')
        .set({ delivery_state: 'reconciliation_required' })
        .where('org_id', '=', input.orgId)
        .where('execution_id', '=', executionId)
        .execute();
      return { kind: 'blocked' as const, intent: fresh };
    }
    if (fresh.delivery_state === 'accepted')
      return { kind: 'accepted' as const, intent: fresh };
    if (fresh.delivery_state === 'reconciliation_required')
      return { kind: 'blocked' as const, intent: fresh };
    if (fresh.delivery_state !== 'registered')
      return { kind: 'lookup' as const, intent: fresh };
    await tx
      .updateTable('concord_integration.member_intents')
      .set({
        delivery_state: 'acceptance_unknown',
        last_attempt_at: new Date(),
      })
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .execute();
    return { kind: 'send' as const, intent: fresh };
  });
  if (claim.kind === 'missing') {
    try {
      return {
        outcome: 'accepted',
        status: await reconcileLegacyMemberIntent(
          pg,
          config,
          dependencies,
          input,
        ),
      };
    } catch {
      throw new Error(
        'Unregistered membership intent quarantined for reconciliation',
      );
    }
  }
  const intent = claim.intent;
  if (claim.kind === 'blocked')
    throw new Error('Membership intent requires reconciliation');
  const superseded = () =>
    ({
      outcome: 'superseded',
      executionId,
      supersededByExecutionId:
        intent.superseded_by_execution_id ??
        intent.bridge_superseded_by_execution_id,
      acceptedDecisionId: intent.accepted_decision_id,
      acceptanceUnknown:
        intent.last_attempt_at !== null && intent.accepted_decision_id === null,
    }) as const;
  if (
    claim.kind === 'superseded' &&
    (!intent.last_attempt_at || intent.accepted_decision_id)
  )
    return superseded();
  if (claim.kind === 'accepted' && intent.accepted_status)
    return { outcome: 'accepted', status: intent.accepted_status };
  try {
    const status =
      claim.kind === 'send'
        ? await publishRoomDecision(
            config,
            {
              ...dependencies,
              sourceOrder: { version: 1, revision: intent.revision },
            },
            intent.request_payload,
          )
        : parseRoomStatus(
            await roomRequest(
              config,
              dependencies.fetchHTTP,
              await dependencies.getActor(intent.actor_id, input.orgId),
              'get',
              `/v1/decision-executions/${executionId}`,
            ),
          );
    if (
      status.executionId !== executionId ||
      status.action !== intent.action ||
      (status.sourceOrder !== null &&
        status.sourceOrder?.revision !== intent.revision)
    )
      throw new Error('Mismatched membership reconciliation');
    await pg
      .updateTable('concord_integration.member_intents')
      .set((eb) => ({
        delivery_state: eb
          .case()
          .when('superseded_by_execution_id', 'is not', null)
          .then('superseded' as const)
          .when('delivery_state', '=', 'superseded')
          .then('superseded' as const)
          .else('accepted' as const)
          .end(),
        accepted_decision_id: status.decisionId,
        accepted_status: status,
      }))
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .execute();
    if (claim.kind === 'superseded')
      return {
        ...superseded(),
        acceptedDecisionId: status.decisionId,
        acceptanceUnknown: false,
      };
    const latest = await pg
      .selectFrom('concord_integration.member_intents')
      .selectAll()
      .where('org_id', '=', input.orgId)
      .where('execution_id', '=', executionId)
      .executeTakeFirstOrThrow();
    if (latest.superseded_by_execution_id)
      return {
        outcome: 'superseded',
        executionId,
        supersededByExecutionId: latest.superseded_by_execution_id,
        acceptedDecisionId: status.decisionId,
        acceptanceUnknown: false,
      };
    return { outcome: 'accepted', status };
  } catch (error) {
    if (claim.kind === 'superseded') return superseded();
    if (
      error instanceof RoomResponseError &&
      error.code === 'member_intent_superseded'
    ) {
      const replacement = error.details.supersededByExecutionId;
      const revision = error.details.currentRevision;
      if (
        error.details.executionId !== executionId ||
        typeof replacement !== 'string' ||
        !UUID.test(replacement) ||
        typeof revision !== 'string' ||
        !/^[1-9][0-9]*$/.test(revision) ||
        BigInt(revision) <= BigInt(intent.revision)
      )
        throw new Error('Malformed membership supersession');
      // Bridge may know an execution not retained locally; retain its external reference in outcome.
      await pg
        .updateTable('concord_integration.member_intents')
        .set({
          delivery_state: 'superseded',
          bridge_superseded_by_execution_id: replacement,
        })
        .where('org_id', '=', input.orgId)
        .where('execution_id', '=', executionId)
        .execute();
      return {
        outcome: 'superseded',
        executionId,
        supersededByExecutionId: replacement,
        acceptedDecisionId: intent.accepted_decision_id,
        acceptanceUnknown: true,
      };
    }
    if (
      error instanceof RoomResponseError &&
      ['member_intent_order_conflict', 'member_intent_order_required'].includes(
        error.code,
      )
    )
      await pg
        .updateTable('concord_integration.member_intents')
        .set((eb) => ({
          delivery_state: eb
            .case()
            .when('superseded_by_execution_id', 'is not', null)
            .then('superseded' as const)
            .else('reconciliation_required' as const)
            .end(),
        }))
        .where('org_id', '=', input.orgId)
        .where('execution_id', '=', executionId)
        .execute();
    throw error;
  }
}
