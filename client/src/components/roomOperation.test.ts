import { completeRoomOperation, roomOperation } from './roomOperation';

test('retries reuse the persisted opaque operation until acceptance', () => {
  sessionStorage.clear();
  const item = { id: 'synthetic-case', typeId: 'room-type' };
  const first = roomOperation(item, 'concord_remove_message');
  expect(first).toMatch(/^source-order-v1_remove_message_/);
  expect(roomOperation(item, 'concord_remove_message')).toBe(first);
  expect(roomOperation(item, 'concord_ban_member')).toBe(first);
  expect(sessionStorage.length).toBe(1);
  completeRoomOperation(item);
  expect(roomOperation(item, 'concord_remove_message')).not.toBe(first);
});

test('source-ordered clients never relabel a browser-held legacy operation', () => {
  sessionStorage.clear();
  const item = { id: 'synthetic-case', typeId: 'room-type' };
  const oldKey = `concord-operation:${JSON.stringify([item.typeId, item.id])}`;
  sessionStorage.setItem(oldKey, '10000000-0000-4000-8000-000000000001');
  const current = roomOperation(item, 'concord_ban_member');
  expect(current).toMatch(/^source-order-v1_ban_member_/);
  expect(current).not.toBe(sessionStorage.getItem(oldKey));
  completeRoomOperation(item);
  expect(sessionStorage.getItem(oldKey)).toBe(
    '10000000-0000-4000-8000-000000000001',
  );
});
