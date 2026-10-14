import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import '@testing-library/jest-dom/extend-expect';

import { vi } from 'vitest';

import ConcordEnforcementStatus from './ConcordEnforcementStatus';

const decision = {
  decisionId: '10000000-0000-4000-8000-000000000001',
  action: 'remove_message',
  deliveries: [
    {
      target: 'divine_relay',
      state: 'verified',
      attempts: 1,
      resultCode: null,
    },
    { target: 'concord', state: 'acknowledged', attempts: 1, resultCode: null },
    {
      target: 'discord',
      state: 'failed',
      attempts: 2,
      resultCode: 'delivery_failed',
    },
  ],
};
const data = {
  applicable: true,
  content: '<script>synthetic evidence</script>',
  reason: 'Synthetic report',
  expiresAt: '2030-01-01T00:00:00Z',
  permissions: ['view', 'retry', 'remove_message'],
  decisions: [decision],
};
const response = (body: unknown) => ({ ok: true, json: async () => body });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
test('keeps separate delivery states visible and hides evidence until requested', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(data)),
  );
  render(
    <ConcordEnforcementStatus
      itemIdentifier={{ id: 'synthetic', typeId: 'room' }}
    />,
  );
  expect(await screen.findByText('Divine relay')).toBeInTheDocument();
  expect(screen.getByText('Verified')).toBeInTheDocument();
  expect(
    screen.getByText('Acknowledged — verification pending'),
  ).toBeInTheDocument();
  expect(screen.getByText(/^Failed/)).toBeInTheDocument();
  expect(screen.queryByText(data.content)).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('View report evidence'));
  expect(screen.getByText(data.content)).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
});
test('retry uses the authenticated staff route and refreshes all three results', async () => {
  const fetchMock = vi.fn(async () => response(data));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <ConcordEnforcementStatus
      itemIdentifier={{ id: 'synthetic', typeId: 'room' }}
    />,
  );
  fireEvent.click(await screen.findByText('Retry delivery'));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/concord/items/room/synthetic/decisions/10000000-0000-4000-8000-000000000001/retry',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    ),
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
});
test('does not offer retry to a reviewer without permission for the action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ ...data, permissions: ['view'] })),
  );
  render(
    <ConcordEnforcementStatus
      itemIdentifier={{ id: 'synthetic', typeId: 'room' }}
    />,
  );
  await screen.findByText('Divine relay');
  expect(screen.queryByText('Retry delivery')).not.toBeInTheDocument();
});
test('errors remain visible without claiming completion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false })),
  );
  render(
    <ConcordEnforcementStatus
      itemIdentifier={{ id: 'synthetic', typeId: 'room' }}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Room enforcement status is unavailable',
  );
  expect(screen.queryByText('Verified')).not.toBeInTheDocument();
});
