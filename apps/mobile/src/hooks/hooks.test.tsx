/**
 * The domain hooks, driven through the mocked `onSnapshot` in jest.setup.js.
 * Each one is checked for the Firestore path it listens on (the rules grant on
 * exactly these paths) and for the decoding it applies.
 */
import { act, renderHook } from '@testing-library/react-native';
import { onSnapshot, where } from 'firebase/firestore';
import { useAuditLog, auditLabel, isAlert } from './useAuditLog';
import { useBooks, visibleBooks, bookHeadroomInr, VISIBLE_BOOKS } from './useBooks';
import { useBrokerSessionDocs, mergeBrokerViews, useBackendSession } from './useBrokerSessions';
import { useConfig, stripImmutable, guardrailsOf } from './useConfig';
import { useOrder, useOrders, isCancellable } from './useOrders';
import { usePendingProposals, useProposal } from './useProposals';
import { usePortfolio, summarise } from './usePortfolio';
import { useUserPrefs, DEFAULT_PREFS } from './useUserPrefs';
import { useSession } from './useSession';
import { setBackendForTests } from '../lib/backend';
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
} from '../test-utils';

const fs = () => globalThis.__firestoreMock;
const authMock = () => globalThis.__authMock;

afterEach(() => setBackendForTests(undefined));

function listenedPath(): string {
  const call = (onSnapshot as jest.Mock).mock.calls.at(-1);
  return (call?.[0] as { path: string }).path;
}

describe('useProposals', () => {
  it('subscribes to `proposals` filtered to the signed-in uid and pending status', async () => {
    const { result } = await renderHook(() => usePendingProposals('u1'));
    expect(listenedPath()).toBe('proposals');
    expect(where).toHaveBeenCalledWith('uid', '==', 'u1');
    expect(where).toHaveBeenCalledWith('status', '==', 'pending');

    await act(() =>
      fs().emitCollection('proposals', [{ id: 'p1', data: buildProposal({ id: 'p1' }) }]),
    );
    expect(result.current.data).toHaveLength(1);
  });

  it('subscribes to nothing without a uid', async () => {
    const { result } = await renderHook(() => usePendingProposals(undefined));
    expect(result.current.loading).toBe(false);
  });

  it('reads one proposal by id', async () => {
    const { result } = await renderHook(() => useProposal('p9'));
    expect(listenedPath()).toBe('proposals/p9');
    await act(() => fs().emitDoc('proposals/p9', buildProposal({ id: 'p9' })));
    expect(result.current.data?.id).toBe('p9');
  });

  it('reads nothing without an id', async () => {
    const { result } = await renderHook(() => useProposal(undefined));
    expect(result.current.loading).toBe(false);
  });
});

describe('useOrders', () => {
  it('subscribes to `orders` for the uid and decodes records', async () => {
    const { result } = await renderHook(() => useOrders('u1'));
    expect(listenedPath()).toBe('orders');
    await act(() => fs().emitCollection('orders', [{ id: 'o1', data: buildOrder() }]));
    expect(result.current.data[0]?.brokerOrderId).toBe('BRK-1');
  });

  it('reads one order by id', async () => {
    await renderHook(() => useOrder('o5'));
    expect(listenedPath()).toBe('orders/o5');
  });

  it('knows which statuses the broker can still act on', () => {
    expect(isCancellable(buildOrder({ status: 'OPEN' }))).toBe(true);
    expect(isCancellable(buildOrder({ status: 'PARTIAL' }))).toBe(true);
    expect(isCancellable(buildOrder({ status: 'COMPLETE' }))).toBe(false);
    expect(isCancellable(buildOrder({ status: 'REJECTED' }))).toBe(false);
  });
});

