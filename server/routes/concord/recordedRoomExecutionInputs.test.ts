import { spawnSync } from 'node:child_process';

import { jsonStringify, tryJsonParse } from '../../utils/encoding.js';
import { recordedRoomStopInputs } from './recordedRoomExecutionInputs.js';
import { roomExecutionId } from './service.js';

const id = '10000000-0000-4000-8000-000000000001';
const jobId = `item:${Buffer.from(id).toString('base64url')}`;
const decision = {
  id,
  jobId,
  itemId: 'primary',
  itemTypeId: 'room-type',
  decisions: [
    {
      type: 'CUSTOM_ACTION',
      actionIds: ['remove'],
      itemIds: ['not-primary'],
      itemTypeId: 'not-primary-type',
    },
  ],
  relatedActions: [
    {
      type: 'RELATED_ACTION',
      actionIds: ['related-remove'],
      itemIds: ['related'],
      itemTypeId: 'related-type',
    },
  ],
};
const response = {
  data: { myOrg: { id: 'org' }, getDecidedJobFromJobId: { decision } },
};

test('offline stop inputs reproduce primary and related recorded execution identities', () => {
  const result = recordedRoomStopInputs(response);
  expect(result).toEqual([
    expect.objectContaining({
      manualReviewDecisionId: id,
      actionId: 'remove',
      itemId: 'primary',
      itemTypeId: 'room-type',
    }),
    expect.objectContaining({
      manualReviewDecisionId: id,
      actionId: 'related-remove',
      itemId: 'related',
      itemTypeId: 'related-type',
    }),
  ]);
  for (const target of result)
    expect(target.executionId).toBe(
      roomExecutionId({
        orgId: 'org',
        correlationId: `mrt-decision:${jobId}`,
        ...target,
        actionName: 'concord_remove_message',
        itemTypeName: 'concord_message',
      }),
    );
});

test('partial, missing or mismatched read responses cannot supply stop inputs', () => {
  expect(() =>
    recordedRoomStopInputs({
      ...response,
      errors: [{ message: 'unavailable' }],
    }),
  ).toThrow('partial');
  expect(() => recordedRoomStopInputs({ data: { myOrg: null } })).toThrow();
  expect(() =>
    recordedRoomStopInputs({
      data: {
        ...response.data,
        getDecidedJobFromJobId: { decision: { ...decision, id: 'different' } },
      },
    }),
  ).toThrow('do not match');
});

test('operator CLI prints only derived identifiers and does not echo malformed input', () => {
  const result = spawnSync(process.execPath, ['bin/room-mrt-stop-inputs.ts'], {
    input: jsonStringify(response),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(tryJsonParse(result.stdout)).toEqual(recordedRoomStopInputs(response));
  const malformed = spawnSync(
    process.execPath,
    ['bin/room-mrt-stop-inputs.ts'],
    { input: 'invalid-json synthetic-private-input', encoding: 'utf8' },
  );
  expect(malformed.status).toBe(1);
  expect(malformed.stdout).toBe('');
  expect(malformed.stderr).not.toContain('synthetic-private-input');
});
