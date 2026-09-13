/**
 * The quote the approval screen collars against. It is not a broker tick: the
 * backend has no quote route, so this is the cached portfolio price plus a
 * forced refresh. What matters is that a STALE price reads as *no* price
 * (docs/00 §0.7.1, docs/06 §6.6).
 */
import { act, renderHook } from '@testing-library/react-native';
import { priceFromCache, symbolKeyOf, useLiveQuote, QUOTE_MAX_AGE_SECONDS } from './useLiveQuote';
import { setBackendForTests } from '../lib/backend';
import { NOW, SYMBOL, SYMBOL_KEY, buildHolding, buildPosition, fakeApiClient } from '../test-utils';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
  setBackendForTests(undefined);
});

const okApi = () =>
  fakeApiClient({
    holdings: async () => ({ ok: true, at: NOW.toISOString(), holdings: [] }),
    positions: async () => ({ ok: true, at: NOW.toISOString(), positions: [] }),
  });

describe('symbolKeyOf', () => {
  it('matches the portfolio document id shape', () => {
    expect(symbolKeyOf(SYMBOL)).toBe(SYMBOL_KEY);
  });
});

describe('priceFromCache', () => {
  it('finds the price in holdings', () => {
    expect(priceFromCache(SYMBOL, [buildHolding()], [])).toEqual({
      ltp: 1500,
      at: NOW.toISOString(),
    });
  });

  it('finds it in positions when there is no holding', () => {
    expect(priceFromCache(SYMBOL, [], [buildPosition()])?.ltp).toBe(1500);
  });

  it('prefers the newest of several sources', () => {
    const older = buildHolding({ lastPrice: 1400, updatedAt: '2026-02-03T04:00:00.000Z' });
    const newer = buildPosition({ lastPrice: 1600, updatedAt: '2026-02-03T05:00:00.000Z' });
    expect(priceFromCache(SYMBOL, [older], [newer])?.ltp).toBe(1600);
  });

  it('ignores a different symbol and a zero price', () => {
    expect(priceFromCache(SYMBOL, [buildHolding({ symbolKey: 'NSE:EQ:TCS' })], [])).toBeUndefined();
    expect(priceFromCache(SYMBOL, [buildHolding({ lastPrice: 0 })], [])).toBeUndefined();
  });
});

describe('useLiveQuote', () => {
  it('serves a fresh cached price and its age', async () => {
    setBackendForTests(okApi());
    const { result } = await renderHook(() =>
      useLiveQuote(SYMBOL, { holdings: [buildHolding()], positions: [] }),
    );
    await act(async () => undefined);

    expect(result.current.ltp).toBe(1500);
    expect(result.current.stale).toBe(false);
    expect(result.current.ageSeconds).toBeCloseTo(0, 0);
  });

  // The gate must not approve against a price nobody can vouch for.
  it('reports no ltp once the cached price is too old, but keeps it for display', async () => {
    setBackendForTests(okApi());
    const stale = buildHolding({
      updatedAt: new Date(NOW.getTime() - (QUOTE_MAX_AGE_SECONDS + 30) * 1000).toISOString(),
    });
    const { result } = await renderHook(() =>
      useLiveQuote(SYMBOL, { holdings: [stale], positions: [] }),
    );
    await act(async () => undefined);

    expect(result.current.ltp).toBeUndefined();
    expect(result.current.cachedLtp).toBe(1500);
    expect(result.current.stale).toBe(true);
  });

  it('treats an unparseable timestamp as stale', async () => {
    setBackendForTests(okApi());
    const { result } = await renderHook(() =>
      useLiveQuote(SYMBOL, {
        holdings: [buildHolding({ updatedAt: '2026-13-45T99:99:99.000Z' })],
        positions: [],
      }),
    );
    await act(async () => undefined);
    expect(result.current.stale).toBe(true);
    expect(result.current.ageSeconds).toBeUndefined();
  });

  it('polls the backend to make it rewrite the cache', async () => {
    const holdings = jest.fn(async () => ({
      ok: true as const,
      at: NOW.toISOString(),
      holdings: [],
    }));
    const positions = jest.fn(async () => ({
      ok: true as const,
      at: NOW.toISOString(),
      positions: [],
    }));
    setBackendForTests(fakeApiClient({ holdings, positions }));

    await renderHook(() =>
      useLiveQuote(SYMBOL, { holdings: [buildHolding()], positions: [], pollMs: 5_000 }),
    );
    await act(async () => undefined);
    expect(holdings).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(holdings).toHaveBeenCalledTimes(2);
    expect(positions).toHaveBeenCalledTimes(2);
  });

  it('does not poll at all when disabled', async () => {
    const holdings = jest.fn();
    setBackendForTests(fakeApiClient({ holdings }));
    await renderHook(() => useLiveQuote(SYMBOL, { holdings: [], positions: [], enabled: false }));
    await act(async () => undefined);
    expect(holdings).not.toHaveBeenCalled();
  });

  it('does nothing without a symbol', async () => {
    const holdings = jest.fn();
    setBackendForTests(fakeApiClient({ holdings }));
    const { result } = await renderHook(() =>
      useLiveQuote(undefined, { holdings: [], positions: [] }),
    );
    await act(async () => result.current.refresh());
    expect(holdings).not.toHaveBeenCalled();
    expect(result.current.ltp).toBeUndefined();
  });

  it('surfaces a refresh failure without throwing', async () => {
    setBackendForTests(
      fakeApiClient({
        holdings: async () => ({ ok: false, reason: 'NETWORK', detail: 'offline', status: 0 }),
        positions: async () => ({ ok: false, reason: 'NETWORK', detail: 'offline', status: 0 }),
      }),
    );
    const { result } = await renderHook(() =>
      useLiveQuote(SYMBOL, { holdings: [buildHolding()], positions: [] }),
    );
    await act(async () => undefined);
    expect(result.current.error).toBe('offline');
    // The cached price is still usable — the backend being down does not make
    // a 10-second-old price wrong.
    expect(result.current.ltp).toBe(1500);
  });
});
