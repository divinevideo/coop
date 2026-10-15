/* eslint-disable functional/immutable-data -- Tests vary actor authority and capture side effects. */
import { UserRole } from '../../../models/types/permissioning.js';
import JobDecisioning from './JobDecisioning.js';

test.each([
  'primary_ban',
  'related_ban',
  'guild_scope',
  'malformed_scope',
  'related_guild_scope',
  'related_malformed_scope',
])(
  'room authorization and scope are checked before recording intent: %s',
  async (kind) => {
    const job = {
      id: 'synthetic:10000000-0000-4000-8000-000000000006',
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
    const queue = {
      getJobs: async () => [job],
      removeJob: jest.fn(async () => {}),
    };
    const publish = jest.fn(async () => {});
    const actor = {
      id: 'staff',
      orgId: 'synthetic',
      approvedByAdmin: true,
      rejectedByAdmin: false,
      role:
        kind === 'guild_scope' || kind === 'related_guild_scope'
          ? UserRole.MODERATOR_MANAGER
          : kind === 'malformed_scope' || kind === 'related_malformed_scope'
            ? UserRole.ADMIN
            : UserRole.MODERATOR,
    };
    const service = new JobDecisioning(
      queue as never,
      { insertInto: () => ({ values: () => ({ execute: record }) }) } as never,
      Object.assign(async () => [{ id: 'ban', name: 'concord_ban_member' }], {
        close: async () => {},
      }) as never,
      publish,
      { getItemType: async () => undefined } as never,
      { addSpan: jest.fn() } as never,
      async () => actor,
    );
    const input: any = {
      orgId: 'synthetic',
      queueId: 'queue',
      jobId: job.id,
      lockToken: 'lock',
      reviewerId: 'staff',
      reviewerEmail: 'synthetic@example.invalid',
      decisionReason: 'Synthetic reason',
      decisionComponents: kind.startsWith('related_')
        ? [{ type: 'IGNORE' }]
        : [
            {
              type: 'CUSTOM_ACTION',
              actions: [{ id: 'ban' }],
              policies: [],
              actionIdsToMrtApiParamDecisionPayload: {
                ban:
                  kind === 'guild_scope'
                    ? { discordGuildConfirmed: true }
                    : kind === 'malformed_scope'
                      ? { discordGuildConfirmed: 'true' }
                      : {},
              },
            },
          ],
      relatedActions: kind.startsWith('related_')
        ? [
            {
              actionIds: ['ban'],
              itemIds: ['case'],
              itemTypeId: 'member-type',
              policyIds: [],
              actionIdsToMrtApiParamDecisionPayload: {
                ban: {
                  discordGuildConfirmed:
                    kind === 'related_malformed_scope'
                      ? 'true'
                      : kind === 'related_guild_scope',
                },
              },
            },
          ]
        : [],
    };
    await expect(service.submitDecision(input)).rejects.toThrow(
      'permission or scope',
    );
    expect(record).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(queue.removeJob).not.toHaveBeenCalled();
    actor.role = UserRole.ADMIN;
    if (kind === 'malformed_scope')
      input.decisionComponents[0].actionIdsToMrtApiParamDecisionPayload.ban.discordGuildConfirmed = false;
    if (kind === 'related_malformed_scope')
      input.relatedActions[0].actionIdsToMrtApiParamDecisionPayload.ban.discordGuildConfirmed = false;
    await service.submitDecision(input);
    expect(record).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(queue.removeJob).toHaveBeenCalledTimes(1);
  },
);
