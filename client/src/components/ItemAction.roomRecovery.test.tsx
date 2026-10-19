import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { vi } from 'vitest';

import ItemAction from './ItemAction';
import { roomOperation } from './roomOperation';

const hooks = vi.hoisted(() => ({
  submit: vi.fn(),
  begin: vi.fn(),
  loading: vi.fn(() => false),
}));
vi.mock('@/graphql/generated', function () {
  return {
    namedOperations: { Query: {} },
    useGQLBeginItemRoomOperationMutation: () => [
      hooks.begin,
      { loading: false },
    ],
    useGQLRoomOperationActorQuery: () => ({
      data: { me: { id: 'actor' }, myOrg: { id: 'org' } },
    }),
    useGQLBulkActionExecutionMutation: (defaults: Record<string, unknown>) => [
      (options: Record<string, unknown>) =>
        hooks.submit({ ...defaults, ...options }),
      { loading: hooks.loading() },
    ],
    useGQLBulkActionsFormDataQuery: () => ({
      data: {
        myOrg: {
          policies: [],
          actions: [
            'concord_ban_member',
            'concord_unban_member',
            'concord_remove_message',
          ].map((name) => ({
            id: name,
            name,
            itemTypes: [{ id: 'room' }],
            parameters: [],
          })),
        },
      },
    }),
  };
});
vi.mock('antd', function () {
  const Select = Object.assign(
    function MockSelect({
      children,
      onChange,
    }: {
      children: React.ReactNode;
      onChange: (values: string[]) => void;
    }) {
      return (
        <select
          aria-label="Action"
          onChange={(event) => onChange([event.target.value])}
        >
          {children}
        </select>
      );
    },
    {
      Option: ({
        value,
        children,
      }: {
        value: string;
        children: React.ReactNode;
      }) => <option value={value}>{children}</option>,
    },
  );
  return {
    Select,
    Input: {
      TextArea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
        <textarea {...props} />
      ),
    },
    Button: () => null,
  };
});
vi.mock('@/webpages/dashboard/components/CoopButton', function () {
  return {
    default: ({
      title,
      onClick,
      disabled,
    }: {
      title: string;
      onClick: () => void;
      disabled: boolean;
    }) => (
      <button onClick={onClick} disabled={disabled}>
        {title}
      </button>
    ),
  };
});
vi.mock('@/webpages/dashboard/components/CoopModal', function () {
  return {
    default: ({
      visible,
      children,
    }: {
      visible: boolean;
      children: React.ReactNode;
    }) => (visible ? <div>{children}</div> : null),
  };
});
vi.mock('@/webpages/dashboard/components/PolicyDropdown', () => ({
  default: () => null,
}));
vi.mock('@/components/ActionParametersModal', () => ({
  default: () => null,
  defaultValuesForParameters: () => ({}),
}));
vi.mock('./ConcordEnforcementStatus', () => ({ default: () => null }));
beforeEach(() => {
  const ids = new Map<string, string>();
  hooks.begin.mockImplementation(async ({ variables }) => {
    const input = variables.input;
    if (!ids.has(input.clientNonce))
      ids.set(
        input.clientNonce,
        `source-order-v2_${input.actionId.replace('concord_', '')}_${crypto.randomUUID()}`,
      );
    return {
      data: {
        beginRoomOperation: {
          operationId: ids.get(input.clientNonce),
          phase: 'prepared',
          disposition: 'none',
          acceptanceUnknown: false,
          recorded: false,
          allowedNextActions: ['send'],
        },
      },
    };
  });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  hooks.submit.mockReset();
  hooks.begin.mockReset();
  hooks.loading.mockReturnValue(false);
});

test.each([true, false])(
  'action switching after first attempt: definitive rejection=%s',
  async (definitive) => {
    hooks.submit.mockImplementation(async (options) => {
      options.onError({
        graphQLErrors: definitive
          ? [{ extensions: { roomAttemptOutcome: 'NOT_RECORDED' } }]
          : [],
      });
      return {};
    });
    render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'concord_ban_member' },
    });
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Reason' },
    });
    fireEvent.click(screen.getByText('Submit Actions'));
    await screen.findByText(
      definitive
        ? /This delivery attempt was not recorded/
        : /Acceptance is unknown/,
    );
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'concord_remove_message' },
    });
    fireEvent.click(screen.getByText('Submit Actions'));
    await screen.findByText(/Could not prepare this room request/);
    expect(hooks.submit).toHaveBeenCalledTimes(1);
    expect(hooks.begin).toHaveBeenCalledTimes(1);
    expect(hooks.submit.mock.calls[0][0].context).toEqual({
      roomOperationAttempt: true,
    });
    const first = hooks.submit.mock.calls[0][0].variables.input.operationId;
    expect(roomOperation({ id: 'item', typeId: 'room' })).toBe(first);
  },
);

