export const duplicateRoomTargetCases = [
  'none',
  'primary',
  'components',
  'related-actions',
  'related-items',
  'overlap',
] as const;

/** Historical rows only: submit now refuses each duplicate form before insert. */
export function duplicateRoomTargetFixture(
  duplicates: (typeof duplicateRoomTargetCases)[number],
) {
  const primary = {
    type: 'CUSTOM_ACTION' as const,
    actions: [{ id: 'remove' }],
    policies: [],
    itemIds: ['case'],
    itemTypeId: 'room-type',
  };
  const related = {
    actionIds: ['remove'],
    itemIds: ['case'],
    itemTypeId: 'room-type',
    policyIds: [],
  };
  return {
    decision_components:
      duplicates === 'primary'
        ? [{ ...primary, actions: [{ id: 'remove' }, { id: 'remove' }] }]
        : duplicates === 'components'
          ? [primary, primary]
          : duplicates.startsWith('related')
            ? []
            : [primary],
    related_actions:
      duplicates === 'related-actions'
        ? [{ ...related, actionIds: ['remove', 'remove'] }]
        : duplicates === 'related-items'
          ? [{ ...related, itemIds: ['case', 'case'] }]
          : duplicates === 'overlap'
            ? [related]
            : [],
  };
}
