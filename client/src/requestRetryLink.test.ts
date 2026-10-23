import {
  ApolloLink,
  execute,
  Observable,
  type FetchResult,
} from '@apollo/client';
import { vi } from 'vitest';

import {
  GQLBulkActionExecutionDocument,
  GQLRoomScopeStaffDocument,
} from './graphql/generated';
import { requestRetryLink } from './requestRetryLink';

afterEach(() => vi.useRealTimers());
test.each([
  {
    document: GQLRoomScopeStaffDocument,
    roomOperationAttempt: false,
    attempts: 3,
  },
  {
    document: GQLRoomScopeStaffDocument,
    roomOperationAttempt: true,
    attempts: 1,
  },
  {
    document: GQLBulkActionExecutionDocument,
    roomOperationAttempt: false,
    attempts: 1,
  },
  {
    document: GQLBulkActionExecutionDocument,
    roomOperationAttempt: true,
    attempts: 1,
  },
])(
  'lost responses preserve operation safety: $attempts attempt(s), room=$roomOperationAttempt',
  async ({ document, roomOperationAttempt, attempts }) => {
    vi.useFakeTimers();
    const transport = vi.fn(
      () =>
        new Observable<FetchResult>((observer) =>
          observer.error(new Error('Response lost')),
        ),
    );
    const failed = vi.fn();
    execute(ApolloLink.from([requestRetryLink(), new ApolloLink(transport)]), {
      query: document,
      context: { roomOperationAttempt },
    }).subscribe({ error: failed });
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(attempts);
    expect(failed).toHaveBeenCalledTimes(1);
  },
);
