/** Only the explicit local test container or the isolated CI compose service is allowed. */
export function memberIntentTestDatabaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): URL {
  if (env.MEMBER_INTENT_TEST_DATABASE_URL) {
    const url = new URL(env.MEMBER_INTENT_TEST_DATABASE_URL);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.search ||
      url.hash
    )
      throw new Error('Explicit loopback PostgreSQL test URL required');
    return url;
  }
  if (
    env.MEMBER_INTENT_TEST_COMPOSE !== '1' ||
    env.NODE_ENV !== 'test' ||
    env.DATABASE_HOST !== 'postgres' ||
    env.DATABASE_PORT !== '5432' ||
    env.DATABASE_NAME !== 'postgres' ||
    !env.DATABASE_USER ||
    !env.DATABASE_PASSWORD
  )
    throw new Error('Explicit isolated compose test database opt-in required');
  return new URL(
    `postgres://${encodeURIComponent(env.DATABASE_USER)}:${encodeURIComponent(env.DATABASE_PASSWORD)}@postgres:5432/postgres`,
  );
}
