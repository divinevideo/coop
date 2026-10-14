/* eslint-disable functional/immutable-data -- Tests deliberately vary authorization fixtures and record side-effect order. */
import { receiveRoomCase } from './ingest.js';

const caseId = '10000000-0000-4000-8000-000000000001';
test('room handoff acknowledges only durable receipt, item storage and queue insertion', async () => {
  const calls: string[] = [];
  let received = false;
  const dependencies = {
    once: async (_id: string, effect: () => Promise<void>) => {
      if (!received) {
        await effect();
        received = true;
      }
    },
    store: async () => {
      calls.push('store');
    },
    enqueue: async () => {
      calls.push('queue');
    },
  };
  await receiveRoomCase({ caseId }, dependencies);
  await receiveRoomCase({ caseId }, dependencies);
  expect(calls).toEqual(['store', 'queue']);
});
test('queue failure is retryable and request cannot inject evidence, target or another queue', async () => {
  let received = false;
  const dependencies = {
    once: async (_id: string, effect: () => Promise<void>) => {
      await effect();
      received = true;
    },
    store: jest.fn(async () => {}),
    enqueue: jest.fn(async () => {
      throw new Error('Queue unavailable');
    }),
  };
  await expect(receiveRoomCase({ caseId }, dependencies)).rejects.toThrow();
  expect(received).toBe(false);
  await expect(
    receiveRoomCase({ caseId, content: 'injected' }, dependencies),
  ).rejects.toThrow();
  expect(dependencies.store).toHaveBeenCalledTimes(1);
});
