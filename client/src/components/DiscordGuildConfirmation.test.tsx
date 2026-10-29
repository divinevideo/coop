import { useGQLRoomScopeStaffQuery } from '@/graphql/generated';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';

import DiscordGuildConfirmation from './DiscordGuildConfirmation';

vi.mock('@/graphql/generated', () => ({ useGQLRoomScopeStaffQuery: vi.fn() }));
afterEach(cleanup);
test('admin explicitly opts in and can decline guild-wide enforcement', () => {
  vi.mocked(useGQLRoomScopeStaffQuery).mockReturnValue({
    data: {
      me: { role: 'ADMIN', approvedByAdmin: true, rejectedByAdmin: false },
    },
  } as never);
  const onChange = vi.fn();
  const view = render(
    <DiscordGuildConfirmation value={false} onChange={onChange} />,
  );
  const toggle = screen.getByRole('switch', {
    name: 'Also apply to the entire Discord server',
  });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenLastCalledWith(true);
  view.rerender(<DiscordGuildConfirmation value={true} onChange={onChange} />);
  fireEvent.click(toggle);
  expect(onChange).toHaveBeenLastCalledWith(false);
});
test('non-admin and unapproved staff cannot opt in', () => {
  for (const me of [
    { role: 'MODERATOR_MANAGER', approvedByAdmin: true },
    { role: 'ADMIN', approvedByAdmin: false },
  ]) {
    vi.mocked(useGQLRoomScopeStaffQuery).mockReturnValue({
      data: { me },
    } as never);
    const view = render(
      <DiscordGuildConfirmation value={false} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    view.unmount();
  }
});
