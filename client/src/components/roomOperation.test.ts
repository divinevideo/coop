import {
  beginRoomOperation,
  completeRoomOperation,
  prepareRoomOperation,
  rememberRoomReceipt,
  roomOperation,
} from './roomOperation';

const item = { id: 'synthetic-case', typeId: 'room-type' };
const identity = { actorId: 'actor', orgId: 'org' };
const claim = {
  actionId: 'ban',
  note: 'Synthetic reason',
  parameters: { days: 2 },
};
const id = 'source-order-v2_ban_member_10000000-0000-4000-8000-000000000001';
beforeEach(() => sessionStorage.clear());

async function receipt() {
  const pending = await prepareRoomOperation(item, identity, claim);
  if (!('clientNonce' in pending)) throw new Error('Expected nonce');
  rememberRoomReceipt(item, pending.clientNonce, id);
  return pending;
}

test('lost begin response retries the persisted nonce and immutable claims without storing the reason', async () => {
  const first = await prepareRoomOperation(item, identity, claim);
  expect(await prepareRoomOperation(item, identity, claim)).toEqual(first);
  const stored = sessionStorage.getItem(sessionStorage.key(0)!)!;
  expect(stored).not.toContain(claim.note);
  expect(stored).toContain('claimFingerprint');
  for (const change of [
    { ...claim, note: 'Changed' },
    { ...claim, actionId: 'remove' },
    { ...claim, parameters: { days: 3 } },
  ])
    await expect(prepareRoomOperation(item, identity, change)).rejects.toThrow(
      'different inputs',
    );
  expect(await prepareRoomOperation(item, identity, claim)).toEqual(first);
});

test('receipt and attempt metadata survive rejection and reordered object keys', async () => {
  await receipt();
  expect(beginRoomOperation(item, id).firstAttempt).toBe(true);
  expect(roomOperation(item)).toBe(id);
  expect(
    await prepareRoomOperation(item, identity, {
      parameters: { days: 2 },
      note: claim.note,
      actionId: 'ban',
    }),
  ).toMatchObject({ operationId: id });
  expect(beginRoomOperation(item, id).firstAttempt).toBe(false);
});

test.each(['actorId', 'orgId'])(
  'a pending nonce cannot change %s',
  async (field) => {
    await receipt();
    await expect(
      prepareRoomOperation(item, { ...identity, [field]: 'other' }, claim),
    ).rejects.toThrow('another session');
    expect(roomOperation(item)).toBe(id);
  },
);

test.each(['concord-operation:source-order-v1:', 'concord-operation:'])(
  'legacy identity in %s stays lookup-only without a new nonce',
  async (prefix) => {
    const legacy =
      'source-order-v1_ban_member_10000000-0000-4000-8000-000000000002';
    sessionStorage.setItem(
      `${prefix}${JSON.stringify([item.typeId, item.id])}`,
      legacy,
    );
    expect(await prepareRoomOperation(item, identity, claim)).toEqual({
      operationId: legacy,
    });
    expect(beginRoomOperation(item, legacy)).toEqual({
      operationId: legacy,
      firstAttempt: false,
    });
    expect(roomOperation(item)).toBe(legacy);
  },
);

test('late success and late begin response cannot erase or replace a newer pending receipt', async () => {
  const first = await receipt();
  completeRoomOperation(item, id);
  const next = await prepareRoomOperation(item, identity, {
    ...claim,
    actionId: 'remove',
  });
  if (!('clientNonce' in next)) throw new Error('Expected nonce');
  const replacement = id.replace('ban_member', 'remove_message');
  rememberRoomReceipt(item, next.clientNonce, replacement);
  beginRoomOperation(item, replacement);
  expect(completeRoomOperation(item, id)).toBe(false);
  expect(() => rememberRoomReceipt(item, first.clientNonce, id)).toThrow(
    'changed',
  );
  expect(roomOperation(item)).toBe(replacement);
  expect(beginRoomOperation(item, replacement).firstAttempt).toBe(false);
});
