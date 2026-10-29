import { type Kysely, type Transaction } from 'kysely';

import { type ManualReviewToolServicePg } from '../services/manualReviewToolService/index.js';
import { makeKyselyTransactionWithRetry } from '../utils/kyselyTransactionWithRetry.js';

/** Fake queues retain their isolated PG harness; real exclusion is tested with PG/Redis. */
export function roomDecisionQueueFixture(
  queue: object,
  pg: Kysely<ManualReviewToolServicePg>,
) {
  return {
    ...queue,
    withRoomDecisionRegistration: async <T>(
      _opts: unknown,
      register: (tx: Transaction<ManualReviewToolServicePg>) => Promise<T>,
    ) =>
      'transaction' in pg
        ? makeKyselyTransactionWithRetry(pg)(register)
        : register(pg as Transaction<ManualReviewToolServicePg>),
  };
}
