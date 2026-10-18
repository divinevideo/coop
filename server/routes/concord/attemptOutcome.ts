import { GraphQLError } from 'graphql';

import { sanitizeError } from '../../utils/errors.js';

/** Describes this attempt only. A previous request may already have recorded intent. */
export function roomAttemptNotRecorded(error: unknown): GraphQLError {
  return new GraphQLError(
    error instanceof Error
      ? sanitizeError(error).title
      : 'Room submission rejected',
    { extensions: { roomAttemptOutcome: 'NOT_RECORDED' } },
  );
}
