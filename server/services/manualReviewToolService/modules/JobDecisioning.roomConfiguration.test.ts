import {
  assertRoomActionConfigurationAvailable,
  assertRoomRelatedItemTypeAvailable,
} from './JobDecisioning.js';

test.each([
  { actions: [] },
  { actions: [{ id: 'room-ban', name: 'ordinary_action' }] },
  { actions: [{ id: 'other-ban', name: 'concord_ban_member' }] },
])(
  'room publication rejects missing or changed action configuration: %j',
  ({ actions }) => {
    expect(() =>
      assertRoomActionConfigurationAvailable(['room-ban'], actions),
    ).toThrow('Room action configuration unavailable');
  },
);

test('room publication accepts complete room action configuration', () => {
  expect(() =>
    assertRoomActionConfigurationAvailable(
      ['room-ban'],
      [{ id: 'room-ban', name: 'concord_ban_member' }],
    ),
  ).not.toThrow();
});

test.each([null, undefined])('missing related type fails closed: %s', (itemType) => {
  expect(() => assertRoomRelatedItemTypeAvailable(itemType)).toThrow(
    'Room related item type configuration unavailable',
  );
});
