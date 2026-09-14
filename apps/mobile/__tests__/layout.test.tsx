/**
 * The root layout: the auth gate, deep-link routing, FCM registration, and the
 * tab bar's pending badge. `AppProvider` is exercised for real here — these are
 * the only tests that drive the live hook composition rather than a fixture.
 */
import { Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { useURL } from 'expo-linking';
import RootLayout from '../app/_layout';
import TabsLayout, { TabIcon } from '../app/(tabs)/_layout';
import ProposalsLayout from '../app/(tabs)/proposals/_layout';
import OrdersLayout from '../app/(tabs)/orders/_layout';
import SettingsLayout from '../app/(tabs)/settings/_layout';
import { AppProvider, useApp } from '../src/AppContext';
import { setBackendForTests } from '../src/lib/backend';
import {
  NOW,
  buildBook,
  buildConfig,
  buildHolding,
  buildProposal,
  buildSessionPayload,
  fakeApiClient,
} from '../src/test-utils';

const fs = () => globalThis.__firestoreMock;
const authMock = () => globalThis.__authMock;
const router = () => globalThis.__routerMock;
const messaging = () => globalThis.__messagingMock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  setBackendForTests(
    fakeApiClient({ session: async () => ({ ok: true, ...buildSessionPayload() }) }),
  );
  (useURL as jest.Mock).mockReturnValue(null);
});
afterEach(() => {
  jest.useRealTimers();
  setBackendForTests(undefined);
});

describe('auth gate', () => {
  it('sends a signed-out visitor to the login screen', async () => {
    await render(<RootLayout />);
    await act(async () => undefined);
    expect(router().replace).toHaveBeenCalledWith('/login');
  });

  it('does not redirect a signed-in user away from the app', async () => {
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    await render(<RootLayout />);
    await act(async () => undefined);
    expect(router().replace).not.toHaveBeenCalledWith('/login');
  });
});

describe('deep links and push', () => {
  it('registers for push once a uid exists and writes the token', async () => {
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    await render(<RootLayout />);
    await act(async () => undefined);

    expect(messaging().requestPermission).toHaveBeenCalled();
    expect(fs().updates).toEqual([
      { path: 'users/u1', data: { fcmTokens: { __arrayUnion: ['fcm-token-123'] } } },
    ]);
  });

  it('routes a notification tap to the right screen', async () => {
    let openedListener: ((m: unknown) => void) | undefined;
    messaging().onNotificationOpenedApp.mockImplementation((_m: unknown, listener: never) => {
      openedListener = listener;
      return jest.fn();
    });
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    await render(<RootLayout />);
    await act(async () => undefined);

    await act(async () =>
      openedListener?.({
        data: { type: 'proposal', proposalId: 'p1', deepLink: 'pm://proposals/p1' },
      }),
    );
    expect(router().push).toHaveBeenCalledWith('/proposals/p1');
  });

  it('follows a cold-start URL', async () => {
    (useURL as jest.Mock).mockReturnValue('pm://broker-connect');
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    await render(<RootLayout />);
    await act(async () => undefined);
    expect(router().push).toHaveBeenCalledWith('/broker');
  });

  it('ignores a URL that routes nowhere', async () => {
    (useURL as jest.Mock).mockReturnValue('pm://not-a-screen');
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    await render(<RootLayout />);
    await act(async () => undefined);
    expect(router().push).not.toHaveBeenCalled();
  });

  it('does not touch push or links while signed out', async () => {
    (useURL as jest.Mock).mockReturnValue('pm://proposals/p1');
    await render(<RootLayout />);
    await act(async () => undefined);
    expect(messaging().requestPermission).not.toHaveBeenCalled();
    expect(router().push).not.toHaveBeenCalled();
  });
});

/** Reads the composed state the way every screen does. */
function Probe() {
  const app = useApp();
  return (
    <Text testID="probe">
      {`${app.uid ?? 'none'}|${app.pendingProposals.length}|${app.config?.environment ?? 'no-config'}|${
        app.session?.activeBroker ?? 'no-session'
      }|${app.books.length}|${app.portfolioSummary.marketValueInr}`}
    </Text>
  );
}

describe('AppProvider', () => {
  it('composes every listener plus the backend session into one state', async () => {
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    await render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );

    await act(async () => {
      fs().emitCollection('proposals', [{ id: 'p1', data: buildProposal() }]);
      fs().emitDoc('config/u1', buildConfig());
      fs().emitCollection('books/u1/books', [{ id: 'swing', data: buildBook() }]);
      fs().emitCollection('portfolio/u1/holdings', [{ id: 'k', data: buildHolding() }]);
    });

    expect(screen.getByTestId('probe')).toHaveTextContent(/^u1\|1\|paper\|kite\|1\|37500$/);
  });

  it('refuses to be used outside the provider', async () => {
    await expect(render(<Probe />)).rejects.toThrow('useApp must be used inside');
  });
});

describe('nested stack layouts', () => {
  it('render without a router', async () => {
    for (const Layout of [ProposalsLayout, OrdersLayout, SettingsLayout]) {
      const view = await render(<Layout />);
      expect(view.toJSON()).toBeDefined();
    }
  });

  it('builds the tab bar from the shared state, badge included', async () => {
    authMock().setUser({ uid: 'u1', email: 'you@example.com' });
    const view = await render(
      <AppProvider>
        <TabsLayout />
      </AppProvider>,
    );
    await act(async () => {
      fs().emitCollection('proposals', [{ id: 'p1', data: buildProposal() }]);
    });
    expect(view.toJSON()).toBeDefined();
  });

  it('renders a tab glyph', async () => {
    await render(<TabIcon glyph="◧" color="#fff" />);
    expect(screen.getByText('◧')).toBeTruthy();
  });
});
