/**
 * The approval screen — docs/06 §6.3 (3) / §6.4.
 *
 * These live in `__tests__/` rather than beside the route file because every
 * `.tsx` under `app/` becomes a route (expo-router's `_ctx` glob has no test
 * exclusion), so a colocated `[id].test.tsx` would ship as a screen.
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import ProposalDetailScreen from '../app/(tabs)/proposals/[id]';
import { setBackendForTests } from '../src/lib/backend';
import type { ExecuteRequest } from '../src/lib/api';
import type { AppState } from '../src/AppContext';
import {
  NOW,
  buildConfig,
  buildHolding,
  buildProposal,
  buildSessionPayload,
  fakeApiClient,
  isoPlus,
  withApp,
} from '../src/test-utils';

const fs = () => globalThis.__firestoreMock;

const biometric = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;

/** A backend whose portfolio refresh succeeds and whose execute is recorded. */
function backendWith(
  executeProposal: (id: string, body: ExecuteRequest) => Promise<never> | Promise<unknown>,
) {
  return fakeApiClient({
    holdings: async () => ({ ok: true, at: NOW.toISOString(), holdings: [] }),
    positions: async () => ({ ok: true, at: NOW.toISOString(), positions: [] }),
    executeProposal: executeProposal as never,
  });
}

const OK_EXECUTE = {
  ok: true as const,
  orderId: 'o1',
  brokerOrderId: 'BRK-1',
  status: 'SUBMITTED' as const,
};

/** A fresh, in-collar quote: a holding priced exactly at the proposal's limit. */
const FRESH_HOLDING = () => buildHolding({ lastPrice: 1500, updatedAt: NOW.toISOString() });

async function renderScreen(state: Partial<AppState> = {}, proposal = buildProposal()) {
  (globalThis.__routeParams as { current: unknown }).current = { id: proposal.id };
  const view = await withApp(<ProposalDetailScreen />, {
    holdings: [FRESH_HOLDING()],
    ...state,
  });
  await act(async () => {
    fs().emitDoc(`proposals/${proposal.id}`, proposal);
  });
  return view;
}

/** Biometric, then the confirm slide — the full docs/06 §6.4 gesture. */
async function approve() {
  await fireEvent.press(screen.getByTestId('approve-button'));
  await act(async () => undefined);
  await fireEvent(screen.getByTestId('confirm-slider'), 'accessibilityAction', {
    nativeEvent: { actionName: 'activate' },
  });
  await act(async () => undefined);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  biometric.hasHardwareAsync.mockResolvedValue(true);
  biometric.isEnrolledAsync.mockResolvedValue(true);
  biometric.authenticateAsync.mockResolvedValue({ success: true } as never);
});
afterEach(() => {
  jest.useRealTimers();
  setBackendForTests(undefined);
});

describe('rendering the proposal', () => {
  it('shows the order, the why, the market context and both checklists', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    await renderScreen();

    expect(screen.getByTestId('detail-side')).toHaveTextContent(/BUY/);
    expect(screen.getByText('NSE:INFY')).toBeTruthy();
    expect(screen.getByText(/LIMIT · @ ₹1,500.00 · DELIVERY · DAY/)).toBeTruthy();
    expect(screen.getByTestId('detail-rationale')).toHaveTextContent(/RSI\(14\)/);
    expect(screen.getByTestId('detail-live-ltp')).toHaveTextContent(/₹1,500\.00/);
    expect(screen.getByTestId('detail-drift')).toHaveTextContent(/\+0\.00%/);
    // est. value 15,000 + est. charges 25 on a BUY.
    expect(screen.getByTestId('detail-net')).toHaveTextContent(/₹15,025\.00/);
    expect(screen.getByTestId('engine-checklist')).toBeTruthy();
    expect(screen.getByTestId('live-checklist')).toBeTruthy();
  });

  it('says so when the proposal does not exist', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    (globalThis.__routeParams as { current: unknown }).current = { id: 'missing' };
    await withApp(<ProposalDetailScreen />);
    await act(async () => fs().emitDoc('proposals/missing', undefined));
    expect(screen.getByText('Proposal not found')).toBeTruthy();
  });

  it('refuses to render a malformed proposal as approvable', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    (globalThis.__routeParams as { current: unknown }).current = { id: 'p1' };
    await withApp(<ProposalDetailScreen />);
    await act(async () => fs().emitDoc('proposals/p1', { id: 'p1', junk: true }));

    expect(screen.getByTestId('proposal-error')).toBeTruthy();
    expect(screen.queryByTestId('approve-button')).toBeNull();
  });

  it('opens an already-decided proposal read-only', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    await renderScreen({}, buildProposal({ status: 'filled' }));

    expect(screen.getByTestId('read-only')).toBeTruthy();
    expect(screen.queryByTestId('approve-button')).toBeNull();
    expect(screen.queryByTestId('detail-reject')).toBeNull();
  });
});

