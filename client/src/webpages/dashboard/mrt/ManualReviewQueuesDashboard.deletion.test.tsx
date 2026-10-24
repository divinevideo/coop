import { ApolloError } from '@apollo/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { type MouseEventHandler, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ManualReviewQueuesDashboard from './ManualReviewQueuesDashboard';
import { queueDeletionError } from './queueDeletionError';

const hooks = vi.hoisted(() => ({
  deleteQueue: vi.fn(),
  purge: vi.fn(),
  refetch: vi.fn(),
  data: {
    myOrg: { hasAppealsEnabled: false, previewJobsViewEnabled: false },
    me: {
      permissions: ['EDIT_MRT_QUEUES', 'MANAGE_ORG'],
      favoriteMRTQueues: [],
      reviewableQueues: [
        {
          id: 'queue',
          name: 'Room Review',
          description: '',
          pendingJobCount: 2,
          oldestJobCreatedAt: null,
          isDefaultQueue: false,
          isAppealsQueue: false,
        },
      ],
    },
  },
}));
vi.mock('@/graphql/generated', () => ({
  GQLUserPermission: {
    EditMrtQueues: 'EDIT_MRT_QUEUES',
    ManageOrg: 'MANAGE_ORG',
  },
  namedOperations: { Query: { ManualReviewQueues: 'ManualReviewQueues' } },
  useGQLManualReviewQueuesQuery: () => ({
    data: hooks.data,
    refetch: hooks.refetch,
  }),
  useGQLDeleteManualReviewQueueMutation: () => [hooks.deleteQueue],
  useGQLDeleteAllJobsFromQueueMutation: () => [hooks.purge],
  useGQLAddFavoriteMrtQueueMutation: () => [vi.fn()],
  useGQLRemoveFavoriteMrtQueueMutation: () => [vi.fn()],
  useGQLGetResolvedJobsForUserQuery: () => ({}),
  useGQLGetSkippedJobsForUserQuery: () => ({}),
  useGQLRoutingRulesQuery: () => ({}),
}));
vi.mock('react-helmet-async', () => ({ Helmet: () => null }));
vi.mock('../components/DashboardHeader', () => ({ default: () => null }));
vi.mock('../components/CoopModal', () => ({
  default: ({
    visible,
    title,
    children,
    footer,
  }: {
    visible: boolean;
    title: string;
    children: ReactNode;
    footer: { title: string; onClick: () => void; disabled?: boolean }[];
  }) =>
    visible ? (
      <div role="dialog" aria-label={title}>
        {children}
        {footer.map((button) => (
          <button
            key={button.title}
            onClick={button.onClick}
            disabled={button.disabled}
          >
            {button.title}
          </button>
        ))}
      </div>
    ) : null,
}));
vi.mock('../components/RowMutations', () => ({
  default: ({ onDelete }: { onDelete: MouseEventHandler }) => (
    <button onClick={onDelete}>Open queue deletion</button>
  ),
}));
vi.mock('../components/table/Table', () => ({
  default: ({
    data,
  }: {
    data: { mutations: ReactNode; deleteJobs: ReactNode }[];
  }) => (
    <div>
      {data.map((row, index) => (
        <div key={index}>
          {row.mutations}
          {row.deleteJobs}
        </div>
      ))}
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  hooks.refetch.mockResolvedValue({});
});
afterEach(cleanup);

const historyRefusal = () =>
  new ApolloError({
    graphQLErrors: [
      new GraphQLError('Do not display arbitrary server text', {
        extensions: { pointer: '/manual-review-queues/recorded-room-history' },
      }),
    ],
  });

function openConfirmation(operation: 'delete' | 'purge') {
  render(
    <MemoryRouter>
      <ManualReviewQueuesDashboard />
    </MemoryRouter>,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: operation === 'delete' ? 'Open queue deletion' : 'Delete All Jobs',
    }),
  );
  if (operation === 'purge') {
    fireEvent.change(
      screen.getByLabelText('Type the queue name to confirm deletion'),
      { target: { value: 'Room Review' } },
    );
  }
  return screen.getByRole('button', {
    name: operation === 'delete' ? 'Delete' : 'Confirm',
  });
}

describe.each(['delete', 'purge'] as const)(
  '%s confirmation feedback',
  (operation) => {
    const mutate = () =>
      operation === 'delete' ? hooks.deleteQueue : hooks.purge;
    const success = () =>
      operation === 'delete'
        ? { data: { deleteManualReviewQueue: true } }
        : {
            data: {
              deleteAllJobsFromQueue: {
                __typename: 'DeleteAllJobsFromQueueSuccessResponse',
                _: true,
              },
            },
          };

    it('keeps the modal open and gives fixed guidance for recorded history', async () => {
      mutate().mockRejectedValueOnce(historyRefusal());
      fireEvent.click(openConfirmation(operation));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain(
          'recorded room history',
        ),
      );
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(
        screen.queryByText('Do not display arbitrary server text'),
      ).toBeNull();
      expect(hooks.refetch).not.toHaveBeenCalled();
    });

    it('keeps unexpected failures open with generic feedback, not internal text', async () => {
      mutate().mockRejectedValueOnce(
        new ApolloError({
          graphQLErrors: [
            new GraphQLError('Sensitive internal failure', {
              extensions: { pointer: '/some-other-error' },
            }),
          ],
        }),
      );
      fireEvent.click(openConfirmation(operation));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe(
          queueDeletionError(undefined),
        ),
      );
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(screen.queryByText('Sensitive internal failure')).toBeNull();
      expect(hooks.refetch).not.toHaveBeenCalled();
    });

    it('awaits success before closing and refetching', async () => {
      let resolve!: (value: ReturnType<typeof success>) => void;
      mutate().mockReturnValueOnce(
        new Promise<ReturnType<typeof success>>((done) => {
          resolve = done;
        }),
      );
      const confirm = openConfirmation(operation);
      fireEvent.click(confirm);
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      expect(hooks.refetch).not.toHaveBeenCalled();
      await act(async () => resolve(success()));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(hooks.refetch).toHaveBeenCalledTimes(1);
    });

    it('does not treat a false or error-union response as success', async () => {
      mutate().mockResolvedValueOnce(
        operation === 'delete'
          ? { data: { deleteManualReviewQueue: false } }
          : {
              data: {
                deleteAllJobsFromQueue: {
                  __typename: 'DeleteAllJobsUnauthorizedError',
                  title: 'Internal text',
                },
              },
            },
      );
      fireEvent.click(openConfirmation(operation));
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toBe(
          queueDeletionError(undefined),
        ),
      );
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(hooks.refetch).not.toHaveBeenCalled();
    });
  },
);

it('does not expose arbitrary non-Apollo errors', () => {
  expect(queueDeletionError(new Error('Sensitive internal failure'))).toBe(
    queueDeletionError(undefined),
  );
});