test('overlapping old success cannot erase a replacement operation', async () => {
  const response = () => {
    let resolve!: (data: {
      bulkExecuteActions: {
        results: { success: boolean; itemId: string; actionId: string }[];
      };
    }) => void;
    const promise = new Promise<Parameters<typeof resolve>[0]>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const replies = [response(), response(), response()];
  hooks.submit.mockImplementation(async (options) => {
    const index = hooks.submit.mock.calls.length - 1;
    return replies[index].promise.then((data) => {
      options.onCompleted(data);
      return { data };
    });
  });
  const item = { id: 'item', typeId: 'room' };
  render(<ItemAction itemIdentifier={item} />);
  fireEvent.change(screen.getByLabelText('Action'), {
    target: { value: 'concord_ban_member' },
  });
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'Reason' },
  });
  fireEvent.click(screen.getByText('Submit Actions'));
  await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('Submit Actions'));
  await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(2));
  const accepted = {
    bulkExecuteActions: {
      results: [
        { success: true, itemId: 'item', actionId: 'concord_ban_member' },
      ],
    },
  };
  await act(async () => {
    replies[1].resolve(accepted);
    await replies[1].promise;
  });
  await waitFor(() => expect(sessionStorage.length).toBe(0));
  fireEvent.change(screen.getByLabelText('Action'), {
    target: { value: 'concord_remove_message' },
  });
  fireEvent.click(screen.getByText('Submit Actions'));
  await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(3));
  const replacement = hooks.submit.mock.calls[2][0].variables.input.operationId;
  await act(async () => {
    replies[0].resolve(accepted);
    await replies[0].promise;
  });
  expect(roomOperation(item)).toBe(replacement);
  await act(async () => {
    replies[2].resolve(accepted);
    await replies[2].promise;
  });
});

test('loading disables submit even when explicit input validation is satisfied', () => {
  hooks.loading.mockReturnValue(true);
  render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
  fireEvent.change(screen.getByLabelText('Action'), {
    target: { value: 'concord_ban_member' },
  });
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'Reason' },
  });
  expect(
    (screen.getByText('Submit Actions') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByText('Submit Actions'));
  expect(hooks.submit).not.toHaveBeenCalled();
});

test.each(['ban_member', 'unban_member', 'remove_message'])(
  'fresh %s obtains a server receipt before delivery',
  async (action) => {
    const operationId = `source-order-v2_${action}_10000000-0000-4000-8000-000000000001`;
    hooks.begin.mockResolvedValue({
      data: {
        beginRoomOperation: {
          operationId,
          phase: 'prepared',
          disposition: 'none',
          acceptanceUnknown: false,
          allowedNextActions: ['send'],
        },
      },
    });
    hooks.submit.mockResolvedValue({});
    render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: `concord_${action}` },
    });
    fireEvent.change(screen.getByLabelText('Note (optional)'), {
      target: { value: 'Reason' },
    });
    fireEvent.click(screen.getByText('Submit Actions'));
    await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
    expect(hooks.begin).toHaveBeenCalledTimes(1);
    expect(hooks.submit.mock.calls[0][0].variables.input.operationId).toBe(
      operationId,
    );
  },
);