describe('useConfig', () => {
  it('listens on config/{uid} and clamps the effective copy to the code ceilings', async () => {
    const { result } = await renderHook(() => useConfig('u1'));
    expect(listenedPath()).toBe('config/u1');

    await act(() =>
      fs().emitDoc(
        'config/u1',
        buildConfig({
          guardrails: { ...buildConfig().guardrails, maxOrderValueInr: 10_000_000 },
        }),
      ),
    );

    expect(result.current.data?.guardrails.maxOrderValueInr).toBe(10_000_000);
    expect(result.current.effective?.guardrails.maxOrderValueInr).toBe(500_000);
  });

  it('refuses to send environment, activeBroker or uid in an update', async () => {
    const { result } = await renderHook(() => useConfig('u1'));
    await act(() => fs().emitDoc('config/u1', buildConfig()));

    await act(() =>
      result.current.update(
        {
          killSwitch: true,
          environment: 'prod',
          activeBroker: 'dhan',
          uid: 'someone-else',
        } as never,
        NOW,
      ),
    );

    expect(fs().updates).toEqual([
      { path: 'config/u1', data: { killSwitch: true, updatedAt: NOW.toISOString() } },
    ]);
  });

  it('throws rather than writing when there is no uid', async () => {
    const { result } = await renderHook(() => useConfig(undefined));
    await expect(result.current.update({ killSwitch: true }, NOW)).rejects.toThrow('not signed in');
  });

  it('strips immutable fields as a pure function too', () => {
    expect(stripImmutable({ uid: 'x', environment: 'prod', killSwitch: true })).toEqual({
      killSwitch: true,
    });
  });

  it('exposes the guardrails block', () => {
    expect(guardrailsOf(buildConfig())?.priceCollarPct).toBe(1);
    expect(guardrailsOf(undefined)).toBeUndefined();
  });
});

describe('useBooks', () => {
  it('listens on books/{uid}/books', async () => {
    const { result } = await renderHook(() => useBooks('u1'));
    expect(listenedPath()).toBe('books/u1/books');
    await act(() => fs().emitCollection('books/u1/books', [{ id: 'swing', data: buildBook() }]));
    expect(result.current.data[0]?.label).toBe('Swing');
  });

  // docs/10 §10.1/§10.7 — scalp cannot wait for a biometric tap.
  it('hides the scalp book and orders the rest by horizon', () => {
    const books = [
      buildBook({ id: 'scalp', label: 'Scalp' }),
      buildBook({ id: 'day_trade', label: 'Day' }),
      buildBook({ id: 'long_term', label: 'Long' }),
    ];
    expect(visibleBooks(books).map((b) => b.id)).toEqual(['long_term', 'day_trade']);
    expect(VISIBLE_BOOKS).not.toContain('scalp');
  });

  it('reports headroom from @pm/core, not its own arithmetic', () => {
    expect(bookHeadroomInr(buildBook())).toBe(180_000);
  });
});

describe('broker sessions', () => {
  it('listens on brokerSessions/{uid}/brokers', async () => {
    await renderHook(() => useBrokerSessionDocs('u1'));
    expect(listenedPath()).toBe('brokerSessions/u1/brokers');
  });

  it('merges the Firestore mirror with the backend grade', () => {
    const views = mergeBrokerViews([buildBrokerSession()], buildSessionPayload());
    const kite = views.find((v) => v.broker === 'kite');
    expect(kite).toMatchObject({ connected: true, needsLogin: false, isActive: true });
    expect(kite?.lastConnectedAt).toBeDefined();
  });

  // docs/00 §0.7.1 — with no live grade, assume a login is needed.
  it('fails closed when the backend has not graded a session', () => {
    const views = mergeBrokerViews([buildBrokerSession()], undefined);
    expect(views.every((v) => v.needsLogin)).toBe(true);
    expect(views[0]?.reason).toContain('not graded');
  });

  it('polls GET /v1/session and marks the backend reachable', async () => {
    setBackendForTests(
      fakeApiClient({ session: async () => ({ ok: true, ...buildSessionPayload() }) }),
    );
    const { result } = await renderHook(() => useBackendSession('u1', 60_000));
    await act(async () => undefined);

    expect(result.current.reachable).toBe(true);
    expect(result.current.session?.activeBroker).toBe('kite');
  });

  it('marks the backend UNREACHABLE on a transport failure', async () => {
    setBackendForTests(
      fakeApiClient({
        session: async () => ({ ok: false, reason: 'NETWORK', detail: 'offline', status: 0 }),
      }),
    );
    const { result } = await renderHook(() => useBackendSession('u1', 60_000));
    await act(async () => undefined);

    expect(result.current.reachable).toBe(false);
    expect(result.current.error).toContain('Backend unreachable');
  });

  it('keeps the backend "up" when it answers with a protocol refusal', async () => {
    setBackendForTests(
      fakeApiClient({
        session: async () => ({
          ok: false,
          reason: 'RATE_LIMITED',
          detail: 'slow down',
          status: 429,
        }),
      }),
    );
    const { result } = await renderHook(() => useBackendSession('u1', 60_000));
    await act(async () => undefined);

    expect(result.current.reachable).toBe(true);
    expect(result.current.error).toContain('Too many requests');
  });

  it('does nothing without a uid', async () => {
    const { result } = await renderHook(() => useBackendSession(undefined, 60_000));
    expect(result.current.loading).toBe(false);
    await expect(result.current.refresh()).resolves.toBeUndefined();
  });
});

