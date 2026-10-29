import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateChecklist } from './pr-checklist.mjs';

function repository(t, files, mappings) {
  const cwd = mkdtempSync(join(tmpdir(), 'coop-checklist-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const put = (name, body) => {
    mkdirSync(join(cwd, name, '..'), { recursive: true });
    writeFileSync(join(cwd, name), body);
  };
  git('init', '-q');
  git('config', 'user.name', 'Synthetic Checklist Test');
  git('config', 'user.email', 'synthetic@example.invalid');
  put('.github/workflows/checklistConfig.json', JSON.stringify({ mappings }));
  for (const [path, body] of Object.entries(files)) put(path, body);
  git('add', '.');
  git('commit', '-qm', 'synthetic base');
  const base = git('rev-parse', 'HEAD');
  const finish = () => {
    git('add', '-A');
    git('commit', '-qm', 'synthetic change');
    const head = git('rev-parse', 'HEAD');
    const event = {
      number: 23,
      repository: { full_name: 'synthetic/coop' },
      pull_request: { number: 23, base: { sha: base }, head: { sha: head } },
    };
    return { event, head, base };
  };
  return { cwd, git, put, finish };
}

test('local diff evaluates configured triggers past the full-patch 300-file cap', (t) => {
  const repo = repository(t, {}, [
    {
      paths: ['db/src/scripts/**'],
      triggers: ['create table', 'add column'],
      items: ['Check SQL constraints'],
    },
  ]);
  for (let i = 0; i < 350; i++)
    repo.put(
      `unrelated/file-${i}.txt`,
      'create table does not match this path\n',
    );
  repo.put('db/src/scripts/late.sql', 'CREATE TABLE synthetic (id text);\n');
  const { event } = repo.finish();
  assert.deepEqual(generateChecklist({ cwd: repo.cwd, event }).items, [
    { label: 'Check SQL constraints', paths: ['db/src/scripts/late.sql'] },
  ]);
});

test('brace paths, regex/case-insensitive triggers, context/removals, always and deduplication retain generation semantics', (t) => {
  const repo = repository(
    t,
    {
      'server/models/ActionModel.ts': 'declare field: string;\n',
      'signals/one.ts': 'keep\n',
    },
    [
      {
        paths: ['server/models/**/{ContentTypeModel,ActionModel}.ts'],
        triggers: ['declare'],
        items: ['Update history'],
      },
      {
        paths: 'signals/**/*.ts',
        triggers: ['async run\\('],
        items: ['Classify errors', 'Classify errors'],
      },
      { paths: 'never/**', triggers: 'always', items: ['Always check'] },
    ],
  );
  repo.put('server/models/ActionModel.ts', 'new field\n');
  repo.put('signals/one.ts', 'ASYNC run() {}\n');
  repo.put('signals/two.ts', 'unrelated but matching path\n');
  const { event } = repo.finish();
  assert.deepEqual(generateChecklist({ cwd: repo.cwd, event }).items, [
    { label: 'Update history', paths: ['server/models/ActionModel.ts'] },
    { label: 'Classify errors', paths: ['signals/one.ts', 'signals/two.ts'] },
    { label: 'Always check', paths: [] },
  ]);
});

test('unmodified rename has no triggering hunks and a modified rename includes both paths', (t) => {
  const repo = repository(
    t,
    { 'db/old.sql': 'CREATE TABLE synthetic (id text);\n'.repeat(10) },
    [{ paths: ['db/**'], triggers: ['create table'], items: ['Check SQL'] }],
  );
  repo.git('mv', 'db/old.sql', 'db/new.sql');
  const renamed = repo.finish();
  assert.deepEqual(
    generateChecklist({ cwd: repo.cwd, event: renamed.event }).items,
    [],
  );
  repo.put(
    'db/new.sql',
    'CREATE TABLE synthetic (id text);\n'.repeat(10) + 'ADD COLUMN example\n',
  );
  const { event } = repo.finish();
  assert.deepEqual(generateChecklist({ cwd: repo.cwd, event }).items, [
    { label: 'Check SQL', paths: ['db/old.sql', 'db/new.sql'] },
  ]);
});

test('configured globstar includes dot paths, and unsupported patterns fail closed', (t) => {
  const repo = repository(t, {}, [
    {
      paths: ['db/**'],
      triggers: ['create table'],
      items: ['Check hidden SQL'],
    },
  ]);
  repo.put(
    'db/.internal/.migration.sql',
    'CREATE TABLE synthetic (id text);\n',
  );
  const { event } = repo.finish();
  assert.deepEqual(generateChecklist({ cwd: repo.cwd, event }).items, [
    { label: 'Check hidden SQL', paths: ['db/.internal/.migration.sql'] },
  ]);
  repo.put(
    '.github/workflows/checklistConfig.json',
    JSON.stringify({
      mappings: [
        {
          paths: ['db/[a-z].sql'],
          triggers: ['create table'],
          items: ['Unsupported glob'],
        },
      ],
    }),
  );
  repo.git('add', '.');
  repo.git('commit', '-qm', 'unsupported synthetic glob');
  event.pull_request.head.sha = repo.git('rev-parse', 'HEAD');
  assert.throws(
    () => generateChecklist({ cwd: repo.cwd, event }),
    /Unsupported checklist path pattern/,
  );
});

test('missing commit, malformed configuration and invalid head fail instead of returning an empty checklist', (t) => {
  const repo = repository(t, {}, [
    { triggers: ['always'], items: ['Required'] },
  ]);
  repo.put('file.txt', 'change');
  const { event } = repo.finish();
  assert.throws(() =>
    generateChecklist({
      cwd: repo.cwd,
      event: {
        ...event,
        pull_request: { ...event.pull_request, head: { sha: 'f'.repeat(40) } },
      },
    }),
  );
  assert.throws(() =>
    generateChecklist({
      cwd: repo.cwd,
      event: {
        ...event,
        pull_request: {
          ...event.pull_request,
          head: { sha: '$(touch unsafe)' },
        },
      },
    }),
  );
  repo.put('.github/workflows/checklistConfig.json', '{}');
  repo.git('add', '.');
  repo.git('commit', '-qm', 'invalid synthetic config');
  event.pull_request.head.sha = repo.git('rev-parse', 'HEAD');
  assert.throws(() => generateChecklist({ cwd: repo.cwd, event }));
});

// Execute the actual no-checkout publication step, with only HTTP mocked.
function publicationScript() {
  const workflow = readFileSync(
    new URL('../workflows/checklist.yaml', import.meta.url),
    'utf8',
  );
  const marker = "          node --input-type=module <<'CHECKLIST_PUBLISH'\n";
  const source = workflow
    .split(marker)[1]
    ?.split('\n          CHECKLIST_PUBLISH')[0];
  assert.ok(
    source,
    'publication step must remain testable without a PR checkout',
  );
  return source
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}
async function publish({
  items = [{ label: 'Check SQL', paths: ['db/one.sql'] }],
  comments = [],
  fail,
  generation = 'success',
  head = 'a'.repeat(40),
  config = {
    mappings: [
      { paths: ['db/**'], triggers: ['create table'], items: ['Check SQL'] },
    ],
  },
} = {}) {
  const configuration = JSON.stringify(config);
  const { createHash } = await import('node:crypto');
  const payload = {
    version: 1,
    repository: 'synthetic/coop',
    number: 23,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    configurationDigest: createHash('sha256')
      .update(configuration)
      .digest('hex'),
    items,
  };
  const env = {
    CHECKLIST_DATA: JSON.stringify(payload),
    GENERATION_RESULT: generation,
    GITHUB_REPOSITORY: 'synthetic/coop',
    PR_NUMBER: '23',
    EXPECTED_HEAD: 'a'.repeat(40),
    EXPECTED_BASE: 'b'.repeat(40),
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_TOKEN: 'synthetic',
  };
  const writes = [];
  const requests = [];
  const fetch = async (url, opts) => {
    requests.push(String(url));
    const path = new URL(url).pathname;
    if (opts.method !== 'GET') {
      writes.push({ method: opts.method, path, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({}) };
    }
    if (fail) return { ok: false, status: 500 };
    const result = path.endsWith('/pulls/23')
      ? { head: { sha: head }, base: { sha: 'b'.repeat(40) } }
      : path.includes('/contents/')
        ? {
            encoding: 'base64',
            content: Buffer.from(configuration).toString('base64'),
          }
        : new URL(url).searchParams.get('page') === '1'
          ? comments
          : [];
    return { ok: true, json: async () => result };
  };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  let error;
  try {
    await new AsyncFunction('process', 'fetch', 'Buffer', publicationScript())(
      { env },
      fetch,
      Buffer,
    );
  } catch (value) {
    error = value;
  }
  return { writes, requests, error };
}

test('publication updates the bot comment in place, preserving checked state and retired item history', async () => {
  const result = await publish({
    comments: [
      {
        id: 1,
        user: { login: 'someone-else' },
        body: '**Checklist:**\n- [x] Check SQL (`db/one.sql`)',
      },
      {
        id: 2,
        user: { login: 'github-actions[bot]' },
        body: '**Checklist:**\n- [x] Check SQL (`db/one.sql`)\n- [x] Prior checklist item',
      },
    ],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].method, 'PATCH');
  assert.equal(
    result.writes[0].path,
    '/repos/synthetic/coop/issues/comments/2',
  );
  assert.match(
    result.writes[0].body.body,
    /- \[x\] Check SQL \(`db\/one.sql`\)/,
  );
  assert.match(
    result.writes[0].body.body,
    /Previous checklist items[\s\S]*- \[x\] Prior checklist item/,
  );
  assert.equal(
    result.writes.some((write) => write.method === 'DELETE'),
    false,
  );
});

test('publication preserves legacy unquoted path checkbox state and paginates comment history', async () => {
  const comments = Array.from({ length: 100 }, (_, id) => ({
    id: id + 1,
    user: { login: 'github-actions[bot]' },
    body:
      id === 99 ? '**Checklist:**\n- [x] Check SQL (db/one.sql)' : 'unrelated',
  }));
  const result = await publish({ comments });
  assert.equal(result.error, undefined);
  assert.ok(result.requests.some((url) => url.includes('page=2')));
  assert.match(result.writes[0].body.body, /- \[x\] Check SQL/);
});

test('incomplete generation, stale source, API failure and malformed output never publish a successful empty result', async () => {
  for (const opts of [
    { generation: 'failure' },
    { head: 'c'.repeat(40) },
    { fail: true },
    { items: [{ label: 'unconfigured injected text', paths: [] }] },
    { items: 'invalid' },
  ]) {
    const result = await publish(opts);
    assert.ok(result.error);
    assert.deepEqual(result.writes, []);
  }
});

test('no matching dynamic rules needs no new comment; untrusted filenames stay data', async () => {
  const empty = await publish({ items: [] });
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.writes, []);
  const result = await publish({
    items: [{ label: 'Check SQL', paths: ['db/$(touch nope);`@everyone.sql'] }],
  });
  assert.equal(result.error, undefined);
  assert.match(result.writes[0].body.body, /&#96;/);
  assert.equal(result.writes.length, 1);
});
