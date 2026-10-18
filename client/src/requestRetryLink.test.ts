import {
  ApolloLink,
  execute,
  Observable,
  type FetchResult,
} from '@apollo/client';
import { vi } from 'vitest';

import { GQLBulkActionExecutionDocument } from './graphql/generated';
import { requestRetryLink } from './requestRetryLink';

afterEach(() => vi.useRealTimers());
test.each([true, false])(
  'transport retries respect room first-attempt certainty: room=%s',
  async (roomOperationAttempt) => {
    vi.useFakeTimers();
    const transport = vi.fn(
      () =>
        new Observable<FetchResult>((observer) =>
          observer.error(new Error('Response lost')),
        ),
    );
    const failed = vi.fn();
    execute(ApolloLink.from([requestRetryLink(), new ApolloLink(transport)]), {
      query: GQLBulkActionExecutionDocument,
      context: { roomOperationAttempt },
    }).subscribe({ error: failed });
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledTimes(roomOperationAttempt ? 1 : 3);
    expect(failed).toHaveBeenCalledTimes(1);
  },
);
