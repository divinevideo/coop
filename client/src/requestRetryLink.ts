import { RetryLink } from '@apollo/client/link/retry';
import { getOperationAST } from 'graphql';

export function requestRetryLink() {
  return new RetryLink({
    delay: { initial: 300, max: 5000, jitter: true },
    attempts: {
      max: 3,
      // Lost responses cannot prove that a mutation did not take effect.
      // The form must also observe every room attempt before releasing its identity.
      retryIf: (error, operation) =>
        Boolean(error) &&
        getOperationAST(operation.query, operation.operationName)?.operation ===
          'query' &&
        !operation.getContext().roomOperationAttempt,
    },
  });
}
