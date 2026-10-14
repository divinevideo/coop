/* eslint-disable functional/immutable-data -- Tests deliberately vary authorization fixtures and record side-effect order. */
import { jsonParse, jsonStringify } from '../../../utils/encoding.js';
import JobDecisioning from './JobDecisioning.js';

test('a room job stays reviewable when durable enforcement acceptance fails', async () => {
  const calls: string[] = [];
  const job = {
    id: 'synthetic:10000000-0000-4000-8000-000000000001',
    orgId: 'synthetic',
    payload: {
      kind: 'DEFAULT',
      item: {
        itemId: 'case',
        itemTypeIdentifier: { id: 'room-type' },
        data: {},
      },
    },
  };
  const queue = {
    getJobs: async () => [job],
    removeJob: jest.fn(async () => {
      calls.push('remove');
    }),
  };
  const pg = {
    insertInto: () => ({
      values: () => ({
        execute: async () => {
          calls.push('log');
        },
      }),
    }),
  };
  const publish = jest.fn(async () => {
    calls.push('deliver');
    throw new Error('unavailable');
  });
  const service = new JobDecisioning(
    queue as never,
    pg as never,
    Object.assign(
      async () => [{ id: 'room-action', name: 'concord_remove_message' }],
      { close: async () => {} },
    ) as never,
    publish,
    { getItemType: async () => undefined } as never,
    { addSpan: jest.fn() } as never,
  );
  const input = {
    orgId: 'synthetic',
    queueId: 'queue',
    jobId: job.id,
    lockToken: 'lock',
    reviewerId: 'staff',
    reviewerEmail: 'synthetic@example.invalid',
    relatedActions: [],
    decisionReason: 'Synthetic reason',
    decisionComponents: [
      {
        type: 'CUSTOM_ACTION',
        actions: [{ id: 'room-action' }],
        policyIds: [],
      },
    ],
  } as unknown as Parameters<JobDecisioning['submitDecision']>[0];
  await expect(service.submitDecision(input)).rejects.toThrow();
  expect(queue.removeJob).not.toHaveBeenCalled();
  expect(calls).toEqual(['log', 'deliver']);
});

test.each(['action', 'reason', 'parameters', 'related', 'reviewer', 'same'])(
  'room retry preserves recorded intent after JSON storage and response loss: %s',
  async (change) => {
    const job = {
      id: 'synthetic:10000000-0000-4000-8000-000000000002',
      orgId: 'synthetic',
      payload: {
        kind: 'DEFAULT',
        item: {
          itemId: 'case',
          itemTypeIdentifier: { id: 'room-type' },
          data: {},
        },
      },
    };
    let recorded: any;
    const insert = {
      values(value: unknown) {
        return {
          execute: async () => {
            if (recorded)
              throw new Error(
                'duplicate key value violates unique constraint "manual_review_decisions_pkey"',
              );
            // JSONB drops undefined object fields instead of retaining JS objects.
            recorded = jsonParse(jsonStringify(value));
          },
        };
      },
    };
    const select = {
      where() {
        return select;
      },
      selectAll() {
        return select;
      },
      executeTakeFirst: async () => recorded,
    };
    const pg = { insertInto: () => insert, selectFrom: () => select };
    const queue = {
      getJobs: async () => [job],
      removeJob: jest.fn(async () => {}),
    };
    const publish = jest
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue(undefined);
    const service = new JobDecisioning(
      queue as never,
      pg as never,
      Object.assign(
        async () => [{ id: 'room-action', name: 'concord_remove_message' }],
        { close: async () => {} },
      ) as never,
      publish,
      { getItemType: async () => undefined } as never,
      { addSpan: jest.fn() } as never,
    );
    const input: any = {
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: job.id,
      lockToken: 'lock',
      reviewerId: 'original-staff',
      reviewerEmail: 'original@example.invalid',
      relatedActions: [],
      decisionReason: 'Original synthetic reason',
      decisionComponents: [
        {
          type: 'CUSTOM_ACTION',
          actions: [{ id: 'room-action' }],
          policies: [],
          itemIds: ['case'],
          itemTypeId: 'room-type',
          // The GraphQL resolver creates this own property even when absent.
          actionIdsToMrtApiParamDecisionPayload: undefined,
        },
      ],
    };
    await expect(service.submitDecision(input)).rejects.toThrow(
      'response lost',
    );
    const retry = {
      ...input,
      ...(change === 'action'
        ? { decisionComponents: [{ type: 'IGNORE' }] }
        : change === 'reason'
          ? { decisionReason: 'Changed intent' }
          : change === 'parameters'
            ? {
                decisionComponents: [
                  {
                    ...input.decisionComponents[0],
                    actionIdsToMrtApiParamDecisionPayload: {
                      'room-action': { discordGuildConfirmed: true },
                    },
                  },
                ],
              }
            : change === 'related'
              ? {
                  relatedActions: [
                    {
                      actionIds: ['room-action'],
                      itemIds: ['other-case'],
                      itemTypeId: 'room-type',
                      policyIds: [],
                    },
                  ],
                }
              : change === 'reviewer'
                ? {
                    reviewerId: 'different-staff',
                    reviewerEmail: 'different@example.invalid',
                  }
                : {}),
    };
    await service.submitDecision(retry).catch(() => {});
    if (['action', 'reason', 'parameters', 'related'].includes(change)) {
      expect(publish).toHaveBeenCalledTimes(1);
      expect(queue.removeJob).not.toHaveBeenCalled();
    } else {
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1][0].reviewerId).toBe('original-staff');
      expect(publish.mock.calls[1][0].decisionReason).toBe(
        'Original synthetic reason',
      );
      expect(queue.removeJob).toHaveBeenCalledTimes(1);
    }
  },
);
