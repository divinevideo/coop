import { jsonStringify } from '../../../utils/encoding.js';
import {
  type ManualReviewDecisionComponent,
  type ManualReviewDecisionRelatedAction,
} from './JobDecisioning.js';

/** Execution identity contains one action/item-type/item tuple, not its position
 * in a decision. Keep recorded arrays immutable while counting their identities. */
export function roomDecisionTargets(
  item:
    | { itemId: string; itemTypeIdentifier: { id: string } }
    | { id: string; typeIdentifier: { id: string } },
  decisions: readonly ManualReviewDecisionComponent[],
  related: readonly ManualReviewDecisionRelatedAction[],
) {
  const itemId = 'itemId' in item ? item.itemId : item.id;
  const itemTypeId =
    'itemTypeIdentifier' in item
      ? item.itemTypeIdentifier.id
      : item.typeIdentifier.id;
  return [
    ...decisions.flatMap((part) =>
      part.type === 'CUSTOM_ACTION'
        ? part.actions.map((action) =>
            jsonStringify([action.id, itemTypeId, itemId]),
          )
        : [],
    ),
    ...related.flatMap((part) =>
      part.actionIds.flatMap((actionId) =>
        part.itemIds.map((itemId) =>
          jsonStringify([actionId, part.itemTypeId, itemId]),
        ),
      ),
    ),
  ];
}

export function recordedRoomExecutionCount(
  ...args: Parameters<typeof roomDecisionTargets>
) {
  return new Set(roomDecisionTargets(...args)).size;
}

export function assertUniqueRoomDecisionTargets(
  ...args: Parameters<typeof roomDecisionTargets>
) {
  const targets = roomDecisionTargets(...args);
  if (new Set(targets).size !== targets.length)
    throw new Error('Submit each room action/item target only once');
}