describe('the happy path', () => {
  it('executes exactly once, with a fresh idempotency key and the LTP on screen', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    await renderScreen();

    await approve();

    expect(executeProposal).toHaveBeenCalledTimes(1);
    const [id, body] = executeProposal.mock.calls[0] as unknown as [string, ExecuteRequest];
    expect(id).toBe('p1');
    // The number the human actually saw, not a freshly-fetched one.
    expect(body.clientSeenLtp).toBe(1500);
    expect(body.idempotencyKey).toMatch(
      /^pm-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(screen.getByTestId('execute-success')).toHaveTextContent(
      /SUBMITTED · broker order BRK-1/,
    );
  });

  it('asks for the biometric before it asks for the slide', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    await renderScreen();

    // The slider does not even exist until the biometric has passed.
    expect(screen.queryByTestId('confirm-slider')).toBeNull();
    await fireEvent.press(screen.getByTestId('approve-button'));
    await act(async () => undefined);

    expect(biometric.authenticateAsync).toHaveBeenCalled();
    expect(screen.getByTestId('confirm-slider')).toBeTruthy();
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('labels the slide with what it will actually do', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    await renderScreen();
    await fireEvent.press(screen.getByTestId('approve-button'));
    await act(async () => undefined);

    expect(screen.getByText('Slide to BUY 10 INFY at ₹1,500.00')).toBeTruthy();
  });
});

describe('the biometric gate', () => {
  it('sends nothing when the prompt fails', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    biometric.authenticateAsync.mockResolvedValue({
      success: false,
      error: 'authentication_failed',
    } as never);
    await renderScreen();

    await fireEvent.press(screen.getByTestId('approve-button'));
    await act(async () => undefined);

    expect(executeProposal).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-slider')).toBeNull();
    expect(screen.getByTestId('gate-error')).toBeTruthy();
  });

  it('sends nothing when the prompt is cancelled', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    biometric.authenticateAsync.mockResolvedValue({
      success: false,
      error: 'user_cancel',
    } as never);
    await renderScreen();

    await fireEvent.press(screen.getByTestId('approve-button'));
    await act(async () => undefined);
    expect(screen.getByTestId('gate-error')).toHaveTextContent(/you cancelled the biometric/);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  // docs/00 §0.7.1 — missing evidence is a refusal.
  it('fails closed on a device with no enrolment while requireBiometric is on', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    biometric.isEnrolledAsync.mockResolvedValue(false);
    await renderScreen();

    await fireEvent.press(screen.getByTestId('approve-button'));
    await act(async () => undefined);
    expect(screen.getByTestId('gate-error')).toHaveTextContent(/no Face ID/);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('skips the prompt when the config turns it off', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    const config = buildConfig({
      guardrails: { ...buildConfig().guardrails, requireBiometric: false },
    });
    await renderScreen({ config, effectiveConfig: config });

    await approve();
    expect(biometric.authenticateAsync).not.toHaveBeenCalled();
    expect(executeProposal).toHaveBeenCalledTimes(1);
  });
});

