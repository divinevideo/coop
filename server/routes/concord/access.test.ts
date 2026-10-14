import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { accessVerifier } from './access.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const issuer = 'https://synthetic.cloudflareaccess.com',
  audience = 'synthetic-room-app';
test('staff requests require a signed Access token for this app and session identity', async () => {
  const fetchHTTP = jest.fn(async () => ({
    ok: true,
    status: 200,
    body: {
      keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic' }],
    },
  }));
  const verify = accessVerifier(
    { accessIssuer: issuer, accessAudience: audience },
    fetchHTTP,
  );
  const token = (aud: string, email: string) =>
    jwt.sign({ email }, pair.privateKey, {
      algorithm: 'RS256',
      keyid: 'synthetic',
      issuer,
      audience: aud,
      expiresIn: 60,
    });
  await verify(
    token(audience, 'synthetic@example.invalid'),
    'synthetic@example.invalid',
  );
  await expect(
    verify(undefined, 'synthetic@example.invalid'),
  ).rejects.toThrow();
  await expect(
    verify(
      token('wrong', 'synthetic@example.invalid'),
      'synthetic@example.invalid',
    ),
  ).rejects.toThrow();
  await expect(
    verify(
      token(audience, 'another@example.invalid'),
      'synthetic@example.invalid',
    ),
  ).rejects.toThrow();
  expect(fetchHTTP).toHaveBeenCalledTimes(1);
});

test('Access tokens without an expiry cannot authorize staff', async () => {
  const verify = accessVerifier(
    { accessIssuer: issuer, accessAudience: audience },
    async () => ({
      ok: true,
      status: 200,
      body: {
        keys: [
          { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic' },
        ],
      },
    }),
  );
  const token = jwt.sign(
    { email: 'synthetic@example.invalid' },
    pair.privateKey,
    { algorithm: 'RS256', keyid: 'synthetic', issuer, audience },
  );
  await expect(verify(token, 'synthetic@example.invalid')).rejects.toThrow();
});
