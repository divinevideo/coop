import { type ItemIdentifier } from '@roostorg/types';

const key = (item: ItemIdentifier) =>
  `concord-operation:source-order-v1:${JSON.stringify([item.typeId, item.id])}`;
/** Persist only the opaque operation, never report text. Keep it until acceptance
 * is confirmed so a lost response or reload cannot create another decision. */
export function roomOperation(
  item: ItemIdentifier,
  actionName: string,
): string {
  const existing = sessionStorage.getItem(key(item));
  if (existing) return existing;
  const action = actionName.replace(/^concord_/, '');
  const id = `source-order-v1_${action}_${crypto.randomUUID()}`;
  sessionStorage.setItem(key(item), id);
  return id;
}
export function completeRoomOperation(item: ItemIdentifier): void {
  sessionStorage.removeItem(key(item));
}
