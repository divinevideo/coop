import { ActionAPI } from './ActionApi.js';

test('manual membership operation durably registers before publisher retries and reuses persistent identity', async () => {
  const recorded = jest.fn(async () => {});
  const publish = jest.fn(async () => []);
  const api = new ActionAPI(
    { recordManualRoomIntent: recorded, publishActions: publish } as never,
    {
      getActions: async () => [
        {
          id: 'action',
          name: 'concord_ban_member',
          actionType: 'CUSTOM_ACTION',
          callbackUrl: 'https://moderation.example/v1/decisions',
          customMrtApiParams: null,
        },
      ],
      getPoliciesByIds: async () => [],
    } as never,
    {} as never,
    {
      getItemByIdentifier: async () => ({
        latestSubmission: {
          itemId: 'item',
          itemType: { id: 'type', kind: 'USER', name: 'concord_member' },
          data: { case_id: '10000000-0000-4000-8000-000000000001' },
        },
      }),
    } as never,
    (async () => ({
      id: 'type',
      kind: 'USER',
      name: 'concord_member',
    })) as never,
  );
  const opts = {
    itemIds: ['item'],
    actionIds: ['action'],
    itemTypeId: 'type',
    policyIds: [],
    orgId: 'synthetic',
    actorId: 'synthetic-staff',
    actorEmail: 'staff@example.invalid',
    actorNote: 'Exact synthetic reason',
    operationId: '10000000-0000-4000-8000-000000000002',
  };
  await api.bulkExecuteActions(opts);
  await api.bulkExecuteActions(opts);
  expect(recorded).toHaveBeenCalledTimes(2);
  expect(recorded.mock.calls[0]).toEqual(recorded.mock.calls[1]);
  expect(recorded.mock.invocationCallOrder[0]).toBeLessThan(
    publish.mock.invocationCallOrder[0],
  );
  expect(recorded.mock.calls[0]).toEqual([
    expect.objectContaining({
      correlationId: `manual-action-run:${opts.operationId}`,
      actorId: opts.actorId,
      note: opts.actorNote,
      parameters: {},
    }),
    'https://moderation.example/v1/decisions',
  ]);
});
