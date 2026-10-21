/* eslint-disable functional/immutable-data -- Owned synthetic job storage and producer injection exercise real cache identity. */
import { Kysely, PostgresDialect } from 'kysely';

import { cached } from '../../../utils/caching.js';
import QueueOperations from './QueueOperations.js';

test.each([false, true])(
  'room registration reuses the queue cache across jobs; appeals=%s',
  async (isAppealsQueue) => {
    const pool = {
      connect: async () => ({
        release: () => {},
        query: async (text: string) => ({
          rows: text.includes('pg_try_advisory_xact_lock')
            ? [{ locked: true }]
            : [],
        }),
      }),
      end: async () => {},
    };
    const pg = new Kysely({
      dialect: new PostgresDialect({ pool: pool as never }),
    });
    const jobs = new Map<string, { data: { id: string } }>();
    const jobIds = ['first', 'second'].map((bullId) => {
      const jobId = `${Buffer.from(bullId).toString('base64url')}:${Buffer.from(`guid-${bullId}`).toString('base64url')}`;
      jobs.set(bullId, { data: { id: jobId } });
      return jobId;
    });
    const producer = jest.fn(
      async (_key: { orgId: string; queueId: string }) => ({
        getJob: async (bullId: string) => jobs.get(bullId),
      }),
    );
    const otherProducer = jest.fn(producer);
    const selected = cached({
      producer,
      directives: { freshUntilAge: 600 },
      numItemsLimit: 128,
    });
    const other = cached({
      producer: otherProducer,
      directives: { freshUntilAge: 600 },
      numItemsLimit: 128,
    });
    const service = new QueueOperations(
      pg as never,
      {} as never,
      {} as never,
      {} as never,
    );
    Object.assign(service, {
      getOrCreateBullQueue: isAppealsQueue ? other : selected,
      getOrCreateBullAppealQueue: isAppealsQueue ? selected : other,
    });
    const register = jest.fn(async () => 'registered');
    const queueKey = { orgId: 'synthetic', queueId: 'one-queue' };
    try {
      for (const jobId of jobIds) {
        await expect(
          service.withRoomDecisionRegistration(
            { ...queueKey, jobId: jobId as never, isAppealsQueue },
            register,
          ),
        ).resolves.toBe('registered');
      }
      // Ordinary callers use only QueueKey; they must share the same entry.
      await selected(queueKey);
      expect(producer).toHaveBeenCalledTimes(1);
      expect(producer).toHaveBeenCalledWith(queueKey);
      expect(otherProducer).not.toHaveBeenCalled();
      expect(register).toHaveBeenCalledTimes(2);

      // Cache reuse must still validate each complete external job identity.
      jobs.set('second', { data: { id: 'replacement-identity' } });
      await expect(
        service.withRoomDecisionRegistration(
          { ...queueKey, jobId: jobIds[1] as never, isAppealsQueue },
          register,
        ),
      ).rejects.toThrow('decision not recorded');
      expect(register).toHaveBeenCalledTimes(2);
      expect(producer).toHaveBeenCalledTimes(1);
    } finally {
      await selected.close();
      await other.close();
      await pg.destroy();
    }
  },
);
