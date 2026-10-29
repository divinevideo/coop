import { type ItemIdentifier } from '@roostorg/coop-types';

const legacyKey = (item: ItemIdentifier) =>
  `concord-operation:source-order-v1:${JSON.stringify([item.typeId, item.id])}`;
const key = (item: ItemIdentifier) => `${legacyKey(item)}:receipt`;
type Identity = { actorId: string; orgId: string };
type Receipt = Identity & {
  clientNonce: string;
  operationId?: string;
  attempts: number;
  claimFingerprint: string;
};

/** Only opaque identities and attempt metadata belong in storage, never reasons. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function prepareRoomOperation(
  item: ItemIdentifier,
  identity: Identity,
  claim: unknown,
) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(claim)),
  );
  const claimFingerprint = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const stored = sessionStorage.getItem(key(item));
  if (stored) {
    const receipt: Receipt = JSON.parse(stored);
    if (
      receipt.actorId !== identity.actorId ||
      receipt.orgId !== identity.orgId
    )
      throw new Error('The pending room request belongs to another session.');
    if (receipt.claimFingerprint !== claimFingerprint)
      throw new Error('The pending room request has different inputs.');
    return receipt;
  }
  // Never turn an older, possibly accepted attempt into a fresh write.
  const old =
    sessionStorage.getItem(legacyKey(item)) ??
    sessionStorage.getItem(
      `concord-operation:${JSON.stringify([item.typeId, item.id])}`,
    );
  if (old) return { operationId: old };
  const receipt: Receipt = {
    ...identity,
    clientNonce: crypto.randomUUID(),
    attempts: 0,
    claimFingerprint,
  };
  sessionStorage.setItem(key(item), JSON.stringify(receipt));
  return receipt;
}

export function rememberRoomReceipt(
  item: ItemIdentifier,
  clientNonce: string,
  operationId: string,
) {
  const stored = sessionStorage.getItem(key(item));
  if (!stored) throw new Error('The pending room request has changed.');
  const receipt: Receipt = JSON.parse(stored);
  if (
    receipt.clientNonce !== clientNonce ||
    (receipt.operationId && receipt.operationId !== operationId)
  )
    throw new Error('The pending room request has changed.');
  sessionStorage.setItem(
    key(item),
    JSON.stringify({ ...receipt, operationId }),
  );
}

export function roomOperation(item: ItemIdentifier): string | undefined {
  const stored = sessionStorage.getItem(key(item));
  return stored
    ? (JSON.parse(stored) as Receipt).operationId
    : (sessionStorage.getItem(legacyKey(item)) ??
        sessionStorage.getItem(
          `concord-operation:${JSON.stringify([item.typeId, item.id])}`,
        ) ??
        undefined);
}

/** Capture the exact identity and persist uncertainty before delivery transport. */
export function beginRoomOperation(item: ItemIdentifier, operationId: string) {
  if (roomOperation(item) !== operationId)
    throw new Error('The pending room request has changed.');
  const stored = sessionStorage.getItem(key(item));
  if (stored) {
    const receipt: Receipt = JSON.parse(stored);
    const attempts = receipt.attempts + 1;
    sessionStorage.setItem(key(item), JSON.stringify({ ...receipt, attempts }));
    return { operationId, firstAttempt: attempts === 1 };
  }
  const attemptsKey = `${legacyKey(item)}:attempts`;
  sessionStorage.setItem(
    attemptsKey,
    String(Number(sessionStorage.getItem(attemptsKey) ?? 1) + 1),
  );
  return { operationId, firstAttempt: false };
}

export function completeRoomOperation(
  item: ItemIdentifier,
  expectedId: string,
): boolean {
  if (roomOperation(item) !== expectedId) return false;
  if (sessionStorage.getItem(key(item))) {
    sessionStorage.removeItem(key(item));
    return true;
  }
  for (const candidate of [
    legacyKey(item),
    `concord-operation:${JSON.stringify([item.typeId, item.id])}`,
  ]) {
    if (sessionStorage.getItem(candidate) === expectedId) {
      sessionStorage.removeItem(candidate);
      sessionStorage.removeItem(`${candidate}:attempts`);
    }
  }
  return true;
}
