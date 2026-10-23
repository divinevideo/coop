/**
 * `reconnectOnError` handler for ioredis. After a Redis primary change, the
 * old primary becomes a replica and rejects writes with `READONLY`, but
 * ioredis keeps the socket open, so every later write fails too. Returning 2
 * makes ioredis reconnect (resolving the host again, which now points at the
 * new primary) and resend the failed command.
 */
export function reconnectOnReadonly(err: Error): 2 | false {
  return err.message.startsWith('READONLY') ? 2 : false;
}
