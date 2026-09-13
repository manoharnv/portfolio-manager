/**
 * The remaining six screens. In `__tests__/` for the same reason as
 * `approval.test.tsx`: everything under `app/` is a route.
 */
import { Alert, Platform } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import LoginScreen from '../app/(auth)/login';
import DashboardScreen from '../app/(tabs)/index';
import ProposalsScreen from '../app/(tabs)/proposals/index';
import OrdersScreen from '../app/(tabs)/orders/index';
import OrderDetailScreen from '../app/(tabs)/orders/[id]';
import BrokerScreen from '../app/(tabs)/broker';
import SettingsScreen from '../app/(tabs)/settings/index';
import GuardrailsScreen from '../app/(tabs)/settings/guardrails';
import AuditScreen, { summariseDetail } from '../app/(tabs)/audit';
import { GlobalBanners } from '../src/components/GlobalBanners';
import { setBackendForTests } from '../src/lib/backend';
import type { ConfigPatch } from '../src/hooks/useConfig';
import {
  NOW,
  buildAuditEvent,
  buildBook,
  buildBrokerSession,
  buildConfig,
  buildFunds,
  buildHolding,
  buildOrder,
  buildPosition,
  buildProposal,
  buildSessionPayload,
  fakeApiClient,
  isoPlus,
  withApp,
} from '../src/test-utils';

