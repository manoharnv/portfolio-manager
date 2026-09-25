/**
 * The quote the approval screen collars against, now `GET /v1/quotes`.
 *
 * The rules that matter: poll only while focused, a STALE quote is *no* quote,
 * and a failed fetch never refreshes the price (docs/00 §0.7.1, docs/06 §6.6).
 */
import { act, renderHook } from '@testing-library/react-native';
import type { CanonicalSymbol, Quote } from '@pm/core';
import {
  matchQuote,
  quoteAgeSeconds,
  symbolKeyOf,
  useLiveQuote,
  QUOTE_MAX_AGE_SECONDS,
} from './useLiveQuote';
import { setBackendForTests } from '../lib/backend';
import { NOW, SYMBOL, SYMBOL_KEY, fakeApiClient } from '../test-utils';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  jest.useRealTimers();
  setBackendForTests(undefined);
});

function buildQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: { ...SYMBOL },
    ltp: 1500,
    open: 1490,
    high: 1510,
    low: 1480,
    close: 1495,
    volume: 120_000,
    ts: NOW.toISOString(),
    ...overrides,
  };
}

const quotesOk = (quote = buildQuote()) =>
  jest.fn(async () => ({ ok: true as const, quotes: [quote] }));

describe('symbolKeyOf / matchQuote / quoteAgeSeconds', () => {
  it('builds the backend symbol key', () => {
    expect(symbolKeyOf(SYMBOL)).toBe(SYMBOL_KEY);
  });

  it('picks the matching quote out of a batch and ignores a zero price', () => {
    const other = buildQuote({
      symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'TCS' },
      ltp: 3900,
    });
    expect(matchQuote(SYMBOL, [other, buildQuote()])?.ltp).toBe(1500);
    expect(matchQuote(SYMBOL, [other])).toBeUndefined();
    expect(matchQuote(SYMBOL, [buildQuote({ ltp: 0 })])).toBeUndefined();
  });

  it('ages a quote from its own ts and refuses an unparseable one', () => {
    expect(quoteAgeSeconds(buildQuote(), NOW.getTime() + 12_000)).toBe(12);
    expect(quoteAgeSeconds(buildQuote({ ts: 'nonsense' }), NOW.getTime())).toBeUndefined();
  });
});

