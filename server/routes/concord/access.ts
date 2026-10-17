import { createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { object, type ConcordConfig, type RoomTransport } from './service.js';

export function accessVerifier(
  config: Pick<ConcordConfig, 'accessIssuer' | 'accessAudience'>,
  fetchHTTP: RoomTransport,
) {
  let keys: Record<string, unknown>[] = [],
    expires = 0;
  return async (token: string | undefined, email: string): Promise<void> => {
    if (!token || token.length > 16384)
      throw new Error('Cloudflare Access required');
    const decoded = jwt.decode(token, { complete: true });
    if (
      !decoded ||
      decoded.header.alg !== 'RS256' ||
      typeof decoded.header.kid !== 'string'
    )
      throw new Error('Invalid Access assertion');
    if (expires <= Date.now()) {
      const result = await fetchHTTP({
        url: config.accessIssuer + '/cdn-cgi/access/certs',
        method: 'get',
        headers: {},
        handleResponseBody: 'as-json',
        logRequestAndResponseBody: 'NEVER',
        timeoutMs: 5000,
        redirect: 'error',
      });
      const body = object(result.body);
      if (!result.ok || !Array.isArray(body.keys) || body.keys.length > 16)
        throw new Error('Access verification unavailable');
      keys = body.keys.map(object);
      expires = Date.now() + 60_000;
    }
    const key = keys.find(
      (candidate) =>
        candidate.kid === decoded.header.kid && candidate.kty === 'RSA',
    );
    if (!key || typeof key.n !== 'string' || typeof key.e !== 'string')
      throw new Error('Access verification key unavailable');
    const publicKey = createPublicKey({
      format: 'jwk',
      key: { kty: 'RSA', n: key.n, e: key.e },
    });
    const verified = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: config.accessIssuer,
      audience: config.accessAudience,
    });
    if (
      typeof verified === 'string' ||
      !Number.isSafeInteger(verified.exp) ||
      typeof verified.email !== 'string' ||
      verified.email.toLowerCase() !== email.toLowerCase()
    )
      throw new Error('Access identity does not match the staff session');
  };
}
