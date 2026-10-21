import { actor } from '../../../test/memberIntentFixtures.js';
import { roomDecisionSettings } from '../../../test/roomDecisionSettings.js';
import JobDecisioning from './JobDecisioning.js';

test.each(['global_deleted_action', 'room_ignore'])(
  'non-enforcement retries remove an already-recorded job without action lookup: %s',
  async (kind) => {
    const job = {
      id: 'synthetic:10000000-0000-4000-8000-000000000005',
      orgId: 'synthetic',
      payload: {
        kind: 'DEFAULT',
        item: {
          itemId: 'global-item',
          itemTypeIdentifier: {
            id: kind === 'room_ignore' ? 'room-type' : 'global-type',
          },
          data: {},
        },
      },
    };
    const prior = {
      job_payload: job,
      queue_id: 'queue',
      reviewer_id: 'staff',
      related_actions: [],
      decision_components:
        kind === 'room_ignore'
          ? [{ type: 'IGNORE' }]
          : [{ type: 'CUSTOM_ACTION', actions: [{ id: 'deleted-action' }] }],
    };
    const select = {
      where() {
        return select;
      },
      selectAll() {
        return select;
      },
      executeTakeFirst: async () => prior,
    };
    const pg = {
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            throw new Error(
              'duplicate key value violates unique constraint "manual_review_decisions_pkey"',
            );
          },
        }),
      }),
      selectFrom: () => select,
    };
    const queue = {
      getJobs: async () => [job],
      removeJob: jest.fn(async () => {}),
    };
    const getActions = Object.assign(
      jest.fn(async () => {
        throw new Error('Action lookup unavailable');
      }),
      { close: async () => {} },
    );
    const publish = jest.fn(async () => {});
    const service = new JobDecisioning(
      queue as never,
      pg as never,
      getActions as never,
      publish,
      {
        getItemType:
          kind === 'room_ignore'
            ? jest
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockResolvedValue({ name: 'concord_message' })
            : async () => undefined,
      } as never,
      { addSpan: jest.fn() } as never,
      roomDecisionSettings() as never,
      async () => actor,
    );
    const input = {
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: job.id,
      lockToken: 'lock',
      reviewerId: 'staff',
      reviewerEmail: 'synthetic@example.invalid',
      relatedActions: [],
      decisionComponents: [{ type: 'IGNORE' }],
    } as unknown as Parameters<JobDecisioning['submitDecision']>[0];
    await service.submitDecision(input).catch(() => {});
    expect(queue.removeJob).toHaveBeenCalledTimes(1);
    expect(getActions).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  },
);