describe('the gate disables approve, visibly', () => {
  const cases: {
    name: string;
    state?: Partial<AppState>;
    proposal?: ReturnType<typeof buildProposal>;
    block: string;
    text: RegExp;
  }[] = [
    {
      name: 'TTL expired',
      proposal: buildProposal({ ttlExpiresAt: isoPlus(-1) }),
      block: 'block-TTL_EXPIRED',
      text: /TTL has elapsed/,
    },
    {
      name: 'kill switch on',
      state: {
        config: buildConfig({ killSwitch: true }),
        effectiveConfig: buildConfig({ killSwitch: true }),
      },
      block: 'block-KILL_SWITCH',
      text: /kill switch is on/,
    },
    {
      name: 'no broker session',
      state: { session: buildSessionPayload({ activeBroker: null }) },
      block: 'block-NO_SESSION',
      text: /no active broker/,
    },
    {
      name: 'backend unreachable',
      state: { backendReachable: false },
      block: 'block-BACKEND_DOWN',
      text: /execution unavailable/,
    },
    {
      name: 'no live quote',
      state: { holdings: [] },
      block: 'block-NO_QUOTE',
      text: /no live price/,
    },
  ];

  it.each(cases)('$name', async ({ state, proposal, block, text }) => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    await renderScreen(state ?? {}, proposal ?? buildProposal());

    const button = screen.getByTestId('approve-button');
    expect(button.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('Approve unavailable')).toBeTruthy();
    expect(screen.getByTestId(block)).toHaveTextContent(text);

    await fireEvent.press(button);
    await act(async () => undefined);
    expect(executeProposal).not.toHaveBeenCalled();
  });

  it('disables approve when the live price is outside the collar', async () => {
    const executeProposal = jest.fn(async () => OK_EXECUTE);
    setBackendForTests(backendWith(executeProposal));
    // Collar is 1%; a ₹1,700 live price against a ₹1,500 limit is ~11.8% away.
    await renderScreen({ holdings: [buildHolding({ lastPrice: 1700 })] });

    expect(screen.getByTestId('block-PRICE_OUT_OF_COLLAR')).toHaveTextContent(/refresh/);
    expect(screen.getByTestId('approve-button').props.accessibilityState.disabled).toBe(true);
  });
});