describe('usePortfolio', () => {
  it('listens on all three portfolio paths and summarises them', async () => {
    const { result } = await renderHook(() => usePortfolio('u1'));

    await act(() => {
      fs().emitCollection('portfolio/u1/holdings', [{ id: 'k', data: buildHolding() }]);
      fs().emitCollection('portfolio/u1/positions', [{ id: 'k', data: buildPosition() }]);
      fs().emitDoc('portfolio/u1/funds/current', buildFunds());
    });

    expect(result.current.summary.marketValueInr).toBe(25 * 1500);
    expect(result.current.summary.dayPnlInr).toBe(150);
    expect(result.current.funds.data?.availableCash).toBe(250_000);
    expect(result.current.loading).toBe(false);
  });

  it('summarises an empty portfolio to zeroes, not NaN', () => {
    const summary = summarise([], [], undefined);
    expect(summary).toMatchObject({
      marketValueInr: 0,
      costBasisInr: 0,
      unrealisedPnlInr: 0,
      dayPnlInr: 0,
      holdingsCount: 0,
    });
    expect(summary.updatedAt).toBeUndefined();
  });

  it('reports the newest updatedAt across the slices', () => {
    const older = buildHolding({ updatedAt: '2026-02-03T04:00:00.000Z' });
    const newer = buildPosition({ updatedAt: '2026-02-03T06:00:00.000Z' });
    expect(summarise([older], [newer], undefined).updatedAt).toBe('2026-02-03T06:00:00.000Z');
  });
});

describe('useAuditLog', () => {
  it('listens on auditLog for the uid', async () => {
    const { result } = await renderHook(() => useAuditLog('u1'));
    expect(listenedPath()).toBe('auditLog');
    await act(() => fs().emitCollection('auditLog', [{ id: 'a1', data: buildAuditEvent() }]));
    expect(result.current.data).toHaveLength(1);
  });

  it('labels every audit type and flags the alarming ones', () => {
    expect(auditLabel('guardrail.blocked')).toBe('Guardrail blocked');
    expect(auditLabel('something.new')).toBe('something.new');
    expect(isAlert(buildAuditEvent({ type: 'guardrail.blocked' }))).toBe(true);
    expect(isAlert(buildAuditEvent({ type: 'proposal.created' }))).toBe(false);
  });
});

describe('useUserPrefs', () => {
  it('defaults every preference to on and merges what is stored', async () => {
    const { result } = await renderHook(() => useUserPrefs('u1'));
    expect(result.current.prefs).toEqual(DEFAULT_PREFS);

    await act(() => fs().emitDoc('users/u1', { prefs: { fills: false } }));
    expect(result.current.prefs.fills).toBe(false);
    expect(result.current.prefs.proposals).toBe(true);
  });

  it('writes only the prefs field — the rules reject anything else', async () => {
    const { result } = await renderHook(() => useUserPrefs('u1'));
    await act(() => fs().emitDoc('users/u1', { prefs: {} }));
    await act(() => result.current.setPref('blocks', false));

    expect(fs().updates).toHaveLength(1);
    expect(Object.keys(fs().updates[0]!.data)).toEqual(['prefs']);
    expect(fs().updates[0]!.data).toEqual({ prefs: { ...DEFAULT_PREFS, blocks: false } });
  });

  it('throws rather than writing with no uid', async () => {
    const { result } = await renderHook(() => useUserPrefs(undefined));
    await expect(result.current.setPref('fills', false)).rejects.toThrow('not signed in');
  });
});

describe('useSession', () => {
  it('reports the signed-in user once Firebase restores auth', async () => {
    const { result } = await renderHook(() => useSession());
    expect(result.current.ready).toBe(true);
    expect(result.current.uid).toBeUndefined();

    await act(() => authMock().setUser({ uid: 'u1', email: 'a@b.c' }));
    expect(result.current.uid).toBe('u1');
  });
});
