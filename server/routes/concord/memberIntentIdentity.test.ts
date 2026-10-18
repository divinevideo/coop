import { config, getActor, input } from '../../test/memberIntentFixtures.js';
import { prepareMemberIntent } from './memberIntentIdentity.js';

test('rejects a non-room item type before preparing an immutable membership intent', async () => {
  const value = { ...input(), itemTypeName: 'ordinary_item' };
  const fetchHTTP = jest.fn(async () => ({
    ok: true,
    status: 200,
    body: {
      caseId: value.caseId,
      author: 'd'.repeat(64),
      target: {
        communityId: 'a'.repeat(64),
        channelId: 'b'.repeat(64),
        rumorId: 'c'.repeat(64),
      },
    },
  }));
  await expect(
    prepareMemberIntent(config, { getActor, fetchHTTP }, value),
  ).rejects.toThrow();
  expect(fetchHTTP).not.toHaveBeenCalled();
});
