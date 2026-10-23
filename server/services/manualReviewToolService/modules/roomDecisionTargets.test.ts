import {
  assertUniqueRoomDecisionTargets,
  recordedRoomExecutionCount,
} from './roomDecisionTargets.js';

const item = { itemId: 'case', itemTypeIdentifier: { id: 'room-type' } };
const primary = {
  type: 'CUSTOM_ACTION',
  actions: [{ id: 'remove' }],
  policies: [],
} as const;
const related = {
  actionIds: ['remove'],
  itemIds: ['case'],
  itemTypeId: 'room-type',
  policyIds: [],
};

test.each([
  [[{ ...primary, actions: [{ id: 'remove' }, { id: 'remove' }] }], []],
  [[primary, primary], []],
  [[], [{ ...related, actionIds: ['remove', 'remove'] }]],
  [[], [{ ...related, itemIds: ['case', 'case'] }]],
  [[primary], [related]],
  [[], [related, related]],
] as const)(
  'duplicate room targets count one historical execution and reject new intent: %#',
  (decisions, relations) => {
    expect(
      recordedRoomExecutionCount(item, decisions as never, relations as never),
    ).toBe(1);
    expect(() =>
      assertUniqueRoomDecisionTargets(
        item,
        decisions as never,
        relations as never,
      ),
    ).toThrow('only once');
  },
);

test('different actions, item types and item IDs require independent settlement', () => {
  const relations = [
    related,
    { ...related, actionIds: ['ban'] },
    { ...related, itemTypeId: 'other-type' },
    { ...related, itemIds: ['other-item'] },
  ];
  expect(recordedRoomExecutionCount(item, [], relations)).toBe(4);
  expect(() =>
    assertUniqueRoomDecisionTargets(item, [], relations),
  ).not.toThrow();
});

test('legacy persisted item identifiers count the same execution targets', () => {
  expect(
    recordedRoomExecutionCount(
      { id: 'case', typeIdentifier: { id: 'room-type' } },
      [primary] as never,
      [related],
    ),
  ).toBe(1);
});
