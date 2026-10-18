import { RetryLink } from '@apollo/client/link/retry';

export function requestRetryLink() {
  return new RetryLink({
    delay: { initial: 300, max: 5000, jitter: true },
    attempts: {
      max: 3,
      // The form must observe every room attempt before it can release an identity.
      retryIf: (error, operation) =>
        Boolean(error) && !operation.getContext().roomOperationAttempt,
    },
  });
}
