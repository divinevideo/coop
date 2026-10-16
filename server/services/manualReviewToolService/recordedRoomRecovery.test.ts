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
