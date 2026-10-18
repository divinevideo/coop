import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { vi } from 'vitest';

import ItemAction from './ItemAction';

const hooks = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('@/graphql/generated', function () {
  return {
    namedOperations: { Query: {} },
    useGQLBulkActionExecutionMutation: (defaults: Record<string, unknown>) => [
      (options: Record<string, unknown>) =>
        hooks.submit({ ...defaults, ...options }),
      { loading: false },
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
