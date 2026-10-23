import { roomExecutionId, UUID, type RoomDecisionInput } from './service.js';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a recorded-decision response object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new Error('Expected a nonempty recorded identifier');
  return value;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected recorded action arrays');
  return value;
}

/** Offline identifiers only. The stop API independently checks current authority
 * and reproduces each execution from primary committed intent. */
export function recordedRoomStopInputs(response: unknown) {
  const root = object(response);
  if (root.errors !== undefined)
    throw new Error(
      'Do not derive identifiers from a partial GraphQL response',
    );
  const data = object(root.data);
  const orgId = text(object(data.myOrg).id);
  const decision = object(object(data.getDecidedJobFromJobId).decision);
  const manualReviewDecisionId = text(decision.id);
  const jobId = text(decision.jobId);
  if (
    !UUID.test(manualReviewDecisionId) ||
    Buffer.from(jobId.split(':')[1] ?? '', 'base64url').toString() !==
      manualReviewDecisionId
  )
    throw new Error('Recorded job and decision identifiers do not match');
  const primaryItemId = text(decision.itemId);
  const primaryItemTypeId = text(decision.itemTypeId);
  const make = (actionId: string, itemTypeId: string, itemId: string) => ({
    executionId: roomExecutionId({
      orgId,
      correlationId: `mrt-decision:${jobId}`,
      actionId,
      itemTypeId,
      itemId,
    } as RoomDecisionInput),
    manualReviewDecisionId,
    actionId,
    itemTypeId,
    itemId,
  });
  const primary = array(decision.decisions).flatMap((value) => {
    const part = object(value);
    return part.type === 'CUSTOM_ACTION'
      ? array(part.actionIds).map((id) =>
          make(text(id), primaryItemTypeId, primaryItemId),
        )
      : [];
  });
  const related = array(decision.relatedActions).flatMap((value) => {
    const part = object(value);
    if (part.type !== 'RELATED_ACTION')
      throw new Error('Expected recorded related actions');
    const actions = array(part.actionIds);
    const items = array(part.itemIds);
    if (actions.length * items.length > 10000)
      throw new Error('Too many recorded action targets');
    return actions.flatMap((id) =>
      items.map((itemId) =>
        make(text(id), text(part.itemTypeId), text(itemId)),
      ),
    );
  });
  if (primary.length + related.length > 10000)
    throw new Error('Too many recorded action targets');
  return [
    ...new Map(
      [...primary, ...related].map((entry) => [entry.executionId, entry]),
    ).values(),
  ];
}
