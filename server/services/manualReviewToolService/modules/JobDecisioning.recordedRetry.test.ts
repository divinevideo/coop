import { UserRole } from '../../../services/userManagementService/index.js';
import { roomDecisionQueueFixture } from '../../../test/roomDecisionQueueFixture.js';
import { roomDecisionSettings } from '../../../test/roomDecisionSettings.js';
import { getPermissionsForRole } from '../../userManagementService/index.js';
import JobDecisioning from './JobDecisioning.js';

test.each(['authorized', 'unauthorized', 'ordinary'])(
  'recorded retry uses stored intent and checks its new trigger: %s',
  async (kind) => {
    const job = {
      id: 'synthetic:10000000-0000-4000-8000-000000000009',
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
    const original = {
      queue_id: 'queue',
      reviewer_id: 'original-reviewer',
      decision_reason: 'Exact original reason including whitespace ',
      job_payload: { ...job, roomDeliveryRequired: kind !== 'ordinary' },
      decision_components: [
        {
          type: 'CUSTOM_ACTION',
          actions: [{ id: 'remove' }],
          policies: [],
          itemIds: ['case'],
          itemTypeId: 'room-type',
        },
      ],
      related_actions: [],
    };
    const query = {
      where: () => query,
      selectAll: () => query,
      executeTakeFirst: async () => original,
    };
    const queue = {
      getJobs: async () => [job],
      removeJob: jest.fn(async () => {}),
    };
    const publish = jest.fn(async () => {});
    const actor = jest.fn(async (id: string, orgId: string) => ({
      id,
      orgId,
      getPermissions: () =>
        getPermissionsForRole(
          kind === 'unauthorized'
            ? UserRole.EXTERNAL_MODERATOR
            : UserRole.ADMIN,
        ),
      role:
        kind === 'unauthorized' ? UserRole.EXTERNAL_MODERATOR : UserRole.ADMIN,
      approvedByAdmin: true,
      rejectedByAdmin: false,
    }));
    const pg = {
      selectFrom: () => query,
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            throw new Error(
              'duplicate key value violates unique constraint "manual_review_decisions_pkey"',
            );
          },
        }),
      }),
    };
    const service = new JobDecisioning(
      roomDecisionQueueFixture(queue, pg as never) as never,
      pg as never,
      Object.assign(
        async () => [{ id: 'remove', name: 'concord_remove_message' }],
        { close: async () => {} },
      ) as never,
      publish,
      { getItemType: async () => undefined } as never,
      { addSpan: jest.fn() } as never,
      roomDecisionSettings() as never,
      actor,
    );
    const retry = service.retryRecordedRoomDecision({
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: job.id as never,
      lockToken: 'new-lock',
      reviewerId: 'new-reviewer',
    });
    if (kind === 'unauthorized') {
      await expect(retry).rejects.toThrow('permission or scope');
      expect(publish).not.toHaveBeenCalled();
      expect(queue.removeJob).not.toHaveBeenCalled();
    } else if (kind === 'ordinary') {
      await expect(retry).resolves.toBe(false);
      expect(actor).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } else {
      await expect(retry).resolves.toBe(true);
      expect(actor).toHaveBeenCalledWith('new-reviewer', 'synthetic');
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewerId: 'original-reviewer',
          reviewerEmail: '',
          decisionReason: original.decision_reason,
          decisionComponents: original.decision_components,
          relatedActions: original.related_actions,
          roomDeliveryRequired: true,
        }),
      );
      expect(queue.removeJob).toHaveBeenCalledTimes(1);
    }
  },
);
