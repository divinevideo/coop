import { roomDecisionQueueFixture } from '../../../test/roomDecisionQueueFixture.js';
import { roomDecisionSettings } from '../../../test/roomDecisionSettings.js';
import {
  getPermissionsForRole,
  UserRole,
} from '../../userManagementService/index.js';
import JobDecisioning from './JobDecisioning.js';

const primary = {
  type: 'CUSTOM_ACTION',
  actions: [{ id: 'room-action' }],
  policies: [],
};
const related = {
  actionIds: ['room-action'],
  itemIds: ['case'],
  itemTypeId: 'room-type',
  policyIds: [],
};
test.each([
  [
    [{ ...primary, actions: [{ id: 'room-action' }, { id: 'room-action' }] }],
    [],
  ],
  [[primary, primary], []],
  [[], [{ ...related, actionIds: ['room-action', 'room-action'] }]],
  [[], [{ ...related, itemIds: ['case', 'case'] }]],
  [[primary], [related]],
  [[], [related, related]],
])(
  'duplicate room targets are refused before immutable recording or delivery: %#',
  async (decisionComponents, relatedActions) => {
    const job = {
      id: 'synthetic:10000000-0000-4000-8000-000000000004',
      orgId: 'synthetic',
      payload: {
        kind: 'DEFAULT',
        item: {
          itemId: 'case',
          itemTypeIdentifier: { id: 'room-type' },
          data: {},
        },
      },
    };
    const record = jest.fn(async () => {});
    const pg = { insertInto: () => ({ values: () => ({ execute: record }) }) };
    const queue = {
      getJobs: async () => [job],
      removeJob: jest.fn(async () => {}),
    };
    const publish = jest.fn(async () => {});
    const service = new JobDecisioning(
      roomDecisionQueueFixture(queue, pg as never) as never,
      pg as never,
      Object.assign(
        async () => [{ id: 'room-action', name: 'concord_remove_message' }],
        { close: async () => {} },
      ) as never,
      publish,
      {
        getItemType: async () => ({
          id: 'room-type',
          schema: [],
          schemaFieldRoles: {},
        }),
      } as never,
      { addSpan: jest.fn() } as never,
      roomDecisionSettings() as never,
      async (id, orgId) => ({
        id,
        orgId,
        role: UserRole.ADMIN,
        approvedByAdmin: true,
        rejectedByAdmin: false,
        getPermissions: () => getPermissionsForRole(UserRole.ADMIN),
      }),
    );
    await expect(
      service.submitDecision({
        orgId: 'synthetic',
        queueId: 'queue',
        jobId: job.id,
        lockToken: 'staff',
        reviewerId: 'staff',
        reviewerEmail: 'staff@example.invalid',
        decisionReason: 'Synthetic duplicate target test',
        decisionComponents,
        relatedActions,
      } as never),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: 'Submit each room action/item target only once',
      }),
    });
    expect(record).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(queue.removeJob).not.toHaveBeenCalled();
  },
);
