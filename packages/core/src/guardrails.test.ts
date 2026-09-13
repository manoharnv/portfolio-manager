import { describe, expect, it } from 'vitest';
import {
  ABS_MAX_DAILY_NOTIONAL_INR,
  ABS_MAX_ORDERS_PER_DAY,
  ABS_MAX_ORDER_VALUE_INR,
  MARKET_CLOSE_MINUTES_IST,
  MARKET_OPEN_MINUTES_IST,
  SESSION_EXPIRY_MARGIN_SECONDS,
  clampConfigToCeilings,
  estimateOrderNotionalInr,
  estimateRequiredMarginInr,
  failedChecks,
  formatInr,
  isMarketOpen,
  isMultipleOf,
  istDateKey,
  istMinuteOfDay,
  runGuardrails,
  type GuardrailInput,
  type GuardrailName,
  type GuardrailResult,
} from './guardrails.js';
import {
  INFY,
  MARKET_OPEN_NOW,
  makeConfig,
  makeFunds,
  makeInstrument,
  makeOrder,
  makeQuote,
  makeSession,
} from './test-utils.js';

// IST is UTC+5:30, so 04:30Z === 10:00 IST (mid-session on a Tuesday).
const TUESDAY_0915 = '2026-01-13T03:45:00.000Z';
const TUESDAY_0914 = '2026-01-13T03:44:00.000Z';
const TUESDAY_1530 = '2026-01-13T10:00:00.000Z';
const TUESDAY_1531 = '2026-01-13T10:01:00.000Z';
const SATURDAY_1000 = '2026-01-17T04:30:00.000Z';
const SUNDAY_1000 = '2026-01-18T04:30:00.000Z';

function baseInput(patch?: Partial<GuardrailInput>): GuardrailInput {
  return {
    config: makeConfig(),
    order: makeOrder(),
    proposal: { status: 'pending', ttlExpiresAt: '2026-01-13T04:45:00.000Z' },
    quote: makeQuote(),
    funds: makeFunds(),
    instrument: makeInstrument(),
    session: makeSession(),
    today: { orderCount: 0, notionalInr: 0 },
    idempotency: { key: 'idem-1', used: false },
    now: MARKET_OPEN_NOW,
    ...patch,
  };
}