function selectRoom() {
  fireEvent.change(screen.getByLabelText('Action'), {
    target: { value: 'concord_ban_member' },
  });
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'Reason' },
  });
}
test('lost begin response retains the nonce across remount and only exact claims can retry', async () => {
  hooks.begin.mockRejectedValueOnce(new Error('response lost'));
  hooks.submit.mockResolvedValue({});
  const item = { id: 'item', typeId: 'room' };
  const first = render(<ItemAction itemIdentifier={item} />);
  selectRoom();
  fireEvent.click(screen.getByText('Submit Actions'));
  await screen.findByText(/No delivery was started by this attempt/);
  expect(hooks.submit).not.toHaveBeenCalled();
  expect(screen.queryByText(/Acceptance is unknown/)).toBeNull();
  const original = hooks.begin.mock.calls[0][0].variables.input;
  first.unmount();
  render(<ItemAction itemIdentifier={item} />);
  selectRoom();
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'Changed reason' },
  });
  fireEvent.click(screen.getByText('Submit Actions'));
  await screen.findByText(/changed inputs cannot replace/);
  expect(hooks.begin).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'Reason' },
  });
  fireEvent.click(screen.getByText('Submit Actions'));
  await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
  expect(hooks.begin.mock.calls[1][0].variables.input).toEqual(original);
});
test('preparing disables submission before a server receipt is returned', async () => {
  hooks.begin.mockImplementation(async () => new Promise(() => {}));
  render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
  selectRoom();
  fireEvent.click(screen.getByText('Submit Actions'));
  await waitFor(() => expect(hooks.begin).toHaveBeenCalledTimes(1));
  expect(
    (screen.getByText('Submit Actions') as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(hooks.submit).not.toHaveBeenCalled();
});
test.each(['retired', 'refused', 'accepted'])(
  'begin returns current %s state without another delivery',
  async (phase) => {
    const operationId =
      'source-order-v2_ban_member_10000000-0000-4000-8000-000000000001';
    hooks.begin.mockResolvedValue({
      data: {
        beginRoomOperation: {
          operationId,
          phase,
          disposition: phase === 'refused' ? 'needs_attention' : 'none',
          refusalCode:
            phase === 'refused' ? 'decision_source_unavailable' : null,
          acceptedDecisionId: phase === 'accepted' ? 'decision' : null,
          acceptanceUnknown: false,
          recorded: false,
          allowedNextActions: phase === 'retired' ? ['replace'] : [],
        },
      },
    });
    render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
    selectRoom();
    fireEvent.click(screen.getByText('Submit Actions'));
    await screen.findByText(
      phase === 'accepted'
        ? /already recorded/
        : phase === 'retired'
          ? /retired without delivery/
          : /cannot be sent/,
    );
    expect(hooks.submit).not.toHaveBeenCalled();
    expect(roomOperation({ id: 'item', typeId: 'room' })).toBe(
      phase === 'refused' ? operationId : undefined,
    );
    if (phase === 'retired') {
      const oldNonce = hooks.begin.mock.calls[0][0].variables.input.clientNonce;
      hooks.begin.mockResolvedValueOnce({
        data: {
          beginRoomOperation: {
            operationId: 'replacement',
            phase: 'prepared',
            disposition: 'none',
            acceptanceUnknown: false,
          },
        },
      });
      hooks.submit.mockResolvedValue({});
      fireEvent.change(screen.getByLabelText('Action'), {
        target: { value: 'concord_remove_message' },
      });
      fireEvent.click(screen.getByText('Submit Actions'));
      await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
      expect(hooks.begin.mock.calls[1][0].variables.input.clientNonce).not.toBe(
        oldNonce,
      );
      expect(hooks.submit.mock.calls[0][0].variables.input.operationId).toBe(
        'replacement',
      );
    }
  },
);
test.each([
  { recorded: true, acceptanceUnknown: false, allowedNextActions: ['replace'] },
  { recorded: false, acceptanceUnknown: true, allowedNextActions: ['replace'] },
  { recorded: false, acceptanceUnknown: false, allowedNextActions: [] },
])(
  'retirement without a complete replacement certificate retains identity: %j',
  async (status) => {
    hooks.begin.mockResolvedValue({
      data: {
        beginRoomOperation: {
          operationId: 'retained',
          phase: 'retired',
          disposition: 'none',
          ...status,
        },
      },
    });
    render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
    selectRoom();
    fireEvent.click(screen.getByText('Submit Actions'));
    await screen.findByText(/cannot be sent/);
    expect(hooks.submit).not.toHaveBeenCalled();
    expect(roomOperation({ id: 'item', typeId: 'room' })).toBe('retained');
  },
);
test('existing legacy operation reaches lookup-only delivery without beginning a fresh receipt', async () => {
  const operationId =
    'source-order-v1_ban_member_10000000-0000-4000-8000-000000000001';
  sessionStorage.setItem(
    'concord-operation:source-order-v1:["room","item"]',
    operationId,
  );
  hooks.submit.mockResolvedValue({});
  render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
  selectRoom();
  fireEvent.click(screen.getByText('Submit Actions'));
  await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
  expect(hooks.begin).not.toHaveBeenCalled();
  expect(hooks.submit.mock.calls[0][0].variables.input.operationId).toBe(
    operationId,
  );
});
test('oversized reason is rejected before saving a nonce or beginning', async () => {
  render(<ItemAction itemIdentifier={{ id: 'item', typeId: 'room' }} />);
  selectRoom();
  fireEvent.change(screen.getByLabelText('Note (optional)'), {
    target: { value: 'x'.repeat(2049) },
  });
  fireEvent.click(screen.getByText('Submit Actions'));
  await screen.findByText(/between 1 and 2048/);
  expect(hooks.begin).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});
