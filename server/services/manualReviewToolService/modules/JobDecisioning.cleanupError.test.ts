import { roomDecisionSettings } from '../../../test/roomDecisionSettings.js';
import JobDecisioning from './JobDecisioning.js';

test('cleanup failure after an ordinary decision is recorded never claims recording failed', async () => {
  const guid = '10000000-0000-4000-8000-000000000019';
  const job = {
    id: `item:${Buffer.from(guid).toString('base64url')}`,
    orgId: 'synthetic',
    payload: {
      kind: 'DEFAULT',
      item: {
        itemId: 'ordinary-item',
        itemTypeIdentifier: { id: 'ordinary-type' },
        data: {},
      },
    },
  };
  const record = jest.fn(async () => {});
  const queue = {
    getJobs: async () => [job],
    removeJob: jest.fn(async () => {
      throw new Error('Redis cleanup unavailable');
    }),
  };
  const publish = jest.fn(async () => {});
  const service = new JobDecisioning(
    queue as never,
    { insertInto: () => ({ values: () => ({ execute: record }) }) } as never,
    Object.assign(
      async () => [{ id: 'ordinary-action', name: 'ordinary_action' }],
      { close: async () => {} },
    ) as never,
    publish,
    { getItemType: async () => undefined } as never,
    { addSpan: jest.fn() } as never,
    roomDecisionSettings() as never,
  );
  await expect(
    service.submitDecision({
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: job.id,
      lockToken: 'staff',
      reviewerId: 'staff',
      reviewerEmail: 'staff@example.invalid',
      relatedActions: [],
      decisionComponents: [
        {
          type: 'CUSTOM_ACTION',
          actions: [{ id: 'ordinary-action' }],
          policies: [],
        },
      ],
    } as never),
  ).rejects.toMatchObject({
    detail: expect.stringContaining(
      'was recorded, but queue cleanup did not finish',
    ),
  });
  expect(record).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});
