import { ManualReviewToolService } from './manualReviewToolService.js';

test.each(['accepted', 'unavailable'])(
  'dequeue resumes stored room intent and retains failures: %s',
  async (kind) => {
    const recorded = { job: { id: 'recorded' }, lockToken: 'lock' };
    const next = { job: { id: 'new-job' }, lockToken: 'new-lock' };
    const dequeue = jest
      .fn()
      .mockResolvedValueOnce(recorded)
      .mockResolvedValue(next);
    const retry = jest.fn(async ({ jobId }: { jobId: string }) => {
      if (jobId !== 'recorded') return false;
      if (kind === 'unavailable') throw new Error('Bridge unavailable');
      return true;
    });
    const service = Object.assign(
      Object.create(ManualReviewToolService.prototype),
      {
        queueOps: {
          getQueueForOrgAndDangerouslyBypassPermissioning: async () => ({
            autoCloseJobs: kind === 'unavailable',
          }),
          dequeueNextJobWithLock: dequeue,
        },
        jobDecisioning: { retryRecordedRoomDecision: retry },
      },
    ) as ManualReviewToolService;
    await expect(
      service.dequeueNextJob({
        orgId: 'synthetic',
        queueId: 'queue',
        userId: 'new-reviewer',
      }),
    ).resolves.toEqual(kind === 'accepted' ? next : recorded);
    expect(retry).toHaveBeenCalledWith({
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: 'recorded',
      lockToken: 'lock',
      reviewerId: 'new-reviewer',
    });
    expect(dequeue).toHaveBeenCalledTimes(kind === 'accepted' ? 2 : 1);
  },
);

test('appeal queue metadata selects appeal dequeue and passes the recorded recovery scope', async () => {
  const recorded = { job: { id: 'recorded-appeal' }, lockToken: 'lock' };
  const next = {
    job: {
      id: 'fresh-appeal',
      payload: { item: { itemId: 'item', itemTypeIdentifier: { id: 'type' } } },
    },
    lockToken: 'new-lock',
  };
  const getPartialItem = jest.fn(async () => null);
  const dequeueAppeal = jest
    .fn()
    .mockResolvedValueOnce(recorded)
    .mockResolvedValue(next);
  const dequeueDefault = jest.fn();
  const retry = jest.fn(
    async ({ jobId }: { jobId: string }) => jobId === 'recorded-appeal',
  );
  const service = Object.assign(
    Object.create(ManualReviewToolService.prototype),
    {
      queueOps: {
        getQueueForOrgAndDangerouslyBypassPermissioning: async () => ({
          isAppealsQueue: true,
          autoCloseJobs: true,
        }),
        dequeueNextAppealJobWithLock: dequeueAppeal,
        dequeueNextJobWithLock: dequeueDefault,
      },
      jobDecisioning: { retryRecordedRoomDecision: retry },
      partialItemsService: { getPartialItem },
    },
  ) as ManualReviewToolService;
  await expect(
    service.dequeueNextJob({
      orgId: 'synthetic',
      queueId: 'appeals',
      userId: 'staff',
    }),
  ).resolves.toEqual(next);
  expect(dequeueDefault).not.toHaveBeenCalled();
  expect(dequeueAppeal).toHaveBeenCalledTimes(2);
  expect(getPartialItem).toHaveBeenCalledTimes(1);
  expect(getPartialItem).toHaveBeenCalledWith('synthetic', {
    id: 'item',
    typeId: 'type',
  });
  expect(retry).toHaveBeenCalledWith(
    expect.objectContaining({ jobId: 'recorded-appeal', isAppealsQueue: true }),
  );
});