describe('useLiveQuote', () => {
  it('fetches the symbol on mount and serves a fresh price', async () => {
    const quotes = quotesOk();
    setBackendForTests(fakeApiClient({ quotes }));

    const { result } = await renderHook(() => useLiveQuote(SYMBOL));
    await act(async () => undefined);

    expect(quotes).toHaveBeenCalledWith([SYMBOL_KEY]);
    expect(result.current.ltp).toBe(1500);
    expect(result.current.quote?.high).toBe(1510);
    expect(result.current.stale).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  // A symbol the account does not hold now quotes fine — this is the whole
  // point of moving off the portfolio cache.
  it('quotes a symbol that is not in the portfolio at all', async () => {
    const unheld = { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'WIPRO' } as const;
    setBackendForTests(
      fakeApiClient({
        quotes: async () => ({
          ok: true,
          quotes: [buildQuote({ symbol: { ...unheld }, ltp: 250 })],
        }),
      }),
    );

    const { result } = await renderHook(() => useLiveQuote(unheld));
    await act(async () => undefined);
    expect(result.current.ltp).toBe(250);
  });

  it('polls every 5 s by default while enabled', async () => {
    const quotes = quotesOk();
    setBackendForTests(fakeApiClient({ quotes }));

    await renderHook(() => useLiveQuote(SYMBOL));
    await act(async () => undefined);
    expect(quotes).toHaveBeenCalledTimes(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(quotes).toHaveBeenCalledTimes(2);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(quotes).toHaveBeenCalledTimes(4);
  });

  it('stops polling on blur and resumes on focus', async () => {
    const quotes = quotesOk();
    setBackendForTests(fakeApiClient({ quotes }));

    const { rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) => useLiveQuote(SYMBOL, { enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => undefined);
    expect(quotes).toHaveBeenCalledTimes(1);

    await rerender({ enabled: false });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(quotes).toHaveBeenCalledTimes(1); // blurred: nothing fired

    await rerender({ enabled: true });
    await act(async () => undefined);
    expect(quotes).toHaveBeenCalledTimes(2);
  });

  it('never polls without a symbol', async () => {
    const quotes = jest.fn();
    setBackendForTests(fakeApiClient({ quotes }));
    const { result } = await renderHook(() => useLiveQuote(undefined));
    await act(async () => result.current.refresh());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_000);
    });
    expect(quotes).not.toHaveBeenCalled();
    expect(result.current.ltp).toBeUndefined();
  });

  it('turns a quote older than 30 s into NO price, keeping it for display', async () => {
    setBackendForTests(
      fakeApiClient({
        quotes: async () => ({
          ok: true,
          quotes: [
            buildQuote({
              ts: new Date(NOW.getTime() - (QUOTE_MAX_AGE_SECONDS + 5) * 1000).toISOString(),
            }),
          ],
        }),
      }),
    );

    const { result } = await renderHook(() => useLiveQuote(SYMBOL));
    await act(async () => undefined);

    expect(result.current.ltp).toBeUndefined();
    expect(result.current.cachedLtp).toBe(1500);
    expect(result.current.stale).toBe(true);
  });

  it('goes stale on its own when the backend stops answering', async () => {
    let fail = false;
    setBackendForTests(
      fakeApiClient({
        quotes: async () =>
          fail
            ? { ok: false, reason: 'NETWORK', detail: 'offline', status: 0 }
            : { ok: true, quotes: [buildQuote()] },
      }),
    );

    const { result } = await renderHook(() => useLiveQuote(SYMBOL));
    await act(async () => undefined);
    expect(result.current.ltp).toBe(1500);

    fail = true;
    await act(async () => {
      await jest.advanceTimersByTimeAsync((QUOTE_MAX_AGE_SECONDS + 2) * 1000);
    });

    // The last good quote aged out; the failure did not refresh it.
    expect(result.current.ltp).toBeUndefined();
    expect(result.current.cachedLtp).toBe(1500);
    expect(result.current.error).toContain('Backend unreachable');
  });

  it('reports a broker failure with its kind', async () => {
    setBackendForTests(
      fakeApiClient({
        quotes: async () => ({
          ok: false,
          reason: 'BROKER_ERROR',
          detail: 'upstream quote feed down',
          status: 502,
          brokerErrorKind: 'RATE_LIMITED',
        }),
      }),
    );
    const { result } = await renderHook(() => useLiveQuote(SYMBOL));
    await act(async () => undefined);
    expect(result.current.error).toContain('upstream quote feed down');
    expect(result.current.ltp).toBeUndefined();
  });

  it('says so when the batch comes back without this symbol', async () => {
    setBackendForTests(fakeApiClient({ quotes: async () => ({ ok: true, quotes: [] }) }));
    const { result } = await renderHook(() => useLiveQuote(SYMBOL));
    await act(async () => undefined);
    expect(result.current.error).toContain('no quote for this symbol');
    expect(result.current.ltp).toBeUndefined();
  });

  it('drops the previous symbol’s price when the symbol changes', async () => {
    setBackendForTests(
      fakeApiClient({
        quotes: async (keys) => ({
          ok: true,
          quotes: keys[0] === SYMBOL_KEY ? [buildQuote()] : [],
        }),
      }),
    );

    const { result, rerender } = await renderHook(
      ({ symbol }: { symbol: CanonicalSymbol }) => useLiveQuote(symbol),
      { initialProps: { symbol: { ...SYMBOL } as CanonicalSymbol } },
    );
    await act(async () => undefined);
    expect(result.current.ltp).toBe(1500);

    await rerender({ symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'TCS' } });
    await act(async () => undefined);
    expect(result.current.ltp).toBeUndefined();
    expect(result.current.cachedLtp).toBeUndefined();
  });

  it('refreshes on demand', async () => {
    const quotes = quotesOk();
    setBackendForTests(fakeApiClient({ quotes }));
    const { result } = await renderHook(() => useLiveQuote(SYMBOL, { enabled: false }));

    expect(quotes).not.toHaveBeenCalled();
    await act(async () => result.current.refresh());
    expect(quotes).toHaveBeenCalledTimes(1);
    expect(result.current.ltp).toBe(1500);
  });
});
