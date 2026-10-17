import { completeRoomOperation, roomOperation } from './roomOperation';

test('retries reuse the persisted opaque operation until acceptance', () => {
  sessionStorage.clear();
  const item = { id: 'synthetic-case', typeId: 'room-type' };
  const first = roomOperation(item);
  expect(roomOperation(item)).toBe(first);
  expect(sessionStorage.length).toBe(1);
  completeRoomOperation(item);
  expect(roomOperation(item)).not.toBe(first);
});
