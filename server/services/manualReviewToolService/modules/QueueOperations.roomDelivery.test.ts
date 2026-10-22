import QueueOperations from './QueueOperations.js';

test.each(['default', 'appeal'])(
  '%s dequeue retains recorded room intent and keeps ordinary cleanup',
  async (kind) => {
    for (const roomDeliveryRequired of [true, false]) {
      for (const accepted of [true, false]) {
        const job = {
          data: { id: 'synthetic:10000000-0000-4000-8000-000000000001' },
        };
        const row = {
          job_payload: {
            roomDeliveryRequired,
            payload: {
              item: { itemId: 'case', itemTypeIdentifier: { id: 'room-type' } },
            },
          },
          decision_components: [
            {
              type: 'CUSTOM_ACTION',
              actions: [{ id: 'room-action' }, { id: 'room-action' }],
            },
          ],
          related_actions: [],
        };
        const query = {
          select: () => query,
          where: () => query,
          executeTakeFirst: async () => row,
        };
        const primaryQuery = {
          select: () => primaryQuery,
          where: () => primaryQuery,
          execute: jest
            .fn()
            .mockResolvedValue(
              accepted ? [{ execution_id: 'one-execution' }] : [],
            ),
        };
        const primarySelect = jest.fn().mockReturnValue(primaryQuery);
        const service = new QueueOperations(
          { selectFrom: primarySelect } as never,
          { selectFrom: () => query } as never,
          {} as never,
          {} as never,
        );
        const worker = {
          getNextJob: jest
            .fn()
            .mockResolvedValueOnce(job)
            .mockResolvedValue(null),
        };
        // eslint-disable-next-line functional/immutable-data -- Replace only cached Bull worker producers with isolated test workers.
        Object.assign(service, {
          getBullWorker: async () => worker,
          getBullAppealWorker: async () => worker,
        });
        jest.spyOn(service, 'checkQueueExists').mockResolvedValue(undefined);
        jest.spyOn(service, 'legacyJobToJob').mockResolvedValue(job as never);
        const remove = jest
          .spyOn(service, 'removeJob')
          .mockResolvedValue(undefined);
        const input = {
          orgId: 'synthetic',
          queueId: 'queue',
          lockToken: 'lock',
        };
        const result =
          kind === 'appeal'
            ? await service.dequeueNextAppealJobWithLock(input)
            : await service.dequeueNextJobWithLock(input);
        if (roomDeliveryRequired && !accepted) {
          expect(result).toEqual({ job: job.data, lockToken: 'lock' });
          expect(remove).not.toHaveBeenCalled();
          expect(primarySelect.mock.calls).toEqual([
            ['concord_integration.room_execution_state'],
            ['concord_integration.member_intents'],
            ['concord_integration.room_execution_acceptances'],
          ]);
        } else {
          expect(result).toBeNull();
          expect(remove).toHaveBeenCalledTimes(1);
          if (!roomDeliveryRequired)
            expect(primarySelect).not.toHaveBeenCalled();
        }
      }
    }
  },
);