function at(result: GuardrailResult, name: GuardrailName): { ok: boolean; detail: string } {
  const found = result.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no guardrail named ${name}`);
  return { ok: found.ok, detail: found.detail };
}

describe('the suite as a whole', () => {
  it('passes a clean order and reports every check', () => {
    const result = runGuardrails(baseInput());
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(15);
    expect(failedChecks(result)).toEqual([]);
  });

  it('runs every check even after one fails (no short-circuit)', () => {
    const result = runGuardrails(
      baseInput({ config: makeConfig({ killSwitch: true, tradingEnabled: false }) }),
    );
    expect(result.checks).toHaveLength(15);
    expect(failedChecks(result).map((c) => c.name)).toEqual(['killSwitch', 'tradingEnabled']);
    expect(result.passed).toBe(false);
  });

  it('throws on an unparseable "now" rather than guessing', () => {
    expect(() => runGuardrails(baseInput({ now: 'lunchtime' }))).toThrow(TypeError);
  });
});

describe('killSwitch', () => {
  it('passes when off', () => {
    expect(at(runGuardrails(baseInput()), 'killSwitch').ok).toBe(true);
  });
  it('fails when on', () => {
    const c = at(
      runGuardrails(baseInput({ config: makeConfig({ killSwitch: true }) })),
      'killSwitch',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('kill switch is ON');
  });
});

describe('tradingEnabled', () => {
  it('passes when enabled', () => {
    expect(at(runGuardrails(baseInput()), 'tradingEnabled').ok).toBe(true);
  });
  it('fails when disabled', () => {
    expect(
      at(
        runGuardrails(baseInput({ config: makeConfig({ tradingEnabled: false }) })),
        'tradingEnabled',
      ).ok,
    ).toBe(false);
  });
});

describe('marketHours', () => {
  it('opens at 09:15 IST and not at 09:14', () => {
    expect(isMarketOpen(TUESDAY_0914)).toBe(false);
    expect(isMarketOpen(TUESDAY_0915)).toBe(true);
    expect(at(runGuardrails(baseInput({ now: TUESDAY_0914 })), 'marketHours').ok).toBe(false);
    expect(at(runGuardrails(baseInput({ now: TUESDAY_0915 })), 'marketHours').ok).toBe(true);
  });

  it('closes after 15:30 IST', () => {
    expect(isMarketOpen(TUESDAY_1530)).toBe(true);
    expect(isMarketOpen(TUESDAY_1531)).toBe(false);
    expect(at(runGuardrails(baseInput({ now: TUESDAY_1531 })), 'marketHours').detail).toContain(
      'outside 09:15–15:30 IST',
    );
  });

  it('is closed at weekends', () => {
    expect(isMarketOpen(SATURDAY_1000)).toBe(false);
    expect(isMarketOpen(SUNDAY_1000)).toBe(false);
    expect(at(runGuardrails(baseInput({ now: SATURDAY_1000 })), 'marketHours').detail).toContain(
      'weekend',
    );
  });

  it('honours the optional holiday calendar hook', () => {
    const calendar = { holidays: ['2026-01-13'] };
    expect(isMarketOpen(MARKET_OPEN_NOW)).toBe(true);
    expect(isMarketOpen(MARKET_OPEN_NOW, calendar)).toBe(false);
    expect(isMarketOpen(MARKET_OPEN_NOW, { holidays: ['2026-01-14'] })).toBe(true);
    expect(at(runGuardrails(baseInput({ calendar })), 'marketHours').detail).toContain(
      'exchange holiday',
    );
  });

  it('interprets instants in IST, not the host timezone', () => {
    // 04:30Z is 10:00 IST → open, even though 04:30 "looks" pre-market.
    expect(isMarketOpen('2026-01-13T04:30:00.000Z')).toBe(true);
    // 20:00Z is 01:30 IST the next day → closed.
    expect(isMarketOpen('2026-01-13T20:00:00.000Z')).toBe(false);
    // An explicit +05:30 offset is the same instant as its UTC form.
    expect(isMarketOpen('2026-01-13T15:30:00+05:30')).toBe(isMarketOpen(TUESDAY_1530));
    expect(isMarketOpen('2026-01-13T09:14:00+05:30')).toBe(false);
    expect(isMarketOpen(new Date(TUESDAY_0915))).toBe(true);
  });

  it('derives the IST trading date and minute-of-day', () => {
    expect(istDateKey('2026-01-13T20:00:00.000Z')).toBe('2026-01-14');
    expect(istDateKey(TUESDAY_0915)).toBe('2026-01-13');
    expect(istMinuteOfDay(TUESDAY_0915)).toBe(MARKET_OPEN_MINUTES_IST);
    expect(istMinuteOfDay(TUESDAY_1530)).toBe(MARKET_CLOSE_MINUTES_IST);
    expect(MARKET_OPEN_MINUTES_IST).toBe(555);
    expect(MARKET_CLOSE_MINUTES_IST).toBe(930);
  });
});

describe('sessionValid', () => {
  it('passes for a connected, unexpired session on the active broker', () => {
    expect(at(runGuardrails(baseInput()), 'sessionValid').ok).toBe(true);
  });

  it.each([
    ['no session at all', undefined, 'no broker session supplied'],
    ['a disconnected session', makeSession({ connected: false }), 'not connected'],
    ['an IP-rejected session', makeSession({ staticIpOk: false }), 'IP-rejected'],
    ['an unknown expiry', makeSession({ expiresAt: undefined }), 'expiry unknown'],
    ['an unparseable expiry', makeSession({ expiresAt: 'tomorrow' }), 'unparseable'],
    ['the wrong broker', makeSession({ broker: 'kite' }), "activeBroker is 'dhan'"],
  ])('fails for %s', (_label, session, fragment) => {
    const c = at(runGuardrails(baseInput({ session })), 'sessionValid');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(fragment);
  });

  it('refuses a token that dies inside the safety margin', () => {
    const now = MARKET_OPEN_NOW;
    const nearly = new Date(Date.parse(now) + (SESSION_EXPIRY_MARGIN_SECONDS - 1) * 1000);
    const later = new Date(Date.parse(now) + (SESSION_EXPIRY_MARGIN_SECONDS + 1) * 1000);
    expect(
      at(
        runGuardrails(baseInput({ session: makeSession({ expiresAt: nearly.toISOString() }) })),
        'sessionValid',
      ).ok,
    ).toBe(false);
    expect(
      at(
        runGuardrails(baseInput({ session: makeSession({ expiresAt: later.toISOString() }) })),
        'sessionValid',
      ).ok,
    ).toBe(true);
  });

  it('honours a custom expiry margin', () => {
    const expiresAt = new Date(Date.parse(MARKET_OPEN_NOW) + 300_000).toISOString();
    expect(
      at(
        runGuardrails(
          baseInput({ session: makeSession({ expiresAt }), sessionExpiryMarginSeconds: 600 }),
        ),
        'sessionValid',
      ).ok,
    ).toBe(false);
  });
});

describe('proposalFresh', () => {
  it('passes for a pending or approved proposal inside its TTL', () => {
    expect(at(runGuardrails(baseInput()), 'proposalFresh').ok).toBe(true);
    expect(
      at(
        runGuardrails(
          baseInput({ proposal: { status: 'approved', ttlExpiresAt: '2026-01-13T04:45:00.000Z' } }),
        ),
        'proposalFresh',
      ).ok,
    ).toBe(true);
  });

  it.each(['placing', 'placed', 'filled', 'rejected', 'expired', 'failed', 'blocked'] as const)(
    'fails for a proposal in status %s',
    (status) => {
      const c = at(
        runGuardrails(
          baseInput({ proposal: { status, ttlExpiresAt: '2026-01-13T04:45:00.000Z' } }),
        ),
        'proposalFresh',
      );
      expect(c.ok).toBe(false);
      expect(c.detail).toContain('not executable');
    },
  );

  it('expires exactly at ttlExpiresAt (boundary is inclusive of expiry)', () => {
    const ttl = '2026-01-13T04:45:00.000Z';
    const oneMsBefore = new Date(Date.parse(ttl) - 1).toISOString();
    expect(
      at(
        runGuardrails(
          baseInput({ now: oneMsBefore, proposal: { status: 'pending', ttlExpiresAt: ttl } }),
        ),
        'proposalFresh',
      ).ok,
    ).toBe(true);
    const atExpiry = at(
      runGuardrails(baseInput({ now: ttl, proposal: { status: 'pending', ttlExpiresAt: ttl } })),
      'proposalFresh',
    );
    expect(atExpiry.ok).toBe(false);
    expect(atExpiry.detail).toContain('expired');
  });

  it('fails closed with no proposal or an unparseable TTL', () => {
    expect(at(runGuardrails(baseInput({ proposal: undefined })), 'proposalFresh').ok).toBe(false);
    expect(
      at(
        runGuardrails(baseInput({ proposal: { status: 'pending', ttlExpiresAt: 'never' } })),
        'proposalFresh',
      ).ok,
    ).toBe(false);
  });
});

describe('maxOrderValue', () => {
  it('passes under the cap and fails over it', () => {
    expect(at(runGuardrails(baseInput()), 'maxOrderValue').ok).toBe(true);
    const c = at(
      runGuardrails(
        baseInput({
          order: makeOrder({ quantity: 100, limitPrice: 2000 }),
          config: makeConfig({ guardrails: { maxOrderValueInr: 100_000 } }),
        }),
      ),
      'maxOrderValue',
    );
    expect(c.ok).toBe(false);
    // Conservative valuation: 100 × max(limit 2000, live LTP 2950).
    expect(c.detail).toContain('₹295000 > cap ₹100000');
  });

  it('fails closed when no price is known at all', () => {
    const c = at(
      runGuardrails(
        baseInput({
          order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
          quote: undefined,
        }),
      ),
      'maxOrderValue',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('no price available');
  });

  it('prices a MARKET order off the live LTP', () => {
    const c = at(
      runGuardrails(
        baseInput({
          order: makeOrder({ orderType: 'MARKET', limitPrice: undefined, quantity: 10 }),
        }),
      ),
      'maxOrderValue',
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('₹29500');
  });
});

describe('dailyNotional', () => {
  it('passes below the cap', () => {
    expect(
      at(
        runGuardrails(baseInput({ today: { orderCount: 1, notionalInr: 100_000 } })),
        'dailyNotional',
      ).ok,
    ).toBe(true);
  });

  it('fails when today plus this order exceeds the cap', () => {
    const c = at(
      runGuardrails(baseInput({ today: { orderCount: 1, notionalInr: 480_000 } })),
      'dailyNotional',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('> cap ₹500000');
  });

  it('fails closed on a corrupt aggregate', () => {
    expect(
      at(runGuardrails(baseInput({ today: { orderCount: 0, notionalInr: -1 } })), 'dailyNotional')
        .ok,
    ).toBe(false);
    expect(
      at(
        runGuardrails(baseInput({ today: { orderCount: 0, notionalInr: Number.NaN } })),
        'dailyNotional',
      ).ok,
    ).toBe(false);
  });
});

describe('dailyOrderCount', () => {
  it('passes below the cap and fails at it', () => {
    expect(
      at(runGuardrails(baseInput({ today: { orderCount: 9, notionalInr: 0 } })), 'dailyOrderCount')
        .ok,
    ).toBe(true);
    const c = at(
      runGuardrails(baseInput({ today: { orderCount: 10, notionalInr: 0 } })),
      'dailyOrderCount',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('#11 > cap 10');
  });

  it('fails closed on a corrupt count', () => {
    expect(
      at(runGuardrails(baseInput({ today: { orderCount: -1, notionalInr: 0 } })), 'dailyOrderCount')
        .ok,
    ).toBe(false);
    expect(
      at(
        runGuardrails(baseInput({ today: { orderCount: 1.5, notionalInr: 0 } })),
        'dailyOrderCount',
      ).ok,
    ).toBe(false);
  });
});

describe('segmentAllowed', () => {
  it('passes for an allowed segment', () => {
    expect(at(runGuardrails(baseInput()), 'segmentAllowed').ok).toBe(true);
  });
  it('fails for a segment outside the allowlist', () => {
    const c = at(
      runGuardrails(
        baseInput({ config: makeConfig({ guardrails: { allowedSegments: ['FNO'] } }) }),
      ),
      'segmentAllowed',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('segment EQ not in [FNO]');
  });
});

describe('productAllowed', () => {
  it('passes for an allowed product', () => {
    expect(at(runGuardrails(baseInput()), 'productAllowed').ok).toBe(true);
  });
  it('fails for a product outside the allowlist', () => {
    const c = at(
      runGuardrails(baseInput({ order: makeOrder({ product: 'MTF' }) })),
      'productAllowed',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('product MTF not in');
  });
});

describe('symbolAllowBlock', () => {
  it('passes when there is no allowlist and no block', () => {
    const c = at(runGuardrails(baseInput()), 'symbolAllowBlock');
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('no allowlist configured');
  });

  it('blocks a blocklisted trading symbol or full key', () => {
    for (const entry of ['RELIANCE', 'NSE:EQ:RELIANCE']) {
      const c = at(
        runGuardrails(
          baseInput({ config: makeConfig({ guardrails: { symbolBlocklist: [entry] } }) }),
        ),
        'symbolAllowBlock',
      );
      expect(c.ok).toBe(false);
      expect(c.detail).toContain('blocklisted');
    }
  });

  it('enforces an allowlist when one is set', () => {
    expect(
      at(
        runGuardrails(
          baseInput({ config: makeConfig({ guardrails: { symbolAllowlist: ['RELIANCE'] } }) }),
        ),
        'symbolAllowBlock',
      ).ok,
    ).toBe(true);
    const c = at(
      runGuardrails(
        baseInput({ config: makeConfig({ guardrails: { symbolAllowlist: ['INFY'] } }) }),
      ),
      'symbolAllowBlock',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('not in the symbol allowlist');
  });

  it('lets the blocklist win over the allowlist', () => {
    expect(
      at(
        runGuardrails(
          baseInput({
            config: makeConfig({
              guardrails: { symbolAllowlist: ['RELIANCE'], symbolBlocklist: ['RELIANCE'] },
            }),
          }),
        ),
        'symbolAllowBlock',
      ).ok,
    ).toBe(false);
  });
});

describe('priceCollar', () => {
  it('passes for a limit price inside the collar', () => {
    expect(at(runGuardrails(baseInput()), 'priceCollar').ok).toBe(true);
  });

  it('fails for a limit price outside the collar', () => {
    const c = at(
      runGuardrails(baseInput({ order: makeOrder({ limitPrice: 3100 }) })),
      'priceCollar',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('collar ±2%');
  });

  it('collars SL orders on their limit price', () => {
    expect(
      at(
        runGuardrails(
          baseInput({
            order: makeOrder({ orderType: 'SL', limitPrice: 3100, triggerPrice: 3105 }),
          }),
        ),
        'priceCollar',
      ).ok,
    ).toBe(false);
    expect(
      at(
        runGuardrails(
          baseInput({
            order: makeOrder({ orderType: 'SL', limitPrice: 2951, triggerPrice: 2952 }),
          }),
        ),
        'priceCollar',
      ).ok,
    ).toBe(true);
  });

  it('skips the collar for MARKET and SL-M but still demands a live quote', () => {
    const market = makeOrder({ orderType: 'MARKET', limitPrice: undefined });
    const passing = at(runGuardrails(baseInput({ order: market })), 'priceCollar');
    expect(passing.ok).toBe(true);
    expect(passing.detail).toContain('collar not applicable to MARKET');

    const noQuote = at(
      runGuardrails(baseInput({ order: market, quote: undefined })),
      'priceCollar',
    );
    expect(noQuote.ok).toBe(false);
    expect(noQuote.detail).toContain('no usable live quote');

    const slm = makeOrder({ orderType: 'SL-M', limitPrice: undefined, triggerPrice: 3500 });
    expect(at(runGuardrails(baseInput({ order: slm })), 'priceCollar').ok).toBe(true);
    expect(at(runGuardrails(baseInput({ order: slm, quote: undefined })), 'priceCollar').ok).toBe(
      false,
    );
  });

  it('fails when the quote is for a different symbol', () => {
    const c = at(runGuardrails(baseInput({ quote: makeQuote({ symbol: INFY }) })), 'priceCollar');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('quote is for NSE:EQ:INFY');
  });

  it('fails on a non-positive LTP', () => {
    expect(at(runGuardrails(baseInput({ quote: makeQuote({ ltp: 0 }) })), 'priceCollar').ok).toBe(
      false,
    );
  });
});

describe('tickLotValidity', () => {
  it('passes for a lot-multiple quantity on a tick-multiple price', () => {
    expect(at(runGuardrails(baseInput()), 'tickLotValidity').ok).toBe(true);
  });

  it('fails when quantity is not a lot multiple', () => {
    const c = at(
      runGuardrails(
        baseInput({
          order: makeOrder({ quantity: 30, limitPrice: 100 }),
          instrument: makeInstrument({ lotSize: 25, tickSize: 0.05 }),
        }),
      ),
      'tickLotValidity',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('not a multiple of lot size 25');
  });

  it('fails when limit or trigger price is off-tick', () => {
    expect(
      at(runGuardrails(baseInput({ order: makeOrder({ limitPrice: 2950.53 }) })), 'tickLotValidity')
        .detail,
    ).toContain('limitPrice');
    expect(
      at(
        runGuardrails(
          baseInput({
            order: makeOrder({ orderType: 'SL', limitPrice: 2950.5, triggerPrice: 2950.51 }),
          }),
        ),
        'tickLotValidity',
      ).detail,
    ).toContain('triggerPrice');
  });

  it('fails closed without an instrument, or with the wrong one', () => {
    expect(at(runGuardrails(baseInput({ instrument: undefined })), 'tickLotValidity').ok).toBe(
      false,
    );
    const wrong = at(
      runGuardrails(baseInput({ instrument: makeInstrument({ canonical: INFY }) })),
      'tickLotValidity',
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toContain('instrument is for NSE:EQ:INFY');
  });

  it('fails on a nonsense lot or tick size', () => {
    expect(
      at(
        runGuardrails(baseInput({ instrument: makeInstrument({ lotSize: 0 }) })),
        'tickLotValidity',
      ).ok,
    ).toBe(false);
    expect(
      at(
        runGuardrails(baseInput({ instrument: makeInstrument({ tickSize: 0 }) })),
        'tickLotValidity',
      ).ok,
    ).toBe(false);
  });
});

describe('fundsSufficient', () => {
  it('passes when the margin requirement fits', () => {
    expect(at(runGuardrails(baseInput()), 'fundsSufficient').ok).toBe(true);
  });

  it('fails when it does not', () => {
    const c = at(
      runGuardrails(baseInput({ funds: makeFunds({ availableMargin: 1_000 }) })),
      'fundsSufficient',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('available margin ₹1000');
  });

  it('fails closed with no funds snapshot or no price', () => {
    expect(at(runGuardrails(baseInput({ funds: undefined })), 'fundsSufficient').ok).toBe(false);
    expect(
      at(
        runGuardrails(
          baseInput({
            order: makeOrder({ orderType: 'MARKET', limitPrice: undefined }),
            quote: undefined,
          }),
        ),
        'fundsSufficient',
      ).ok,
    ).toBe(false);
  });

  it('treats a DELIVERY sell as needing no margin, a leveraged sell as needing full notional', () => {
    const sellCnc = makeOrder({ side: 'SELL', product: 'DELIVERY' });
    const sellMis = makeOrder({ side: 'SELL', product: 'INTRADAY' });
    const funds = makeFunds({ availableMargin: 0 });
    expect(at(runGuardrails(baseInput({ order: sellCnc, funds })), 'fundsSufficient').ok).toBe(
      true,
    );
    expect(at(runGuardrails(baseInput({ order: sellMis, funds })), 'fundsSufficient').ok).toBe(
      false,
    );
  });

  it('uses an explicit broker margin number when supplied', () => {
    const c = at(
      runGuardrails(
        baseInput({ requiredMarginInr: 5_000, funds: makeFunds({ availableMargin: 10_000 }) }),
      ),
      'fundsSufficient',
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('requires ₹5000');
  });
});

describe('idempotencyUnused', () => {
  it('passes for an unused key', () => {
    expect(at(runGuardrails(baseInput()), 'idempotencyUnused').ok).toBe(true);
  });

  it('fails for a used key', () => {
    const c = at(
      runGuardrails(baseInput({ idempotency: { key: 'idem-1', used: true } })),
      'idempotencyUnused',
    );
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('already used');
  });

  it('fails closed when no key is supplied', () => {
    expect(at(runGuardrails(baseInput({ idempotency: undefined })), 'idempotencyUnused').ok).toBe(
      false,
    );
  });
});

describe('code-level absolute ceilings', () => {
  it('exposes the documented constants', () => {
    expect(ABS_MAX_ORDER_VALUE_INR).toBe(500_000);
    expect(ABS_MAX_DAILY_NOTIONAL_INR).toBe(2_000_000);
    expect(ABS_MAX_ORDERS_PER_DAY).toBe(50);
  });

  it('clampConfigToCeilings takes min(config, ceiling)', () => {
    const loose = makeConfig({
      guardrails: {
        maxOrderValueInr: 10_000_000,
        maxDailyNotionalInr: 99_000_000,
        maxOrdersPerDay: 1_000,
      },
    });
    const clamped = clampConfigToCeilings(loose);
    expect(clamped.guardrails.maxOrderValueInr).toBe(ABS_MAX_ORDER_VALUE_INR);
    expect(clamped.guardrails.maxDailyNotionalInr).toBe(ABS_MAX_DAILY_NOTIONAL_INR);
    expect(clamped.guardrails.maxOrdersPerDay).toBe(ABS_MAX_ORDERS_PER_DAY);
    // A stricter config is left alone, and the original is not mutated.
    expect(clampConfigToCeilings(makeConfig()).guardrails.maxOrderValueInr).toBe(100_000);
    expect(loose.guardrails.maxOrderValueInr).toBe(10_000_000);
  });

  it('clamps a non-finite config value down to the ceiling', () => {
    const clamped = clampConfigToCeilings(
      makeConfig({ guardrails: { maxOrderValueInr: Number.POSITIVE_INFINITY } }),
    );
    expect(clamped.guardrails.maxOrderValueInr).toBe(ABS_MAX_ORDER_VALUE_INR);
  });

  it('enforces the ceilings inside runGuardrails even if the caller forgot to clamp', () => {
    const loose = makeConfig({
      guardrails: {
        maxOrderValueInr: 10_000_000,
        maxDailyNotionalInr: 99_000_000,
        maxOrdersPerDay: 1_000,
      },
    });

    const overValue = at(
      runGuardrails(
        baseInput({
          config: loose,
          order: makeOrder({ quantity: 200, limitPrice: 3_000 }),
          quote: makeQuote({ ltp: 3_000 }),
        }),
      ),
      'maxOrderValue',
    );
    expect(overValue.ok).toBe(false);
    expect(overValue.detail).toContain('cap ₹500000');

    const overNotional = at(
      runGuardrails(baseInput({ config: loose, today: { orderCount: 3, notionalInr: 1_990_000 } })),
      'dailyNotional',
    );
    expect(overNotional.ok).toBe(false);
    expect(overNotional.detail).toContain('cap ₹2000000');

    const overCount = at(
      runGuardrails(baseInput({ config: loose, today: { orderCount: 50, notionalInr: 0 } })),
      'dailyOrderCount',
    );
    expect(overCount.ok).toBe(false);
    expect(overCount.detail).toContain('cap 50');
  });
});

describe('pure helpers', () => {
  it('formatInr rounds to paise without locale dependence', () => {
    expect(formatInr(1234.567)).toBe('₹1234.57');
    expect(formatInr(0)).toBe('₹0');
    expect(formatInr(-50.5)).toBe('₹-50.5');
  });

  it('isMultipleOf survives binary-float ticks', () => {
    expect(isMultipleOf(2950.5, 0.05)).toBe(true);
    expect(isMultipleOf(2950.53, 0.05)).toBe(false);
    expect(isMultipleOf(0.3, 0.1)).toBe(true);
    expect(isMultipleOf(10, 0)).toBe(false);
    expect(isMultipleOf(Number.NaN, 0.05)).toBe(false);
  });

  it('estimateOrderNotionalInr takes the most expensive known price', () => {
    expect(estimateOrderNotionalInr(makeOrder({ quantity: 2, limitPrice: 100 }), 90)).toBe(200);
    expect(estimateOrderNotionalInr(makeOrder({ quantity: 2, limitPrice: 100 }), 150)).toBe(300);
    expect(
      estimateOrderNotionalInr(
        makeOrder({ quantity: 2, orderType: 'MARKET', limitPrice: undefined }),
      ),
    ).toBeUndefined();
    expect(
      estimateOrderNotionalInr(
        makeOrder({ quantity: 2, orderType: 'SL-M', limitPrice: undefined, triggerPrice: 50 }),
      ),
    ).toBe(100);
  });

  it('estimateRequiredMarginInr is conservative by side and product', () => {
    expect(estimateRequiredMarginInr(makeOrder({ side: 'BUY' }), 1000)).toBe(1000);
    expect(estimateRequiredMarginInr(makeOrder({ side: 'SELL', product: 'DELIVERY' }), 1000)).toBe(
      0,
    );
    expect(estimateRequiredMarginInr(makeOrder({ side: 'SELL', product: 'INTRADAY' }), 1000)).toBe(
      1000,
    );
  });
});
