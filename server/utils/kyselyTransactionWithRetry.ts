import { type IsolationLevel, type Kysely, type Transaction } from 'kysely';

import { safeGet } from './misc.js';

function isSerializationFailure(error: unknown): boolean {
  return safeGet(error, ['code']) === '40001';
}

type TransactionWithRetryOptions = {
  isolationLevel?: IsolationLevel;
  /** Disable replay when the callback performs an external mutation. */
  retrySerializationFailures?: boolean;
};

/**
 * Wraps `kysely.transaction().execute(callback)` and retries (up to 3
 * attempts) on Postgres serialization failures (SQLSTATE `40001`). Other
 * errors propagate. Options can set `isolationLevel` or disable serialization
 * retries when a callback performs external mutations that cannot be rolled back.
 *
 * Callbacks must be retry-safe: on a 40001 the whole callback is re-run,
 * including any non-database side effects (HTTP calls, queue publishes, etc.)
 * — make them idempotent or defer them until after commit. Serialization
 * failures can also surface at commit, so this applies even to DB-only bodies.
 *
 * Enforced over raw `kysely.transaction()` by `no-restricted-syntax`.
 */
export function makeKyselyTransactionWithRetry<T>(kysely: Kysely<T>) {
  async function transactionWithRetry<R>(
    callback: (trx: Transaction<T>) => Promise<R>,
  ): Promise<R>;
  async function transactionWithRetry<R>(
    options: TransactionWithRetryOptions,
    callback: (trx: Transaction<T>) => Promise<R>,
  ): Promise<R>;
  async function transactionWithRetry<R>(
    optionsOrCallback:
      | TransactionWithRetryOptions
      | ((trx: Transaction<T>) => Promise<R>),
    maybeCallback?: (trx: Transaction<T>) => Promise<R>,
  ): Promise<R> {
    const [options, callback] =
      typeof optionsOrCallback === 'function'
        ? [{}, optionsOrCallback]
        : [optionsOrCallback, maybeCallback!];

    let remainingTries = options.retrySerializationFailures === false ? 1 : 3;
    let lastError: unknown;
    while (remainingTries > 0) {
      remainingTries -= 1;
      try {
        const builder = kysely.transaction();
        const configured =
          options.isolationLevel == null
            ? builder
            : builder.setIsolationLevel(options.isolationLevel);
        return await configured.execute(callback);
      } catch (e: unknown) {
        if (!isSerializationFailure(e)) {
          throw e;
        }
        lastError = e;
      }
    }

    throw lastError;
  }

  return transactionWithRetry;
}

export type KyselyTransactionWithRetry<T> = ReturnType<
  typeof makeKyselyTransactionWithRetry<T>
>;