describe('execution results', () => {
  async function executeWith(failure: Record<string, unknown>) {
    setBackendForTests(backendWith(async () => failure as never));
    await renderScreen();
    await approve();
  }

  it('renders GUARDRAIL_BLOCKED with the failed checks', async () => {
    await executeWith({
      ok: false,
      reason: 'GUARDRAIL_BLOCKED',
      detail: 'one or more guardrails failed',
      status: 200,
      failedChecks: [
        { name: 'dailyNotional', ok: false, detail: 'over the daily cap' },
        { name: 'fundsSufficient', ok: false, detail: 'not enough margin' },
      ],
    });

    expect(screen.getByTestId('execute-GUARDRAIL_BLOCKED')).toBeTruthy();
    expect(screen.getByTestId('failed-checks')).toBeTruthy();
    expect(screen.getByText('over the daily cap')).toBeTruthy();
    expect(screen.getByText('not enough margin')).toBeTruthy();
  });

  it('offers refresh-and-retry on PRICE_MOVED', async () => {
    await executeWith({
      ok: false,
      reason: 'PRICE_MOVED',
      detail: 'price moved 3.1% (you saw ₹1500, live ₹1546)',
      status: 409,
    });

    expect(screen.getByTestId('execute-PRICE_MOVED')).toBeTruthy();
    expect(screen.getByTestId('execute-PRICE_MOVED-action')).toHaveTextContent(/Refresh quote/);

    await fireEvent.press(screen.getByTestId('execute-PRICE_MOVED-action'));
    await act(async () => undefined);

    // Back to the start of the gesture: the banner is gone and the biometric
    // must be re-done before anything can be sent again.
    expect(screen.queryByTestId('execute-PRICE_MOVED')).toBeNull();
    expect(screen.getByTestId('approve-button')).toBeTruthy();
  });

  it('treats IDEMPOTENT_REPLAY as a success, not a second chance', async () => {
    await executeWith({
      ok: false,
      reason: 'IDEMPOTENT_REPLAY',
      detail: 'this key was already used',
      status: 409,
    });

    expect(screen.getByTestId('execute-IDEMPOTENT_REPLAY')).toHaveTextContent(/already used/);
    expect(screen.getByTestId('execute-IDEMPOTENT_REPLAY')).toHaveTextContent(/Already submitted/);
    // No approve control at all — the screen is in its terminal state, so the
    // order cannot be placed a second time by tapping again.
    expect(screen.queryByTestId('approve-button')).toBeNull();
    expect(screen.queryByTestId('confirm-slider')).toBeNull();
  });

  // Every reason gets its own title and carries the backend's own detail
  // through. Nothing renders as a bare "something went wrong".
  it.each([
    ['UNAUTHORIZED', 401, 'Not your proposal'],
    ['STALE_PROPOSAL', 409, 'Proposal expired'],
    ['HALTED', 423, 'Trading halted'],
    ['MARKET_CLOSED', 409, 'Market closed'],
    ['SESSION_INVALID', 409, 'Broker session invalid'],
    ['BUDGET_EXCEEDED', 200, 'Book budget exceeded'],
    ['OWNERSHIP', 200, 'Not owned by this book'],
    ['BROKER_ERROR', 502, 'Broker error'],
  ])('renders %s meaningfully', async (reason, status, title) => {
    await executeWith({ ok: false, reason, detail: `backend said: ${reason}`, status });
    expect(screen.getByTestId(`execute-${reason}`)).toBeTruthy();
    expect(screen.getByTestId(`execute-${reason}`)).toHaveTextContent(
      new RegExp(`backend said: ${reason}`),
    );
    expect(screen.getByTestId(`execute-${reason}`)).toHaveTextContent(new RegExp(title));
  });

  it('surfaces a transport failure too', async () => {
    await executeWith({ ok: false, reason: 'TIMEOUT', detail: 'no answer in time', status: 0 });
    expect(screen.getByTestId('execute-TIMEOUT')).toHaveTextContent(
      /Check Orders before approving again/,
    );
  });
});

describe('reject from the detail screen', () => {
  it('writes only the three fields the rules permit', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    await renderScreen();

    await fireEvent.press(screen.getByTestId('detail-reject'));
    await act(async () => undefined);

    expect(fs().updates).toEqual([
      {
        path: 'proposals/p1',
        data: { status: 'rejected', decidedBy: 'u1', decidedAt: NOW.toISOString() },
      },
    ]);
  });

  it('shows why a reject failed rather than silently doing nothing', async () => {
    setBackendForTests(backendWith(async () => OK_EXECUTE));
    await renderScreen();
    (globalThis.__firestoreMock as { failNextUpdate(e: Error): void }).failNextUpdate(
      new Error('permission-denied'),
    );

    await fireEvent.press(screen.getByTestId('detail-reject'));
    await act(async () => undefined);
    expect(screen.getByTestId('detail-reject-error')).toBeTruthy();
  });
});

describe('refresh quote', () => {
  it('re-pulls the portfolio on demand', async () => {
    const holdings = jest.fn(async () => ({
      ok: true as const,
      at: NOW.toISOString(),
      holdings: [],
    }));
    setBackendForTests(
      fakeApiClient({
        holdings,
        positions: async () => ({ ok: true, at: NOW.toISOString(), positions: [] }),
        executeProposal: async () => OK_EXECUTE,
      }),
    );
    await renderScreen();
    const before = holdings.mock.calls.length;

    await fireEvent.press(screen.getByTestId('refresh-quote'));
    await act(async () => undefined);
    expect(holdings.mock.calls.length).toBeGreaterThan(before);
  });
});
