import {
  beginRoomOperation,
  completeRoomOperation,
  rejectUnrecordedRoomAttempt,
  roomOperation,
} from './roomOperation';

test('retries reuse the persisted opaque operation until acceptance', () => {
  sessionStorage.clear();
  const item = { id: 'synthetic-case', typeId: 'room-type' };
  const first = roomOperation(item, 'concord_remove_message');
  expect(first).toMatch(/^source-order-v1_remove_message_/);
  expect(roomOperation(item, 'concord_remove_message')).toBe(first);
  expect(roomOperation(item, 'concord_ban_member')).toBe(first);
  expect(sessionStorage.length).toBe(1);
  completeRoomOperation(item, first);
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
  completeRoomOperation(item, current);
  expect(sessionStorage.getItem(oldKey)).toBe(
    '10000000-0000-4000-8000-000000000001',
  );
});

test('definitively rejected first attempt permits a different action', () => {
  sessionStorage.clear();
  const item = { id: 'rejected', typeId: 'room' };
  const attempt = beginRoomOperation(item, 'concord_ban_member');
  expect(
    rejectUnrecordedRoomAttempt(
      item,
      attempt.operationId,
      attempt.firstAttempt,
    ),
  ).toBe(true);
  expect(
    beginRoomOperation(item, 'concord_remove_message').operationId,
  ).toMatch(/^source-order-v1_remove_message_/);
});

test('a rejection after uncertain acceptance never releases the original identity', () => {
  sessionStorage.clear();
  const item = { id: 'uncertain', typeId: 'room' };
  const original = beginRoomOperation(item, 'concord_ban_member');
  const retry = beginRoomOperation(item, 'concord_ban_member');
  expect(
    rejectUnrecordedRoomAttempt(item, retry.operationId, retry.firstAttempt),
  ).toBe(false);
  // A delayed rejection from the first request also cannot release an overlapping retry.
  expect(
    rejectUnrecordedRoomAttempt(
      item,
      original.operationId,
      original.firstAttempt,
    ),
  ).toBe(false);
  expect(beginRoomOperation(item, 'concord_remove_message').operationId).toBe(
    original.operationId,
  );
});

test('browser-held operations without attempt metadata remain conservative', () => {
  sessionStorage.clear();
  const item = { id: 'old-tab', typeId: 'room' };
  const original = roomOperation(item, 'concord_ban_member');
  const retry = beginRoomOperation(item, 'concord_ban_member');
  expect(
    rejectUnrecordedRoomAttempt(item, retry.operationId, retry.firstAttempt),
  ).toBe(false);
  expect(retry.operationId).toBe(original);
});

test('a late success never releases a newer operation or its attempt history', () => {
  sessionStorage.clear();
  const item = { id: 'overlapping', typeId: 'room' };
  const old = beginRoomOperation(item, 'concord_ban_member');
  completeRoomOperation(item, old.operationId);
  const next = beginRoomOperation(item, 'concord_remove_message');
  completeRoomOperation(item, old.operationId);
  expect(roomOperation(item, 'concord_remove_message')).toBe(next.operationId);
  expect(
    rejectUnrecordedRoomAttempt(item, next.operationId, next.firstAttempt),
  ).toBe(true);
});
