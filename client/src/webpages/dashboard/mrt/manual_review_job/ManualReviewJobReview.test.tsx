import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import '@testing-library/jest-dom/extend-expect';

import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

import ManualReviewJobReview from './ManualReviewJobReview';

const hooks = vi.hoisted(() => ({
  query: vi.fn(),
  submit: vi.fn(async () => ({})),
  next: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('../../../../graphql/generated', async (original) => ({
  ...(await original<typeof import('../../../../graphql/generated')>()),
  useGQLManualReviewJobInfoQuery: hooks.query,
  useGQLSubmitManualReviewDecisionMutation: () => [
    hooks.submit,
    { loading: false },
  ],
  useGQLDequeueManualReviewJobMutation: () => [hooks.next, { loading: false }],
  useGQLLogSkipMutation: () => [hooks.mutate],
  useGQLReleaseJobLockMutation: () => [hooks.mutate],
}));
vi.mock('./jobFragment', async () => {
  const { GQLJobFieldsFragmentDoc } =
    await import('../../../../graphql/generated');
  return { JOB_FRAGMENT: GQLJobFieldsFragmentDoc };
});
vi.mock('../../rules/rule_form/RuleForm', async () => {
  const { GQLItemTypeFragmentFragmentDoc } =
    await import('../../../../graphql/generated');
  return { ITEM_TYPE_FRAGMENT: GQLItemTypeFragmentFragmentDoc };
});
vi.mock('./ReportInfoComponent', () => ({ default: () => null }));
vi.mock('./MergedReportsComponent', () => ({ default: () => null }));
vi.mock('../../components/PolicyDropdown', () => ({ default: () => null }));
vi.mock('./v2/user/ManualReviewJobPrimaryUserComponent', () => ({
  default: () => null,
}));
vi.mock('./v2/ncmec/NCMECReviewUser', () => ({ default: () => null }));
vi.mock('./v2/threads/ManualReviewJobListOfThreadsComponent', () => ({
  default: () => null,
}));
vi.mock('./v2/ManualReviewJobOtherItemsComponent', () => ({
  ManualReviewJobOtherItemsComponent: () => null,
}));
vi.mock('./v2/related_actions/ManualReviewJobEnqueuedRelatedActions', () => ({
  default: () => null,
}));
vi.mock('./v2/ManualReviewJobContentView', () => ({
  default: ({
    onEnqueueActions,
  }: {
    onEnqueueActions: (actions: unknown[]) => void;
  }) => (
    <button
      onClick={() =>
        onEnqueueActions([
          {
            action: {
              id: 'room-related',
              name: 'concord_ban_member',
              penalty: 'NONE',
            },
            target: {
              identifier: {
                itemId: 'synthetic-member',
                itemTypeId: 'member-type',
              },
              displayName: 'Synthetic member',
            },
            policies: [],
            customMrtApiParamDecisionPayload: { discordGuildConfirmed: true },
          },
        ])
      }
    >
      Select related room action
    </button>
  ),
}));

function review(requiresDecisionReasonInMrt = false) {
  const type = {
    id: 'message-type',
    name: 'concord_message',
    baseFields: [],
    schemaFieldRoles: {},
  };
  const job = {
    id: 'synthetic-job',
    createdAt: '2026-10-01T00:00:00Z',
    policyIds: [],
    payload: {
      __typename: 'ContentManualReviewJobPayload',
      item: { id: 'synthetic-message', type, data: {} },
    },
  };
  hooks.query.mockReturnValue({
    loading: false,
    data: {
      myOrg: {
        id: 'synthetic-org',
        policies: [],
        itemTypes: [type],
        mrtQueues: [],
        requiresDecisionReasonInMrt,
        requiresPolicyForDecisionsInMrt: false,
        allowMultiplePoliciesPerAction: false,
        hasNCMECReportingEnabled: false,
        actions: ['concord_remove_message', 'ordinary_action'].map((name) => ({
          __typename: 'CustomAction',
          id: name,
          name,
          penalty: 'NONE',
          itemTypes: [type],
          parameters: [],
        })),
      },
      me: {
        id: 'synthetic-reviewer',
        role: 'ADMIN',
        reviewableQueues: [
          {
            id: 'synthetic-queue',
            name: 'Room Review',
            hiddenActionIds: [],
            jobs: [job],
          },
        ],
      },
    },
  });
  return render(
    <HelmetProvider>
      <MemoryRouter
        initialEntries={['/synthetic-queue/synthetic-job/synthetic-lock']}
      >
        <Routes>
          <Route
            path="/:queueId/:jobId/:lockToken"
            element={<ManualReviewJobReview />}
          />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('room selection exposes a required reason and caps its length with the org setting disabled', () => {
  review();
  expect(
    screen.queryByPlaceholderText('Reason for decision'),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('concord_remove_message'));
  const reason = screen.getByPlaceholderText('Reason for decision');
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).not.toHaveBeenCalled();
  for (const invalid of ['   ', '']) {
    fireEvent.change(reason, { target: { value: invalid } });
    fireEvent.click(screen.getByText('Submit'));
    expect(hooks.submit).not.toHaveBeenCalled();
  }
  fireEvent.change(reason, { target: { value: 'x'.repeat(2049) } });
  expect(reason).toHaveValue('x'.repeat(2048));
  fireEvent.change(reason, {
    target: { value: 'Synthetic moderation reason' },
  });
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      variables: {
        input: expect.objectContaining({
          decisionReason: 'Synthetic moderation reason',
        }),
      },
    }),
  );
});

test('a related room action also requires a reason when the primary action is Ignore', () => {
  review();
  fireEvent.click(screen.getByText('Ignore'));
  fireEvent.click(screen.getByText('Select related room action'));
  expect(
    screen.getByPlaceholderText('Reason for decision'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).not.toHaveBeenCalled();
});

test('related room action preserves explicit server scope in the submitted intent', () => {
  review();
  fireEvent.click(screen.getByText('Ignore'));
  fireEvent.click(screen.getByText('Select related room action'));
  fireEvent.change(screen.getByPlaceholderText('Reason for decision'), {
    target: { value: 'Synthetic scope reason' },
  });
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      variables: {
        input: expect.objectContaining({
          relatedItemActions: [
            expect.objectContaining({
              actionIdsToMrtApiParamDecisionPayload: {
                'room-related': { discordGuildConfirmed: true },
              },
            }),
          ],
        }),
      },
    }),
  );
});

test('ordinary actions keep the optional reason behavior when the org setting is disabled', () => {
  review();
  fireEvent.click(screen.getByText('ordinary_action'));
  expect(
    screen.queryByPlaceholderText('Reason for decision'),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).toHaveBeenCalledOnce();
});

test('the global org setting still requires a reason for ordinary actions', () => {
  review(true);
  fireEvent.click(screen.getByText('ordinary_action'));
  const reason = screen.getByPlaceholderText('Reason for decision');
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).not.toHaveBeenCalled();
  fireEvent.change(reason, { target: { value: 'Synthetic ordinary reason' } });
  fireEvent.click(screen.getByText('Submit'));
  expect(hooks.submit).toHaveBeenCalledOnce();
});
