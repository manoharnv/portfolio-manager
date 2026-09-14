import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import {
  createBrokerMarketData,
  createBrokerPortfolioSource,
  createBrokerSessionSource,
} from './broker.js';
import {
  INFY,
  RELIANCE,
  TEST_UID,
  dailyCandles,
  fakeReadAdapter,
  fakeReadAdapterState,
  flatBar,
  instrumentMap,
  makeFunds,
  makeHolding,
  makeInstrument,
  makePosition,
  makeQuote,
  makeSession,
  quoteMap,
} from '../test-utils/index.js';

const CANDLES = dailyCandles('2026-01-05T04:00:00.000Z', [flatBar(100), flatBar(101)]);

function adapter(patch: Parameters<typeof fakeReadAdapterState>[0] = {}) {
  return fakeReadAdapter(
    fakeReadAdapterState({
      holdings: [makeHolding()],
      positions: [makePosition()],
      funds: makeFunds({ availableMargin: 123 }),
      quotes: quoteMap([makeQuote({ ltp: 2950 })]),
      candles: new Map([[symbolKey(RELIANCE), CANDLES]]),
      instruments: instrumentMap([makeInstrument()]),
      ...patch,
    }),
  );
}

describe('createBrokerPortfolioSource', () => {
  it('fetches holdings, positions and funds together', async () => {
    const snapshot = await createBrokerPortfolioSource(adapter()).snapshot(TEST_UID);
    expect(snapshot.holdings).toHaveLength(1);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.funds.availableMargin).toBe(123);
  });
});

describe('createBrokerMarketData', () => {
  it('keys quotes by symbolKey', async () => {
    const quotes = await createBrokerMarketData(adapter()).quotes([RELIANCE]);
    expect(quotes.get(symbolKey(RELIANCE))?.ltp).toBe(2950);
  });

  it('omits a symbol the broker has no quote for — the caller must fail closed', async () => {
    const quotes = await createBrokerMarketData(adapter()).quotes([RELIANCE, INFY]);
    expect(quotes.has(symbolKey(INFY))).toBe(false);
  });

  it('does not call the broker for an empty symbol list', async () => {
    expect((await createBrokerMarketData(adapter()).quotes([])).size).toBe(0);
  });

  it('passes historical requests straight through', async () => {
    const candles = await createBrokerMarketData(adapter()).historical({
      symbol: RELIANCE,
      interval: '1d',
      from: '2026-01-05T00:00:00.000Z',
      to: '2026-01-06T00:00:00.000Z',
    });
    expect(candles).toEqual(CANDLES);
  });

  it('resolves an instrument', async () => {
    const instrument = await createBrokerMarketData(adapter()).instrument(RELIANCE);
    expect(instrument?.lotSize).toBe(1);
  });

  it('returns undefined when the instrument master cannot resolve — fail closed', async () => {
    const market = createBrokerMarketData(adapter({ instrumentError: 'master not loaded' }));
    expect(await market.instrument(RELIANCE)).toBeUndefined();
  });

  it('returns undefined for an unknown symbol', async () => {
    expect(await createBrokerMarketData(adapter()).instrument(INFY)).toBeUndefined();
  });
});

describe('createBrokerSessionSource', () => {
  it('reports the adapter’s session for its own broker', async () => {
    const status = await createBrokerSessionSource(adapter()).status(TEST_UID, 'dhan');
    expect(status).toEqual(makeSession());
  });

  it('refuses to answer for a different broker', async () => {
    expect(await createBrokerSessionSource(adapter()).status(TEST_UID, 'kite')).toBeUndefined();
  });

  it('returns undefined when the broker call fails — fail closed', async () => {
    const broken = {
      ...adapter(),
      getSessionStatus: (): Promise<never> => Promise.reject(new Error('network down')),
    };
    expect(await createBrokerSessionSource(broken).status(TEST_UID, 'dhan')).toBeUndefined();
  });
});
