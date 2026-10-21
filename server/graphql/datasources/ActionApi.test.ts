import ActionAPI from './ActionApi.js';

type ActionAPICtor = new (
  actionPublisher: {
    publishActions: jest.Mock;
    recordManualRoomIntent: jest.Mock;
  },
  moderationConfigService: {
    getActions: jest.Mock;
    getPoliciesByIds: jest.Mock;
  },
  tracer: unknown,
  itemInvestigationService: { getItemByIdentifier: jest.Mock },
  getItemTypeEventuallyConsistent: jest.Mock,
) => InstanceType<typeof ActionAPI>;

function makeApi(overrides?: { action?: Record<string, unknown> }) {
  const action = overrides?.action ?? {
    id: 'action-1',
    orgId: 'org-1',
    name: 'Ban User',
    actionType: 'CUSTOM_ACTION',
    callbackUrl: 'https://example.com',
    callbackUrlHeaders: null,
    callbackUrlBody: null,
    applyUserStrikes: false,
    customMrtApiParams: [
      {
        name: 'num_days',
        displayName: 'Number of days',
        type: 'NUMBER',
        required: true,
      },
      {
        name: 'reason',
        displayName: 'Reason',
        type: 'SELECT',
        required: false,
        options: [
          { value: 'spam', label: 'Spam' },
          { value: 'abuse', label: 'Abuse' },
        ],
      },
    ],
  };

  const publishActions = jest.fn().mockResolvedValue([]);
  const recordManualRoomIntent = jest.fn().mockResolvedValue(undefined);
  const getActions = jest.fn().mockResolvedValue([action]);
  const getPoliciesByIds = jest.fn().mockResolvedValue([]);
  const getItemByIdentifier = jest.fn().mockResolvedValue({
    latestSubmission: {
      itemId: 'item-1',
      data: { case_id: '10000000-0000-4000-8000-000000000002' },
      itemType: { id: 'type-1', kind: 'CONTENT', name: 'Social Post' },
    },
  });
  const getItemTypeEventuallyConsistent = jest.fn().mockResolvedValue({
    id: 'type-1',
    kind: 'CONTENT',
    name: 'Social Post',
  });

  const api = new (ActionAPI as unknown as ActionAPICtor)(
    { publishActions, recordManualRoomIntent },
    { getActions, getPoliciesByIds },
    {},
    { getItemByIdentifier },
    getItemTypeEventuallyConsistent,
  );

  return {
    api,
    publishActions,
    recordManualRoomIntent,
    getActions,
  };
}

const baseCallArgs = {
  itemIds: ['item-1'],
  actionIds: ['action-1'],
  itemTypeId: 'type-1',
  policyIds: [],
  orgId: 'org-1',
  actorId: 'actor-1',
  actorEmail: 'mod@example.com',
};

describe('ActionAPI.bulkExecuteActions', () => {
  it('passes validated parameter values and actorNote through to the publisher', async () => {
    const { api, publishActions } = makeApi();

    await api.bulkExecuteActions({
      ...baseCallArgs,
      actionIdToParameters: {
        'action-1': { num_days: 7, reason: 'spam' },
      },
      actorNote: 'Repeat offender',
    });

    expect(publishActions).toHaveBeenCalledTimes(1);
    const [triggered, ctx] = publishActions.mock.calls[0];
    expect(triggered[0].customMrtApiParamDecisionPayload).toEqual({
      num_days: 7,
      reason: 'spam',
    });
    expect(ctx.actorNote).toBe('Repeat offender');
    expect(ctx.actorEmail).toBe('mod@example.com');
    expect(ctx.correlationId).toMatch(/^manual-action-run:/);
  });

  it('rejects missing required parameters before any publish call', async () => {
    const { api, publishActions } = makeApi();

    await expect(
      api.bulkExecuteActions({
        ...baseCallArgs,
        actionIdToParameters: { 'action-1': {} }, // missing required num_days
      }),
    ).rejects.toThrow(/num_days/i);
    expect(publishActions).not.toHaveBeenCalled();
  });

  it('rejects unknown parameter keys', async () => {
    const { api, publishActions } = makeApi();

    await expect(
      api.bulkExecuteActions({
        ...baseCallArgs,
        actionIdToParameters: {
          'action-1': { num_days: 7, bogus_field: 'x' },
        },
      }),
    ).rejects.toThrow(/bogus_field|unknown/i);
    expect(publishActions).not.toHaveBeenCalled();
  });

  it('rejects type-mismatched parameter values', async () => {
    const { api, publishActions } = makeApi();

    await expect(
      api.bulkExecuteActions({
        ...baseCallArgs,
        actionIdToParameters: {
          'action-1': { num_days: 'seven' }, // string into a NUMBER field
        },
      }),
    ).rejects.toThrow();
    expect(publishActions).not.toHaveBeenCalled();
  });

  it('rejects an actorNote that exceeds the maximum length', async () => {
    const { api, publishActions } = makeApi();

    await expect(
      api.bulkExecuteActions({
        ...baseCallArgs,
        actionIdToParameters: { 'action-1': { num_days: 1 } },
        actorNote: 'x'.repeat(5001),
      }),
    ).rejects.toThrow(/note exceeds maximum length/i);
    expect(publishActions).not.toHaveBeenCalled();
  });

  it('forwards no parameter payload when the action has no spec and no values are supplied', async () => {
    const { api, publishActions } = makeApi({
      action: {
        id: 'action-1',
        orgId: 'org-1',
        name: 'Plain Action',
        actionType: 'CUSTOM_ACTION',
        callbackUrl: 'https://example.com',
        callbackUrlHeaders: null,
        callbackUrlBody: null,
        applyUserStrikes: false,
        customMrtApiParams: null,
      },
    });

    await api.bulkExecuteActions(baseCallArgs);

    const [triggered] = publishActions.mock.calls[0];
    expect(triggered[0].customMrtApiParamDecisionPayload).toBeUndefined();
  });
});

test('manual room retry reuses its operation after acceptance response loss', async () => {
  const { api, publishActions, recordManualRoomIntent } = makeApi({
    action: {
      id: 'action-1',
      name: 'concord_remove_message',
      actionType: 'CUSTOM_ACTION',
      customMrtApiParams: [],
    },
  });
  const input = {
    ...baseCallArgs,
    operationId: '10000000-0000-4000-8000-000000000001',
    actorNote: 'Synthetic reason',
  };
  publishActions
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce([]);
  await expect(api.bulkExecuteActions(input)).rejects.toThrow('response lost');
  await api.bulkExecuteActions(input);
  expect(recordManualRoomIntent).toHaveBeenCalledTimes(2);
  expect(recordManualRoomIntent.mock.calls[0]).toEqual(
    recordManualRoomIntent.mock.calls[1],
  );
  expect(publishActions.mock.calls[0][1].correlationId).toBe(
    publishActions.mock.calls[1][1].correlationId,
  );
  await expect(
    api.bulkExecuteActions({ ...input, operationId: undefined }),
  ).rejects.toThrow(/operation/i);
});
