import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARGIN_HEADROOM_PCT,
  DEFAULT_SQUARE_OFF_BUFFER_MINUTES,
  assessPortfolioRisk,
  type RiskControlName,
  type RiskInput,
} from './risk.js';
import { HORIZONS } from './schemas.js';
import { MARKET_OPEN_NOW, makeBook, makeConfig } from './test-utils.js';

const REL = 'NSE:EQ:RELIANCE';
const INF = 'NSE:EQ:INFY';

const BOOKS = [
  makeBook({ id: 'long_term', allocationPct: 50, risk: { dailyLossStopInr: 20_000 } }),
  makeBook({ id: 'swing', allocationPct: 30, risk: { dailyLossStopInr: 10_000 } }),
  makeBook({
    id: 'day_trade',
    allocationPct: 15,
    product: 'INTRADAY',
    risk: { dailyLossStopInr: 5_000 },
  }),
  makeBook({
    id: 'scalp',
    allocationPct: 5,
    product: 'INTRADAY',
    risk: { dailyLossStopInr: 2_000 },
  }),
];

function input(patch?: Partial<RiskInput>): RiskInput {
  return {
    config: makeConfig(),
    books: BOOKS,
    limits: {
      portfolioDailyLossStopInr: 50_000,
      maxGrossExposureInr: 800_000,
      maxSymbolConcentrationPct: 25,
    },
    bookDayPnlInr: {},
    portfolioDayPnlInr: 0,
    grossExposureInr: 200_000,
    exposureBySymbolInr: {},
    availableMarginInr: 500_000,
    requiredIntradayMarginInr: 100_000,
    openIntradayPositions: [],
    now: MARKET_OPEN_NOW,
    ...patch,
  };
}