const fs = () => globalThis.__firestoreMock;
const router = () => globalThis.__routerMock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
  setBackendForTests(undefined);
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
describe('Dashboard', () => {
  const state = {
    holdings: [buildHolding()],
    positions: [buildPosition()],
    funds: buildFunds(),
    books: [
      buildBook({ id: 'long_term', label: 'Long term' }),
      buildBook({ id: 'scalp', label: 'Scalp' }),
    ],
    pendingProposals: [buildProposal()],
  };

  it('shows value, P&L, the broker chip, the pending badge and the books', async () => {
    setBackendForTests(fakeApiClient());
    await withApp(<DashboardScreen />, {
      ...state,
      portfolioSummary: {
        marketValueInr: 37_500,
        costBasisInr: 35_000,
        unrealisedPnlInr: 2_500,
        dayPnlInr: 150,
        holdingsCount: 1,
        positionsCount: 1,
        updatedAt: NOW.toISOString(),
      },
    });

    expect(screen.getByTestId('portfolio-value')).toHaveTextContent(/₹37,500/);
    expect(screen.getByTestId('day-pnl')).toHaveTextContent(/\+₹150\.00/);
    expect(screen.getByTestId('broker-chip')).toHaveTextContent(/kite/);
    expect(screen.getByTestId('broker-chip')).toHaveTextContent(/connected · expires/);
    expect(screen.getByTestId('pending-badge')).toHaveTextContent(/1proposal waiting/);
    expect(screen.getByTestId('portfolio-age')).toHaveTextContent(/1 holdings · updated/);

    // docs/10 §10.7 — no scalp book in this app.
    expect(screen.getByTestId('book-long_term')).toBeTruthy();
    expect(screen.queryByTestId('book-scalp')).toBeNull();
  });

  it('says when there is no cached portfolio and no books yet', async () => {
    setBackendForTests(fakeApiClient());
    await withApp(<DashboardScreen />);
    expect(screen.getByTestId('portfolio-age')).toHaveTextContent(/no cached portfolio yet/);
    expect(screen.getByText('No books yet')).toBeTruthy();
  });

  it('tells you to connect when the broker session is missing', async () => {
    setBackendForTests(fakeApiClient());
    const session = buildSessionPayload();
    session.brokers[0]!.needsLogin = true;
    session.brokers[0]!.reason = 'token expired at 6:00 am';
    await withApp(<DashboardScreen />, { session });
    expect(screen.getByTestId('broker-chip')).toHaveTextContent(/token expired at 6:00 am/);
  });

  it('confirms before halting, then calls the backend kill-switch route', async () => {
    const setKillSwitch = jest.fn(async () => ({ ok: true as const, enabled: true }));
    setBackendForTests(fakeApiClient({ setKillSwitch }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await withApp(<DashboardScreen />);

    await fireEvent.press(screen.getByTestId('kill-switch'));
    expect(alert).toHaveBeenCalled();
    expect(setKillSwitch).not.toHaveBeenCalled();

    // Take the destructive branch the human would have tapped.
    const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((b) => b.text === 'Halt trading')?.onPress?.());

    expect(setKillSwitch).toHaveBeenCalledWith(true, 'halted from the dashboard');
    // Never a direct Firestore write of config.killSwitch.
    expect(fs().updates).toEqual([]);
    alert.mockRestore();
  });

  it('offers to resume when the switch is already on, and reports a refusal', async () => {
    setBackendForTests(
      fakeApiClient({
        setKillSwitch: async () => ({
          ok: false,
          reason: 'FORBIDDEN',
          detail: 'uid not permitted',
          status: 403,
        }),
      }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const config = buildConfig({ killSwitch: true });
    await withApp(<DashboardScreen />, { config, effectiveConfig: config });

    expect(screen.getByTestId('kill-switch')).toHaveTextContent(/KILL SWITCH ON/);
    await fireEvent.press(screen.getByTestId('kill-switch'));
    const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((b) => b.text === 'Resume trading')?.onPress?.());

    expect(screen.getByTestId('killswitch-error')).toHaveTextContent(/Account not permitted/);
    alert.mockRestore();
  });

  it('routes to the broker and proposal screens', async () => {
    setBackendForTests(fakeApiClient());
    await withApp(<DashboardScreen />);
    await fireEvent.press(screen.getByTestId('broker-chip'));
    expect(router().push).toHaveBeenCalledWith('/broker');
    await fireEvent.press(screen.getByTestId('pending-badge'));
    expect(router().push).toHaveBeenCalledWith('/proposals');
  });
});

// ---------------------------------------------------------------------------
// Proposal inbox
// ---------------------------------------------------------------------------
describe('Proposal inbox', () => {
  it('lists pending proposals soonest-to-expire first', async () => {
    await withApp(<ProposalsScreen />, {
      pendingProposals: [
        buildProposal({ id: 'later', ttlExpiresAt: isoPlus(600) }),
        buildProposal({ id: 'sooner', ttlExpiresAt: isoPlus(60) }),
      ],
    });

    expect(screen.getByTestId('proposals-count')).toHaveTextContent(/2 live · 2 pending/);
    const cards = screen.getAllByTestId(/^proposal-(later|sooner)$/);
    expect(cards[0]?.props.testID).toBe('proposal-sooner');
  });

  it('rejects with exactly the diff the rules allow', async () => {
    await withApp(<ProposalsScreen />, { pendingProposals: [buildProposal()] });

    await fireEvent.press(screen.getByTestId('proposal-p1-reject'));
    await act(async () => undefined);

    expect(fs().updates).toEqual([
      {
        path: 'proposals/p1',
        data: { status: 'rejected', decidedBy: 'u1', decidedAt: NOW.toISOString() },
      },
    ]);
  });

  it('surfaces a failed reject', async () => {
    await withApp(<ProposalsScreen />, { pendingProposals: [buildProposal()] });
    fs().failNextUpdate(new Error('permission-denied'));

    await fireEvent.press(screen.getByTestId('proposal-p1-reject'));
    await act(async () => undefined);
    expect(screen.getByTestId('reject-error')).toHaveTextContent(/permission-denied/);
  });

  it('does not write when there is no signed-in uid', async () => {
    await withApp(<ProposalsScreen />, { uid: undefined, pendingProposals: [buildProposal()] });
    await fireEvent.press(screen.getByTestId('proposal-p1-reject'));
    await act(async () => undefined);
    expect(fs().updates).toEqual([]);
  });

  it('hides the countdown for a proposal whose TTL has passed', async () => {
    await withApp(<ProposalsScreen />, {
      pendingProposals: [buildProposal({ ttlExpiresAt: isoPlus(-5) })],
    });
    expect(screen.getByTestId('proposal-p1-countdown')).toHaveTextContent(/expired/);
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('opens the detail screen on tap', async () => {
    await withApp(<ProposalsScreen />, { pendingProposals: [buildProposal()] });
    await fireEvent.press(screen.getByTestId('proposal-p1-open'));
    expect(router().push).toHaveBeenCalledWith('/proposals/p1');
  });

  it('names the empty state and reports hidden malformed rows', async () => {
    await withApp(<ProposalsScreen />, { pendingError: '1 proposal record(s) are malformed' });
    expect(screen.getByText('Nothing waiting')).toBeTruthy();
    expect(screen.getByTestId('proposals-error')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
describe('Orders', () => {
  it('lists orders with status and fills', async () => {
    await withApp(<OrdersScreen />);
    await act(async () =>
      fs().emitCollection('orders', [
        { id: 'o1', data: buildOrder({ status: 'COMPLETE', filledQty: 10, avgFillPrice: 1499 }) },
      ]),
    );

    expect(screen.getByTestId('order-o1-status')).toHaveTextContent(/COMPLETE/);
    expect(screen.getByTestId('order-o1')).toHaveTextContent(/10\/10 filled/);
    await fireEvent.press(screen.getByTestId('order-o1'));
    expect(router().push).toHaveBeenCalledWith('/orders/o1');
  });

  it('shows a rejection reason in the list', async () => {
    await withApp(<OrdersScreen />);
    await act(async () =>
      fs().emitCollection('orders', [
        {
          id: 'o1',
          data: buildOrder({ status: 'REJECTED', rejectionReason: 'insufficient funds' }),
        },
      ]),
    );
    expect(screen.getByText('insufficient funds')).toBeTruthy();
  });

  it('names the empty state', async () => {
    await withApp(<OrdersScreen />);
    await act(async () => fs().emitCollection('orders', []));
    expect(screen.getByText('No orders yet')).toBeTruthy();
  });
});

describe('Order detail', () => {
  async function renderOrder(order = buildOrder(), state = {}) {
    (globalThis.__routeParams as { current: unknown }).current = { id: order.id };
    const view = await withApp(<OrderDetailScreen />, state);
    await act(async () => fs().emitDoc(`orders/${order.id}`, order));
    return view;
  }

  it('shows the fill and the audit trail', async () => {
    setBackendForTests(fakeApiClient());
    await renderOrder(buildOrder({ filledQty: 4, avgFillPrice: 1501 }));

    expect(screen.getByTestId('order-status')).toHaveTextContent(/OPEN/);
    expect(screen.getByTestId('avg-fill-price')).toHaveTextContent(/₹1,501\.00/);
    expect(screen.getByText('203.0.113.7')).toBeTruthy();
    expect(screen.getByText('paper')).toBeTruthy();
  });

  it('cancels an open order through the backend, after confirming', async () => {
    const cancelOrder = jest.fn(async () => ({ ok: true as const, orderId: 'o1' }));
    setBackendForTests(fakeApiClient({ cancelOrder }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderOrder();

    await fireEvent.press(screen.getByTestId('cancel-order'));
    const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((b) => b.text === 'Cancel order')?.onPress?.());

    expect(cancelOrder).toHaveBeenCalledWith('o1');
    expect(screen.getByTestId('cancel-result')).toHaveTextContent(/Cancel requested/);
    alert.mockRestore();
  });

  it('reports a refused cancel', async () => {
    setBackendForTests(
      fakeApiClient({
        cancelOrder: async () => ({
          ok: false,
          reason: 'NOT_CANCELLABLE',
          detail: 'already filled',
          status: 409,
        }),
      }),
    );
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderOrder();

    await fireEvent.press(screen.getByTestId('cancel-order'));
    const buttons = alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find((b) => b.text === 'Cancel order')?.onPress?.());

    expect(screen.getByTestId('cancel-result')).toHaveTextContent(/Cannot cancel/);
    alert.mockRestore();
  });

  it('hides cancel for a terminal order', async () => {
    setBackendForTests(fakeApiClient());
    await renderOrder(buildOrder({ status: 'COMPLETE' }));
    expect(screen.queryByTestId('cancel-order')).toBeNull();
    expect(screen.getByTestId('not-cancellable')).toBeTruthy();
  });

  it('disables cancel while the backend is unreachable', async () => {
    setBackendForTests(fakeApiClient());
    await renderOrder(buildOrder(), { backendReachable: false });
    expect(screen.getByTestId('cancel-order')).toHaveTextContent(/backend down/);
  });

  it('says so when the order does not exist', async () => {
    setBackendForTests(fakeApiClient());
    (globalThis.__routeParams as { current: unknown }).current = { id: 'nope' };
    await withApp(<OrderDetailScreen />);
    await act(async () => fs().emitDoc('orders/nope', undefined));
    expect(screen.getByText('Order not found')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Broker connect
// ---------------------------------------------------------------------------
describe('Broker Connect', () => {
  it('shows per-broker session state and static-IP health', async () => {
    setBackendForTests(fakeApiClient());
    await withApp(<BrokerScreen />, { brokerDocs: [buildBrokerSession()] });

    expect(screen.getByTestId('broker-kite')).toHaveTextContent(/allowlisted/);
    expect(screen.getByTestId('broker-kite-active')).toBeTruthy();
    expect(screen.getByTestId('broker-dhan')).toHaveTextContent(/no session for today/);
  });

  it('runs the login flow and refreshes the session on success', async () => {
    const refreshSession = jest.fn(async () => undefined);
    setBackendForTests(
      fakeApiClient({
        loginUrl: async () => ({
          ok: true,
          broker: 'kite',
          url: 'https://k/login',
          verifyLive: false,
        }),
        completeLogin: async () => ({
          ok: true,
          broker: 'kite',
          connected: true,
          expiresAt: '2026-02-04T00:30:00.000Z',
        }),
      }),
    );
    const browser = jest.requireMock('expo-web-browser') as {
      openAuthSessionAsync: jest.Mock;
    };
    browser.openAuthSessionAsync.mockResolvedValueOnce({
      type: 'success',
      url: 'pm://broker-callback?request_token=rt_1',
    });

    await withApp(<BrokerScreen />, { refreshSession });
    await fireEvent.press(screen.getByTestId('connect-kite'));
    await act(async () => undefined);

    expect(screen.getByTestId('broker-message')).toHaveTextContent(/kite connected/);
    expect(refreshSession).toHaveBeenCalled();
  });

  it('reports a cancelled login', async () => {
    setBackendForTests(
      fakeApiClient({
        loginUrl: async () => ({
          ok: true,
          broker: 'kite',
          url: 'https://k/login',
          verifyLive: false,
        }),
      }),
    );
    await withApp(<BrokerScreen />);
    await fireEvent.press(screen.getByTestId('connect-kite'));
    await act(async () => undefined);
    expect(screen.getByTestId('broker-message')).toHaveTextContent(/Login cancelled/);
  });

  it('disables connect while the backend is unreachable', async () => {
    setBackendForTests(fakeApiClient());
    await withApp(<BrokerScreen />, { backendReachable: false });
    expect(screen.getByTestId('connect-kite')).toHaveTextContent(/Backend unreachable/);
  });

  // config.activeBroker is not client-writable and has no backend route.
  it('states plainly that switching the active broker is not available', async () => {
    setBackendForTests(fakeApiClient());
    await withApp(<BrokerScreen />);
    expect(screen.getByTestId('switch-broker-note')).toHaveTextContent(
      /not available from the app/,
    );
    expect(fs().updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
describe('Settings', () => {
  it('shows environment and active broker as locked', async () => {
    await withApp(<SettingsScreen />);
    expect(screen.getByText(/paper.*🔒/s)).toBeTruthy();
    expect(screen.getByText(/kite.*🔒/s)).toBeTruthy();
    expect(screen.getByText(/rules reject any client write/)).toBeTruthy();
  });

  it('toggles tradingEnabled through the config writer', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => undefined);
    await withApp(<SettingsScreen />, { updateConfig });

    await fireEvent(screen.getByTestId('trading-enabled'), 'valueChange', false);
    await act(async () => undefined);
    expect(updateConfig).toHaveBeenCalledWith({ tradingEnabled: false }, expect.any(Date));
  });

  it('reports a refused config write', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => {
      throw new Error('permission-denied');
    });
    await withApp(<SettingsScreen />, { updateConfig });
    await fireEvent(screen.getByTestId('trading-enabled'), 'valueChange', false);
    await act(async () => undefined);
    expect(screen.getByTestId('settings-error')).toHaveTextContent(/permission-denied/);
  });

  it('routes to the guardrails screen and can sign out', async () => {
    await withApp(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('open-guardrails'));
    expect(router().push).toHaveBeenCalledWith('/settings/guardrails');

    await fireEvent.press(screen.getByTestId('sign-out'));
    await act(async () => undefined);
    expect(GoogleSignin.signOut).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------
describe('Guardrails', () => {
  it('cannot save a cap above the code ceiling', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => undefined);
    await withApp(<GuardrailsScreen />, { updateConfig });

    await fireEvent.changeText(screen.getByTestId('field-maxOrderValueInr'), '10000000');
    await act(async () => undefined);
    expect(screen.getByTestId('ceiling-warning')).toHaveTextContent(/will be saved as 500000/);

    await fireEvent.press(screen.getByTestId('save-guardrails'));
    await act(async () => undefined);

    const saved = updateConfig.mock.calls[0]![0] as unknown as {
      guardrails: { maxOrderValueInr: number };
    };
    expect(saved.guardrails.maxOrderValueInr).toBe(500_000);
    expect(screen.getByTestId('guardrails-saved')).toBeTruthy();
  });

  it('clamps orders-per-day and the collar too', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => undefined);
    await withApp(<GuardrailsScreen />, { updateConfig });

    await fireEvent.changeText(screen.getByTestId('field-maxOrdersPerDay'), '900');
    await fireEvent.changeText(screen.getByTestId('field-priceCollarPct'), '90');
    await fireEvent.press(screen.getByTestId('save-guardrails'));
    await act(async () => undefined);

    const saved = updateConfig.mock.calls[0]![0] as unknown as {
      guardrails: { maxOrdersPerDay: number; priceCollarPct: number };
    };
    expect(saved.guardrails.maxOrdersPerDay).toBe(50);
    expect(saved.guardrails.priceCollarPct).toBe(25);
  });

  it('has no control for environment or activeBroker at all', async () => {
    await withApp(<GuardrailsScreen />);
    expect(screen.queryByTestId('field-environment')).toBeNull();
    expect(screen.queryByTestId('field-activeBroker')).toBeNull();
  });

  it('toggles segments, products and the biometric requirement', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => undefined);
    await withApp(<GuardrailsScreen />, { updateConfig });

    await fireEvent.press(screen.getByTestId('segment-FNO'));
    await fireEvent.press(screen.getByTestId('product-DELIVERY'));
    await fireEvent(screen.getByTestId('field-requireBiometric'), 'valueChange', false);
    await fireEvent.changeText(screen.getByTestId('field-symbolAllowlist'), 'infy, tcs');
    await fireEvent.changeText(screen.getByTestId('field-symbolBlocklist'), 'yesbank');
    await fireEvent.press(screen.getByTestId('save-guardrails'));
    await act(async () => undefined);

    const saved = updateConfig.mock.calls[0]![0] as unknown as {
      guardrails: {
        allowedSegments: string[];
        allowedProducts: string[];
        requireBiometric: boolean;
        symbolAllowlist: string[] | null;
        symbolBlocklist: string[];
      };
    };
    expect(saved.guardrails.allowedSegments).toEqual(['EQ', 'FNO']);
    expect(saved.guardrails.allowedProducts).toEqual(['INTRADAY']);
    expect(saved.guardrails.requireBiometric).toBe(false);
    expect(saved.guardrails.symbolAllowlist).toEqual(['INFY', 'TCS']);
    expect(saved.guardrails.symbolBlocklist).toEqual(['YESBANK']);
  });

  it('clears the allowlist back to null when emptied', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => undefined);
    const config = buildConfig({
      guardrails: { ...buildConfig().guardrails, symbolAllowlist: ['INFY'] },
    });
    await withApp(<GuardrailsScreen />, { config, effectiveConfig: config, updateConfig });

    await fireEvent.changeText(screen.getByTestId('field-symbolAllowlist'), '');
    await fireEvent.press(screen.getByTestId('save-guardrails'));
    await act(async () => undefined);

    const saved = updateConfig.mock.calls[0]![0] as unknown as {
      guardrails: { symbolAllowlist: string[] | null };
    };
    expect(saved.guardrails.symbolAllowlist).toBeNull();
  });

  it('reports a refused save', async () => {
    const updateConfig = jest.fn(async (_patch: ConfigPatch, _now: Date) => {
      throw new Error('permission-denied');
    });
    await withApp(<GuardrailsScreen />, { updateConfig });
    await fireEvent.press(screen.getByTestId('save-guardrails'));
    await act(async () => undefined);
    expect(screen.getByTestId('guardrails-error')).toHaveTextContent(/permission-denied/);
  });

  it('writes a notification preference into users/{uid}.prefs only', async () => {
    await withApp(<GuardrailsScreen />);
    await act(async () => fs().emitDoc('users/u1', { prefs: {} }));

    await fireEvent(screen.getByTestId('pref-fills'), 'valueChange', false);
    await act(async () => undefined);

    expect(fs().updates).toHaveLength(1);
    expect(Object.keys(fs().updates[0]!.data)).toEqual(['prefs']);
  });

  it('says so when there is no config to edit', async () => {
    await withApp(<GuardrailsScreen />, { config: undefined, effectiveConfig: undefined });
    expect(screen.getByText('No config yet')).toBeTruthy();
  });

  it('explains why per-strategy toggles are not here', async () => {
    await withApp(<GuardrailsScreen />);
    expect(screen.getByText(/read-only for the client/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
describe('Audit', () => {
  it('renders the feed with labels and details', async () => {
    await withApp(<AuditScreen />);
    await act(async () =>
      fs().emitCollection('auditLog', [
        {
          id: 'a1',
          data: buildAuditEvent({
            type: 'guardrail.blocked',
            detail: { reason: 'over daily cap', nested: { x: 1 } },
          }),
        },
      ]),
    );

    expect(screen.getByText('Guardrail blocked')).toBeTruthy();
    expect(screen.getByTestId('audit-a1')).toHaveTextContent(/reason: over daily cap/);
  });

  it('names the empty state', async () => {
    await withApp(<AuditScreen />);
    await act(async () => fs().emitCollection('auditLog', []));
    expect(screen.getByText('No audit events')).toBeTruthy();
  });

  it('summarises a detail object to at most three scalar fields', () => {
    expect(summariseDetail({ a: 1, b: 'x', c: true, d: 'ignored' })).toBe('a: 1 · b: x · c: true');
    expect(summariseDetail({ nested: { a: 1 }, nil: null })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
describe('Login', () => {
  it('offers Google, and Apple on iOS', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    await render(<LoginScreen />);
    await act(async () => undefined);

    expect(screen.getByTestId('sign-in-google')).toBeTruthy();
    expect(screen.getByTestId('sign-in-apple')).toBeTruthy();
    // No anonymous path on a money app.
    expect(screen.queryByText(/Skip/i)).toBeNull();
  });

  it('hides Apple off iOS', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    await render(<LoginScreen />);
    await act(async () => undefined);
    expect(screen.queryByTestId('sign-in-apple')).toBeNull();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  it('signs in with Google', async () => {
    await render(<LoginScreen />);
    await fireEvent.press(screen.getByTestId('sign-in-google'));
    await act(async () => undefined);
    expect(GoogleSignin.signIn).toHaveBeenCalled();
  });

  it('shows why a sign-in failed', async () => {
    (GoogleSignin.signIn as jest.Mock).mockRejectedValueOnce({ code: 'SIGN_IN_CANCELLED' });
    await render(<LoginScreen />);
    await fireEvent.press(screen.getByTestId('sign-in-google'));
    await act(async () => undefined);
    expect(screen.getByTestId('login-error')).toHaveTextContent(/Sign-in cancelled\./);
  });
});

// ---------------------------------------------------------------------------
// The global banner strip
// ---------------------------------------------------------------------------
describe('GlobalBanners', () => {
  it('is silent when everything is fine', async () => {
    await withApp(<GlobalBanners />);
    expect(screen.queryByTestId('banner-killswitch')).toBeNull();
    expect(screen.queryByTestId('banner-backend-down')).toBeNull();
    expect(screen.queryByTestId('banner-no-session')).toBeNull();
  });

  it('renders nothing at all when signed out', async () => {
    const view = await withApp(<GlobalBanners />, { uid: undefined });
    expect(view.toJSON()).toBeNull();
  });

  it('shows the kill switch and trading-disabled banners', async () => {
    const config = buildConfig({ killSwitch: true, tradingEnabled: false });
    await withApp(<GlobalBanners />, { config, effectiveConfig: config });
    expect(screen.getByTestId('banner-killswitch')).toBeTruthy();
    expect(screen.getByTestId('banner-trading-disabled')).toBeTruthy();
  });

  it('shows the backend-down banner and hides the session one behind it', async () => {
    await withApp(<GlobalBanners />, {
      backendReachable: false,
      sessionError: 'Backend unreachable: offline',
      session: buildSessionPayload({ activeBroker: null }),
    });
    expect(screen.getByTestId('banner-backend-down')).toHaveTextContent(/offline/);
    expect(screen.queryByTestId('banner-no-session')).toBeNull();
  });

  it('shows the session banner when the backend is up but the broker is not', async () => {
    const session = buildSessionPayload();
    session.brokers[0]!.needsLogin = true;
    session.brokers[0]!.reason = 'token expired';
    await withApp(<GlobalBanners />, { session });
    expect(screen.getByTestId('banner-no-session')).toHaveTextContent(/token expired/);
  });

  it('shows a configuration problem', async () => {
    await withApp(<GlobalBanners />, { configError: 'missing app config "firebase.apiKey"' });
    expect(screen.getByTestId('banner-config')).toHaveTextContent(/firebase.apiKey/);
  });
});
