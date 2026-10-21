/* eslint-disable functional/immutable-data -- Owned barriers and injected lost acknowledgements model concurrent Redis operations. */
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

import { memberIntentTestDatabaseUrl } from '../../../test/memberIntentTestDatabase.js';
import { jsonStringify } from '../../../utils/encoding.js';
import { type ManualReviewToolServicePg } from '../dbTypes.js';
import QueueOperations from './QueueOperations.js';

const connection = {
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT),
};
const databaseName = `coop_ordinary_locks_${randomUUID().replaceAll('-', '')}`;
let database: Kysely<ManualReviewToolServicePg>;
let cleanup = async () => {};
beforeAll(async () => {
  const url = memberIntentTestDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = `/${databaseName}`;
  database = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString() }),
    }),
  });
  cleanup = async () => {
    await database.destroy();
    await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  };
  await sql`CREATE SCHEMA manual_review_tool; CREATE TABLE manual_review_tool.manual_review_decisions (id uuid PRIMARY KEY, org_id text, job_payload jsonb, decision_components jsonb[], related_actions jsonb[])`.execute(
    database,
  );
});
afterAll(async () => cleanup());
function barrier() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function fixture() {
  const queueId = `ordinary-${randomUUID()}`;
  const prefix = `test-ordinary-${randomUUID()}`;
  const queue = new Queue(queueId, { connection, prefix });
  const ids = [randomUUID(), randomUUID()];
  const jobs = ids.map((id) => ({
    id: `${Buffer.from(id).toString('base64url')}:${Buffer.from(id).toString('base64url')}`,
    orgId: 'synthetic',
  }));
  for (const [index, job] of jobs.entries()) {
    await queue.add('review', job, {
      jobId: ids[index]!,
      removeOnComplete: true,
    });
    await sql`INSERT INTO manual_review_tool.manual_review_decisions VALUES (${ids[index]}::uuid, 'synthetic', ${jsonStringify(job)}::jsonb, ARRAY[]::jsonb[], ARRAY[]::jsonb[])`.execute(
      database,
    );
  }
  const unused = undefined as never;
  const ops = new QueueOperations(database, database, unused, unused);
  Object.assign(ops, { getOrCreateBullQueue: async () => queue });
  return {
    queue,
    queueId,
    prefix,
    jobs,
    ids,
    ops,
    close: async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    },
  };
}

test('different ordinary jobs complete concurrently without a queue-wide refusal', async () => {
  const f = await fixture();
  const entered = barrier(),
    resume = barrier();
  let paused = false;
  Object.assign(f.ops, {
    getOrCreateBullQueue: async () => {
      if (!paused) {
        paused = true;
        entered.release();
        await resume.wait;
      }
      return f.queue;
    },
  });
  const remove = async (index: number) =>
    f.ops.removeJobAllowingInvokerLock({
      orgId: 'synthetic',
      queueId: f.queueId,
      jobId: f.jobs[index]!.id as never,
      invokerUserId: 'staff',
    });
  const first = remove(0);
  try {
    await entered.wait;
    expect(await remove(1)).toBe(true);
    resume.release();
    expect(await first).toBe(true);
    expect(await f.queue.getJob(f.ids[0]!)).toBeUndefined();
    expect(await f.queue.getJob(f.ids[1]!)).toBeUndefined();
  } finally {
    resume.release();
    await first.catch(() => {});
    await f.close();
  }
});

test('lost completion acknowledgement never removes a replacement with the same physical Bull id', async () => {
  const f = await fixture();
  const worker = new Worker(f.queueId, undefined, {
    connection,
    prefix: f.prefix,
    autorun: false,
  });
  const active = await worker.getNextJob('staff');
  if (!active) throw new Error('Expected active ordinary job');
  const oldId = active.data.id;
  const bullId = active.id!;
  const replacement = {
    ...active.data,
    id: `${Buffer.from(bullId).toString('base64url')}:${Buffer.from(randomUUID()).toString('base64url')}`,
  };
  const realGet = f.queue.getJob.bind(f.queue);
  let injected = false;
  jest.spyOn(f.queue, 'getJob').mockImplementation(async (id) => {
    const job = await realGet(id);
    if (job && job.data.id === oldId && !injected) {
      injected = true;
      const move = job.moveToCompleted.bind(job);
      jest.spyOn(job, 'moveToCompleted').mockImplementation(async (...args) => {
        await move(...args);
        await f.queue.add('replacement', replacement, {
          jobId: bullId,
          removeOnComplete: true,
        });
        throw new Error('Lost completion acknowledgement');
      });
    }
    return job;
  });
  try {
    await f.ops.removeJob({
      orgId: 'synthetic',
      queueId: f.queueId,
      jobId: oldId as never,
      lockToken: 'staff',
    });
    expect((await realGet(bullId))?.data.id).toBe(replacement.id);
  } finally {
    await worker.close();
    await f.close();
  }
});
