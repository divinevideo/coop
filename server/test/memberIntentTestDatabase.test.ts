import { memberIntentTestDatabaseUrl } from './memberIntentTestDatabase.js';

test('explicit loopback PostgreSQL URL permits an isolated local test database', () => {
  expect(
    memberIntentTestDatabaseUrl({
      MEMBER_INTENT_TEST_DATABASE_URL:
        'postgres://postgres:synthetic@127.0.0.1:55447/postgres',
    }).hostname,
  ).toBe('127.0.0.1');
});
test.each([
  'postgres://postgres:synthetic@postgres/postgres',
  'postgres://postgres:synthetic@database.example/postgres',
  'https://localhost/postgres',
  'postgres://localhost/postgres?host=database.example',
])('untrusted or overridden local connection fails closed: %s', (value) => {
  expect(() =>
    memberIntentTestDatabaseUrl({ MEMBER_INTENT_TEST_DATABASE_URL: value }),
  ).toThrow();
});
const compose = {
  MEMBER_INTENT_TEST_COMPOSE: '1',
  NODE_ENV: 'test',
  DATABASE_HOST: 'postgres',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'postgres',
  DATABASE_USER: 'postgres',
  DATABASE_PASSWORD: 'synthetic-test-only',
};
test('explicit test-only compose opt-in uses the existing CI database credentials', () => {
  const url = memberIntentTestDatabaseUrl(compose);
  expect(url.hostname).toBe('postgres');
  expect(url.username).toBe(compose.DATABASE_USER);
  expect(url.password).toBe(compose.DATABASE_PASSWORD);
});
test.each([
  { ...compose, MEMBER_INTENT_TEST_COMPOSE: undefined },
  { ...compose, NODE_ENV: 'production' },
  { ...compose, DATABASE_HOST: 'database.example' },
  { ...compose, DATABASE_PASSWORD: undefined },
  {},
])('compose connection requires every guard: %j', (env) => {
  expect(() => memberIntentTestDatabaseUrl(env)).toThrow();
});
