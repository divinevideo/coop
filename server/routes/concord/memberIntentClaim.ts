import { type Kysely } from 'kysely';

import { jsonStringify } from '../../utils/encoding.js';
import { memberIntentFingerprint } from './memberIntentIdentity.js';
import { type MemberIntentPg } from './memberIntentTypes.js';
import { roomExecutionId, type RoomDecisionInput } from './service.js';

export async function claimMemberIntent(
  pg: Kysely<MemberIntentPg>,
  input: RoomDecisionInput,
  retryAfterLookup = false,
) {
  const executionId = roomExecutionId(input);
  return pg.transaction().execute(async (tx) => {
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
    if (
      fresh.delivery_state !== 'registered' &&
      !(retryAfterLookup && fresh.delivery_state === 'acceptance_unknown')
    )
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
}
