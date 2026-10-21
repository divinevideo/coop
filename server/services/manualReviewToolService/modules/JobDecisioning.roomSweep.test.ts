import { roomDecisionSettings } from '../../../test/roomDecisionSettings.js';
import JobDecisioning from './JobDecisioning.js';

test.each(['concord_message', 'concord_member', 'recorded'])(
  'ordinary user-report sweep leaves %s room work for fenced completion',
  async (kind) => {
    const write = jest.fn(() => ({
      values: () => ({ execute: async () => {} }),
    }));
    const query = {
      where: () => query,
      select: () => query,
      executeTakeFirst: async () =>
        kind === 'recorded'
          ? { job_payload: { roomDeliveryRequired: true } }
          : undefined,
    };
    const service = new JobDecisioning(
      {} as never,
      { selectFrom: () => query, insertInto: write } as never,
      Object.assign(async () => [], { close: async () => {} }),
      jest.fn(),
      {
        getItemType: async () => ({
          name: kind,
          schema: [],
          schemaFieldRoles: {},
        }),
      } as never,
      {} as never,
      roomDecisionSettings() as never,
    );
    const job = {
      id: 'synthetic:10000000-0000-4000-8000-000000000001',
      orgId: 'synthetic',
      payload: {
        kind: 'DEFAULT',
        item: {
          itemId: 'case',
          itemTypeIdentifier: { id: 'type' },
          data: {},
        },
      },
    };
    const result = await service.recordSweptJobDisposition({
      orgId: 'synthetic',
      queueId: 'queue',
      job: job as never,
      disposition: 'AUTOMATIC_CLOSE',
      triggerCustomActions: [],
      reviewerId: 'staff',
      reviewerEmail: 'synthetic@example.invalid',
    });
    expect(result).toBe('skipped');
    expect(write).not.toHaveBeenCalled();
  },
);
