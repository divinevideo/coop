import { ApolloError } from '@apollo/client';

export function queueDeletionError(error: unknown): string {
  if (
    error instanceof ApolloError &&
    error.graphQLErrors.some(
      (entry) =>
        entry.extensions?.pointer ===
        '/manual-review-queues/recorded-room-history',
    )
  ) {
    return 'This queue has recorded room history. The queue and its jobs cannot be deleted without an explicit teardown plan. Contact your administrator.';
  }
  return 'Could not delete the queue or its jobs. Please try again or contact your administrator.';
}
