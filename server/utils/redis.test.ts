import { once } from 'node:events';
import net from 'node:net';

import IORedis from 'ioredis';

import { reconnectOnReadonly } from './redis.js';

/**
 * Minimal RESP server standing in for a Redis primary that was demoted to a
 * replica: on the first connection every SET is rejected with READONLY; on any
 * later connection (the "new primary") SET succeeds. Every other command gets
 * +OK.
 */
async function startDemotedPrimary() {
  let connections = 0;
  const server = net.createServer((socket) => {
    const connection = ++connections;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) {
          break;
        }
        buffer = buffer.slice(parsed.length);
        const name = parsed.args[0]?.toUpperCase();
        socket.write(
          name === 'SET' && connection === 1
            ? "-READONLY You can't write against a read only replica.\r\n"
            : '+OK\r\n',
        );
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as net.AddressInfo).port,
    connectionCount: () => connections,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// Parses one RESP array of bulk strings from the start of `input`, or returns
// undefined when the command has not fully arrived yet.
function parseCommand(input: string) {
  let pos = 0;
  const readLine = () => {
    const end = input.indexOf('\r\n', pos);
    if (end === -1) {
      return undefined;
    }
    const line = input.slice(pos, end);
    pos = end + 2;
    return line;
  };
  const header = readLine();
  if (header === undefined) {
    return undefined;
  }
  const readBulkString = () => {
    const lengthLine = readLine();
    if (lengthLine === undefined) {
      return undefined;
    }
    const length = Number(lengthLine.slice(1));
    if (input.length < pos + length + 2) {
      return undefined;
    }
    const value = input.slice(pos, pos + length);
    pos += length + 2;
    return value;
  };
  // Once a read comes up short the command is incomplete, and the result is
  // discarded below, so later reads past that point don't matter.
  const args = Array.from({ length: Number(header.slice(1)) }, readBulkString);
  if (args.some((arg) => arg === undefined)) {
    return undefined;
  }
  return { args, length: pos };
}

describe('reconnectOnReadonly', () => {
  test('reconnects and resends on READONLY', () => {
    expect(
      reconnectOnReadonly(
        new Error("READONLY You can't write against a read only replica."),
      ),
    ).toBe(2);
  });

  test('leaves other errors alone', () => {
    expect(reconnectOnReadonly(new Error('ERR unknown command'))).toBe(false);
    expect(
      reconnectOnReadonly(new Error('WRONGTYPE Operation against a key')),
    ).toBe(false);
  });

  test('a write rejected with READONLY succeeds after reconnecting', async () => {
    const server = await startDemotedPrimary();
    const client = new IORedis.default({
      host: '127.0.0.1',
      port: server.port,
      maxRetriesPerRequest: null,
      reconnectOnError: reconnectOnReadonly,
      enableReadyCheck: false,
      disableClientInfo: true,
      retryStrategy: () => 10,
    });
    try {
      await expect(client.set('key', 'value')).resolves.toBe('OK');
      expect(server.connectionCount()).toBe(2);
    } finally {
      client.disconnect();
      await server.close();
    }
  });
});
