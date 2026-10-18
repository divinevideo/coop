import { ActionAPI } from './ActionApi.js';

test.each(['matching', 'wrong_action'])(
  'manual membership registers only its own generated action identity: %s',
  async (kind) => {
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
      operationId: `source-order-v1_${kind === 'matching' ? 'ban_member' : 'remove_message'}_10000000-0000-4000-8000-000000000002`,
    };
    if (kind === 'wrong_action') {
      await expect(api.bulkExecuteActions(opts)).rejects.toMatchObject({
        extensions: { roomAttemptOutcome: 'NOT_RECORDED' },
      });
      expect(recorded).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      return;
    }
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
  },
);

test.each(['validation', 'registration', 'publication'])(
  'only failures before a recording boundary mark this attempt unrecorded: %s',
  async (stage) => {
    const api = new ActionAPI(
      {
        recordManualRoomIntent: async () => {
          if (stage === 'registration')
            throw new Error('database acknowledgement lost');
        },
        publishActions: async () => {
          throw new Error('response lost');
        },
      } as never,
      {
        getActions: async () => [
          {
            id: 'action',
            name: 'concord_ban_member',
            actionType: 'CUSTOM_ACTION',
            customMrtApiParams: null,
          },
        ],
        getPoliciesByIds: async () => [],
      } as never,
      {} as never,
      {
        getItemByIdentifier: async () => ({
          latestSubmission: {
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
    const attempt = api.bulkExecuteActions({
      itemIds: ['item'],
      actionIds: ['action'],
      itemTypeId: 'type',
      policyIds: [],
      orgId: 'synthetic',
      actorId: 'staff',
      actorEmail: 'staff@example.invalid',
      actorNote: stage === 'validation' ? 'x'.repeat(5001) : 'Reason',
      operationId:
        'source-order-v1_ban_member_10000000-0000-4000-8000-000000000002',
    });
    if (stage === 'validation') {
      await expect(attempt).rejects.toMatchObject({
        extensions: { roomAttemptOutcome: 'NOT_RECORDED' },
      });
    } else {
      await expect(attempt).rejects.not.toHaveProperty(
        'extensions.roomAttemptOutcome',
      );
    }
  },
);
