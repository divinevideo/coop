import { TooltipProvider } from '@/coop-ui/Tooltip';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import '@testing-library/jest-dom/extend-expect';

import { GQLUserPermission } from '@/graphql/generated';
import { vi } from 'vitest';

import Sidebar, { type MenuItem } from './Sidebar';

const menuItems: MenuItem[] = [
  {
    title: 'Overview',
    urlPath: 'overview',
    requiredPermissions: [],
  },
  {
    title: 'Review Console',
    urlPath: 'manual_review',
    requiredPermissions: [],
  },
];

const settingsMenuItems: MenuItem[] = [
  {
    title: 'Settings',
    urlPath: 'settings',
    requiredPermissions: [],
    subItems: [
      {
        title: 'Item Types',
        urlPath: 'item_types',
        requiredPermissions: [GQLUserPermission.ManageOrg],
      },
      {
        title: 'Actions',
        urlPath: 'actions',
        requiredPermissions: [GQLUserPermission.ManageOrg],
      },
      {
        title: 'Users',
        urlPath: 'users',
        requiredPermissions: [GQLUserPermission.ManageOrg],
      },
      {
        title: 'Settings',
        urlPath: '',
        requiredPermissions: [GQLUserPermission.ManageOrg],
      },
    ],
  },
];

const allPermissions = [GQLUserPermission.ManageOrg];

function renderSidebar(
  initialPath = '/dashboard/overview',
  selectedMenuItem: string | null = null,
  overrides: {
    permissions?: GQLUserPermission[];
  } = {},
) {
  const setSelectedMenuItem = vi.fn();
  const logout = vi.fn();

  const result = render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <Sidebar
          menuItems={menuItems}
          settingsMenuItems={settingsMenuItems}
          selectedMenuItem={selectedMenuItem}
          setSelectedMenuItem={setSelectedMenuItem}
          permissions={overrides.permissions ?? allPermissions}
          logout={logout}
        />
      </MemoryRouter>
    </TooltipProvider>,
  );

  return { ...result, setSelectedMenuItem, logout };
}

function getSettingsToggle() {
  return (
    document.querySelector<HTMLElement>('[role="button"][tabindex="0"]') ??
    undefined
  );
}

describe('Sidebar', () => {
  it('renders main menu items and footer links', () => {
    renderSidebar();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Review Console')).toBeInTheDocument();
    expect(getSettingsToggle()).toBeDefined();
  });

  it('shows settings sub-items when on a settings page', () => {
    renderSidebar('/dashboard/settings', 'Settings');
    expect(screen.getByText('Item Types')).toBeVisible();
    expect(screen.getByText('Actions')).toBeVisible();
    expect(screen.getByText('Users')).toBeVisible();
  });

  it('hides settings sub-items when not on a settings page', () => {
    renderSidebar('/dashboard/overview', 'Overview');
    const itemTypes = screen.getByText('Item Types');
    const parent = itemTypes.closest('[class*="overflow-hidden"]');
    expect(parent).toHaveClass('max-h-0');
  });

  it('highlights gear icon on settings pages but not elsewhere', () => {
    const { unmount } = renderSidebar('/dashboard/settings', 'Settings');
    expect(getSettingsToggle()!.className).toContain('text-primary');
    unmount();

    renderSidebar('/dashboard/overview', 'Overview');
    expect(getSettingsToggle()!.className).not.toContain('text-primary');
  });

  it('expands settings when gear icon is clicked', () => {
    renderSidebar('/dashboard/overview', 'Overview');
    const settings = screen
      .getByText('Item Types')
      .closest('[class*="overflow-hidden"]');
    expect(settings).toHaveClass('max-h-0');
    fireEvent.click(getSettingsToggle()!);
    expect(settings).toHaveClass('max-h-[1000px]');
  });

  describe('path-based menu selection', () => {
    it.each([
      ['/dashboard/overview', 'Overview'],
      ['/dashboard/settings', 'Settings'],
      ['/dashboard/settings/item_types', 'Item Types'],
      ['/dashboard/settings/actions', 'Actions'],
    ])('%s → %s', (path, expected) => {
      const { setSelectedMenuItem } = renderSidebar(path);
      expect(setSelectedMenuItem).toHaveBeenCalledWith(expected);
    });
  });

  it('hides gear icon when user lacks ManageOrg permission', () => {
    renderSidebar('/dashboard/overview', 'Overview', { permissions: [] });
    expect(getSettingsToggle()).toBeUndefined();
  });

  it('hides sub-items when user lacks permissions', () => {
    renderSidebar('/dashboard/settings', 'Settings', { permissions: [] });
    expect(screen.queryByText('Item Types')).not.toBeInTheDocument();
  });
});
