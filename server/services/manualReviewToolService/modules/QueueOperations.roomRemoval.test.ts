import { Kysely, PostgresDialect } from 'kysely';

import { UserPermission } from '../../userManagementService/index.js';
import QueueOperations from './QueueOperations.js';

function fixture(
  settlement: 'pending' | 'accepted' | 'stopped' | 'ordinary',
  commitFailure?: Error,
) {
  const row = {
    job_payload: { roomDeliveryRequired: settlement !== 'ordinary' },
    decision_components: [
      { type: 'CUSTOM_ACTION', actions: [{ id: 'remove' }] },
    ],
    related_actions: [],
  };
  const pool = {
    connect: async () => ({
      release: () => {},
      query: async (text: string) => {
        if (text === 'commit' && commitFailure) throw commitFailure;
        return {
          rows: text.includes('pg_try_advisory_xact_lock')
            ? [{ locked: true }]
            : text.includes('manual_review_decisions')
              ? [row]
              : (text.includes('room_execution_state') &&
                    settlement === 'stopped') ||
                  (text.includes('room_execution_acceptances') &&
                    settlement === 'accepted')
                ? [{ execution_id: 'execution' }]
                : [],
        };
      },
    }),
    end: async () => {},
  };
  const pg = new Kysely({
    dialect: new PostgresDialect({ pool: pool as never }),
  });
  const service = new QueueOperations(
    pg as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const remove = jest.fn(async () => 1);
  const complete = jest.fn(async () => {});
  const getQueue = jest.fn(async () => ({
    remove,
    getJob: async () => ({
      data: { id: 'synthetic:10000000-0000-4000-8000-000000000001' },
      moveToCompleted: complete,
    }),
  }));
  // eslint-disable-next-line functional/immutable-data -- Replace only the cached Bull producer with this owned synthetic queue.
  Object.assign(service, { getOrCreateBullQueue: getQueue });
  return { service, remove, complete, getQueue };
}

test.each(['pending', 'accepted', 'stopped', 'ordinary'] as const)(
  'direct queue removal respects recorded room settlement: %s',
  async (settlement) => {
    const { service, remove, complete } = fixture(settlement);
    const result = await service.removeJobAllowingInvokerLock({
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: 'synthetic:10000000-0000-4000-8000-000000000001' as never,
      invokerUserId: 'staff',
    });
    expect(result).toBe(settlement !== 'pending');
    expect(remove).toHaveBeenCalledTimes(settlement === 'pending' ? 0 : 1);
    expect(complete).not.toHaveBeenCalled();
  },
);

test('bulk queue purge refuses recorded room delivery rather than replacing audited stop', async () => {
  const { service, getQueue } = fixture('pending');
  await expect(
    service.deleteAllJobsFromQueue({
      orgId: 'synthetic',
      queueId: 'queue',
      userPermissions: [UserPermission.MANAGE_ORG],
    }),
  ).rejects.toThrow('Room');
  expect(getQueue).not.toHaveBeenCalled();
});

test('normal queue completion cannot fall through to manual removal for unsettled room work', async () => {
  const { service, getQueue } = fixture('pending');
  await expect(
    service.removeJob({
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: 'synthetic:10000000-0000-4000-8000-000000000001' as never,
      lockToken: 'staff',
    }),
  ).rejects.toThrow('Room');
  expect(getQueue).not.toHaveBeenCalled();
});

test('Redis deletion followed by SQL commit failure is surfaced without replay', async () => {
  const failure = Object.assign(
    new Error('Synthetic post-Redis commit failure'),
    { code: '40001' },
  );
  const { service, remove } = fixture('ordinary', failure);
  await expect(
    service.removeJobAllowingInvokerLock({
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: 'synthetic:10000000-0000-4000-8000-000000000001' as never,
      invokerUserId: 'staff',
    }),
  ).rejects.toBe(failure);
  expect(remove).toHaveBeenCalledTimes(1);
});