const at = (result: ReturnType<typeof assessPortfolioRisk>, name: RiskControlName) => {
  const found = result.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no risk control named ${name}`);
  return found;
};

describe('a healthy portfolio', () => {
  it('trips nothing', () => {
    const result = assessPortfolioRisk(input());
    expect(result.ok).toBe(true);
    expect(result.tripKillSwitch).toBe(false);
    expect(result.pauseBooks).toEqual([]);
    expect(result.blockNewExposure).toBe(false);
    expect(result.blockedSymbols).toEqual([]);
    expect(result.throttleBooks).toEqual([]);
    expect(result.squareOffDue).toEqual([]);
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it('exposes the documented defaults', () => {
    expect(DEFAULT_SQUARE_OFF_BUFFER_MINUTES).toBe(15);
    expect(DEFAULT_MARGIN_HEADROOM_PCT).toBe(20);
  });
});

describe('portfolio daily-loss stop', () => {
  it('does not trip one rupee short of the stop', () => {
    const result = assessPortfolioRisk(input({ portfolioDayPnlInr: -49_999 }));
    expect(result.tripKillSwitch).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('trips exactly at the stop and flips the kill switch', () => {
    const result = assessPortfolioRisk(input({ portfolioDayPnlInr: -50_000 }));
    expect(result.tripKillSwitch).toBe(true);
    expect(result.ok).toBe(false);
    expect(at(result, 'portfolioDailyLossStop').ok).toBe(false);
    expect(at(result, 'portfolioDailyLossStop').detail).toContain('KILL SWITCH');
  });

  it('trips beyond the stop', () => {
    expect(assessPortfolioRisk(input({ portfolioDayPnlInr: -80_000 })).tripKillSwitch).toBe(true);
  });

  it('never trips on a profit, or with the stop disabled', () => {
    expect(assessPortfolioRisk(input({ portfolioDayPnlInr: 100_000 })).tripKillSwitch).toBe(false);
    expect(
      assessPortfolioRisk(
        input({
          portfolioDayPnlInr: -1_000_000,
          limits: {
            portfolioDailyLossStopInr: 0,
            maxGrossExposureInr: 800_000,
            maxSymbolConcentrationPct: 25,
          },
        }),
      ).tripKillSwitch,
    ).toBe(false);
  });
});

describe('per-book daily-loss stop', () => {
  it('pauses only the book that breached, at its own boundary', () => {
    const result = assessPortfolioRisk(
      input({ bookDayPnlInr: { swing: -10_000, long_term: -19_999, day_trade: -100 } }),
    );
    expect(result.pauseBooks).toEqual(['swing']);
    expect(result.tripKillSwitch).toBe(false);
    expect(result.ok).toBe(false);
    expect(at(result, 'bookDailyLossStop').detail).toContain('books paused for the day: swing');
  });

  it('pauses several books at once', () => {
    expect(
      assessPortfolioRisk(input({ bookDayPnlInr: { swing: -12_000, scalp: -3_000 } })).pauseBooks,
    ).toEqual(['swing', 'scalp']);
  });

  it('ignores books with no P&L recorded', () => {
    expect(assessPortfolioRisk(input({ bookDayPnlInr: {} })).pauseBooks).toEqual([]);
  });
});

describe('gross exposure cap', () => {
  it('passes below the cap and blocks at it', () => {
    expect(assessPortfolioRisk(input({ grossExposureInr: 799_999 })).blockNewExposure).toBe(false);
    const result = assessPortfolioRisk(input({ grossExposureInr: 800_000 }));
    expect(result.blockNewExposure).toBe(true);
    expect(result.ok).toBe(false);
    expect(at(result, 'grossExposureCap').detail).toContain('cap ₹800000');
  });
});

describe('per-symbol concentration cap', () => {
  it('flags only the names at or over the cap', () => {
    // Basis is totalManagedCapitalInr = ₹10,00,000; cap 25% = ₹2,50,000.
    const result = assessPortfolioRisk(
      input({ exposureBySymbolInr: { [REL]: 250_000, [INF]: 249_999 } }),
    );
    expect(result.blockedSymbols).toEqual([REL]);
    expect(result.ok).toBe(false);
    expect(at(result, 'symbolConcentrationCap').detail).toContain(REL);
  });

  it('ignores zero or negative exposure', () => {
    expect(
      assessPortfolioRisk(input({ exposureBySymbolInr: { [REL]: 0, [INF]: -5 } })).blockedSymbols,
    ).toEqual([]);
  });

  it('fails closed when there is no capital basis to measure against', () => {
    const result = assessPortfolioRisk(
      input({
        config: makeConfig({ totalManagedCapitalInr: 0 }),
        exposureBySymbolInr: { [REL]: 1 },
      }),
    );
    expect(result.blockedSymbols).toEqual([REL]);
  });
});

describe('margin headroom throttle', () => {
  it('is quiet while headroom is comfortable', () => {
    const result = assessPortfolioRisk(
      input({ availableMarginInr: 500_000, requiredIntradayMarginInr: 100_000 }),
    );
    expect(result.throttleBooks).toEqual([]);
    expect(at(result, 'marginHeadroom').ok).toBe(true);
  });

  it('throttles intraday books first, scalp before day_trade, at the boundary', () => {
    // (500000 − 400000) / 500000 = 20% — exactly the floor.
    const result = assessPortfolioRisk(
      input({ availableMarginInr: 500_000, requiredIntradayMarginInr: 400_000 }),
    );
    expect(result.throttleBooks).toEqual(['scalp', 'day_trade']);
    expect(at(result, 'marginHeadroom').ok).toBe(false);
    expect(at(result, 'marginHeadroom').detail).toContain('throttle scalp, day_trade');
    // Throttling is advisory: it does not by itself make the assessment not-ok.
    expect(result.ok).toBe(true);
  });

  it('treats zero available margin as no headroom', () => {
    expect(
      assessPortfolioRisk(input({ availableMarginInr: 0, requiredIntradayMarginInr: 0 }))
        .throttleBooks,
    ).toEqual(['scalp', 'day_trade']);
  });

  it('skips disabled books', () => {
    const result = assessPortfolioRisk(
      input({
        books: BOOKS.map((b) => (b.id === 'scalp' ? { ...b, enabled: false } : b)),
        availableMarginInr: 100_000,
        requiredIntradayMarginInr: 95_000,
      }),
    );
    expect(result.throttleBooks).toEqual(['day_trade']);
  });

  it('honours a custom headroom floor and the configured precedence', () => {
    const result = assessPortfolioRisk(
      input({
        config: makeConfig({
          coordinator: { nettingEnabled: false, washWindowSeconds: 60, precedence: [...HORIZONS] },
        }),
        limits: {
          portfolioDailyLossStopInr: 50_000,
          maxGrossExposureInr: 800_000,
          maxSymbolConcentrationPct: 25,
          marginHeadroomPct: 90,
        },
      }),
    );
    expect(result.throttleBooks).toEqual(['scalp', 'day_trade']);
  });
});

describe('intraday square-off guard', () => {
  const open = [
    { bookId: 'day_trade', symbolKey: REL, product: 'INTRADAY' as const, qty: 20 },
    { bookId: 'long_term', symbolKey: INF, product: 'DELIVERY' as const, qty: 100 },
    { bookId: 'scalp', symbolKey: REL, product: 'INTRADAY' as const, qty: 0 },
  ];

  it('stays quiet well before the close', () => {
    // 10:00 IST — 330 minutes to go.
    const result = assessPortfolioRisk(input({ openIntradayPositions: open }));
    expect(result.squareOffDue).toEqual([]);
    expect(at(result, 'intradaySquareOff').detail).toContain('330 min to close');
  });

  it('flags MIS positions once inside the buffer (15:15 IST)', () => {
    const result = assessPortfolioRisk(
      input({ now: '2026-01-13T09:45:00.000Z', openIntradayPositions: open }),
    );
    expect(result.squareOffDue).toHaveLength(1);
    expect(result.squareOffDue[0]).toMatchObject({ bookId: 'day_trade', minutesToClose: 15 });
    expect(at(result, 'intradaySquareOff').ok).toBe(false);
  });

  it('does not flag one minute earlier (15:14 IST)', () => {
    expect(
      assessPortfolioRisk(input({ now: '2026-01-13T09:44:00.000Z', openIntradayPositions: open }))
        .squareOffDue,
    ).toEqual([]);
  });

  it('stops flagging after the close', () => {
    expect(
      assessPortfolioRisk(input({ now: '2026-01-13T10:01:00.000Z', openIntradayPositions: open }))
        .squareOffDue,
    ).toEqual([]);
  });

  it('honours a custom buffer', () => {
    const result = assessPortfolioRisk(
      input({
        now: '2026-01-13T09:30:00.000Z', // 15:00 IST, 30 min to close
        openIntradayPositions: open,
        limits: {
          portfolioDailyLossStopInr: 50_000,
          maxGrossExposureInr: 800_000,
          maxSymbolConcentrationPct: 25,
          squareOffBufferMinutes: 30,
        },
      }),
    );
    expect(result.squareOffDue).toHaveLength(1);
    expect(result.squareOffDue[0]?.minutesToClose).toBe(30);
  });

  it('handles a missing position list', () => {
    expect(
      assessPortfolioRisk(
        input({ now: '2026-01-13T09:45:00.000Z', openIntradayPositions: undefined }),
      ).squareOffDue,
    ).toEqual([]);
  });
});

describe('several controls at once', () => {
  it('reports every breach together', () => {
    const result = assessPortfolioRisk(
      input({
        portfolioDayPnlInr: -60_000,
        bookDayPnlInr: { scalp: -5_000 },
        grossExposureInr: 900_000,
        exposureBySymbolInr: { [REL]: 400_000 },
        availableMarginInr: 100_000,
        requiredIntradayMarginInr: 95_000,
        now: '2026-01-13T09:45:00.000Z',
        openIntradayPositions: [{ bookId: 'scalp', symbolKey: REL, product: 'INTRADAY', qty: 10 }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.tripKillSwitch).toBe(true);
    expect(result.pauseBooks).toEqual(['scalp']);
    expect(result.blockNewExposure).toBe(true);
    expect(result.blockedSymbols).toEqual([REL]);
    expect(result.throttleBooks).toEqual(['scalp', 'day_trade']);
    expect(result.squareOffDue).toHaveLength(1);
    expect(result.checks.filter((c) => !c.ok)).toHaveLength(6);
  });
});
