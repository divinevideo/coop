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
  loading: vi.fn(() => false),
}));
vi.mock('@/graphql/generated', function () {
  return {
    namedOperations: { Query: {} },
    useGQLBulkActionExecutionMutation: (defaults: Record<string, unknown>) => [
      (options: Record<string, unknown>) =>
        hooks.submit({ ...defaults, ...options }),
      { loading: hooks.loading() },
    ],
    useGQLBulkActionsFormDataQuery: () => ({
      data: {
        myOrg: {
          policies: [],
          actions: ['concord_ban_member', 'concord_remove_message'].map(
            (name) => ({
              id: name,
              name,
              itemTypes: [{ id: 'room' }],
              parameters: [],
            }),
          ),
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
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  hooks.submit.mockReset();
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
      definitive ? /This attempt was not recorded/ : /Acceptance is unknown/,
    );
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'concord_remove_message' },
    });
    fireEvent.click(screen.getByText('Submit Actions'));
    await waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(2));
    expect(hooks.submit.mock.calls[0][0].context).toEqual({
      roomOperationAttempt: true,
    });
    const first = hooks.submit.mock.calls[0][0].variables.input.operationId;
    const second = hooks.submit.mock.calls[1][0].variables.input.operationId;
    if (definitive) expect(second).toMatch(/^source-order-v1_remove_message_/);
    else expect(second).toBe(first);
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
  fireEvent.click(screen.getByText('Submit Actions'));
  expect(hooks.submit).toHaveBeenCalledTimes(2);
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
  const replacement = hooks.submit.mock.calls[2][0].variables.input.operationId;
  await act(async () => {
    replies[0].resolve(accepted);
    await replies[0].promise;
  });
  expect(roomOperation(item, 'concord_remove_message')).toBe(replacement);
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
