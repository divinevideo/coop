import { sql, type Kysely } from 'kysely';

import { type ManualReviewToolServicePg } from '../../services/manualReviewToolService/index.js';
import { type MemberIntentPg } from './memberIntentTypes.js';
import { roomExecutionId, type RoomDecisionInput } from './service.js';

/** A bounded search must never turn an incomplete lookup into an unknown execution. */
export class RecordedRoomLookupIncomplete extends Error {
  constructor() {
    super('Recorded room execution lookup incomplete; no disposition recorded');
  }
}

/** Recover the audit source from primary committed intent, without mutable action configuration. */
export async function recordedRoomExecutionSource(
  pg: Kysely<MemberIntentPg>,
  orgId: string,
  executionId: string,
): Promise<string | undefined> {
  const primary =
    pg.withTables<
      Pick<
        ManualReviewToolServicePg,
        'manual_review_tool.manual_review_decisions'
      >
    >();
  // This helper runs inside the disposition transaction; the timeout resets at its end.
  await sql`SET LOCAL statement_timeout = '1s'`.execute(primary);
  const deadline = performance.now() + 5000;
  let cursor: string | undefined;
  let remainingTargets = 10000;
  const matches = (
    sourceId: string,
    actionId: string,
    itemTypeId: string,
    itemId: string,
  ) => {
    if (--remainingTargets < 0 || performance.now() >= deadline)
      throw new RecordedRoomLookupIncomplete();
    return (
      roomExecutionId({
        orgId,
        correlationId: sourceId,
        actionId,
        itemTypeId,
        itemId,
      } as RoomDecisionInput) === executionId
    );
  };
  for (let page = 0; page < 10; page++) {
    if (performance.now() >= deadline) throw new RecordedRoomLookupIncomplete();
    const pageCursor = cursor;
    const rows = await primary
      .selectFrom('manual_review_tool.manual_review_decisions')
      .select([
        'id',
        'decision_components',
        'related_actions',
        sql<string>`job_payload->>'id'`.as('job_id'),
        sql<string>`job_payload->>'orgId'`.as('job_org_id'),
        sql<string>`job_payload->'payload'->'item'->>'itemId'`.as('item_id'),
        sql<string>`job_payload->'payload'->'item'->'itemTypeIdentifier'->>'id'`.as(
          'item_type_id',
        ),
      ])
      .where('org_id', '=', orgId)
      .where(sql<boolean>`job_payload->'roomDeliveryRequired' = 'true'::jsonb`)
      .$if(pageCursor !== undefined, (qb) => qb.where('id', '>', pageCursor!))
      .orderBy('id')
      .limit(100)
      .execute();
    for (const row of rows) {
      if (
        row.job_org_id !== orgId ||
        !row.job_id ||
        Buffer.from(row.job_id.split(':')[1] ?? '', 'base64url').toString() !==
          row.id
      )
        continue;
      const sourceId = `mrt-decision:${row.job_id}`;
      if (
        row.decision_components.some(
          (part) =>
            part.type === 'CUSTOM_ACTION' &&
            part.actions.some((action) =>
              matches(sourceId, action.id, row.item_type_id, row.item_id),
            ),
        ) ||
        row.related_actions.some((part) =>
          part.actionIds.some((actionId) =>
            part.itemIds.some((itemId) =>
              matches(sourceId, actionId, part.itemTypeId, itemId),
            ),
          ),
        )
      )
        return sourceId;
    }
    if (rows.length < 100) return undefined;
    cursor = rows[rows.length - 1].id;
  }
  throw new RecordedRoomLookupIncomplete();
}
