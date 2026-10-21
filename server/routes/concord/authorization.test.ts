import {
  getPermissionsForRole,
  UserPermission,
  UserRole,
} from '../../services/userManagementService/index.js';
import { actor, config } from '../../test/memberIntentFixtures.js';
import { roomActor } from './authorization.js';
import { roomPermissions } from './service.js';

test('room capabilities respect an explicitly empty current permission set even for an admin', () => {
  expect(roomPermissions({ ...actor, getPermissions: () => [] })).toEqual([]);
  expect(
    roomPermissions({
      ...actor,
      getPermissions: () => [UserPermission.VIEW_MRT],
    }),
  ).toEqual([]);
});

test('room capabilities keep the current role ceiling after admin demotion', () => {
  const demoted = {
    ...actor,
    role: UserRole.MODERATOR,
    getPermissions: () => getPermissionsForRole(UserRole.MODERATOR),
  };
  expect(roomPermissions(demoted)).toContain('remove_message');
  expect(roomPermissions(demoted)).not.toContain('ban_member');
  expect(roomPermissions(demoted)).not.toContain('manage_moderation_records');
});

test('cross-org requests fail before any staff or queue lookup', async () => {
  const lookup = jest.fn();
  await expect(
    roomActor(
      { UserAPIDataSource: { getGraphQLUserFromId: lookup } } as never,
      config,
      actor.id,
      'other-org',
    ),
  ).rejects.toThrow('organization');
  expect(lookup).not.toHaveBeenCalled();
});

test('current staff permissions are reloaded before queue authorization', async () => {
  const queues = jest.fn();
  const lookup = jest.fn(async () => ({ ...actor, getPermissions: () => [] }));
  await expect(
    roomActor(
      {
        UserAPIDataSource: { getGraphQLUserFromId: lookup },
        ManualReviewToolService: { getReviewableQueuesForUser: queues },
      } as never,
      config,
      actor.id,
      actor.orgId,
    ),
  ).rejects.toThrow('permission');
  expect(lookup).toHaveBeenCalledWith({ id: actor.id, orgId: actor.orgId });
  expect(queues).not.toHaveBeenCalled();
});
