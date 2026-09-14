import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROPOSAL_INTENTS, StrategyDefSchema, TICKS, defineStrategy } from './types.js';
import { makeStrategyContext } from './test-utils/index.js';

const ParamsSchema = z.object({ threshold: z.number().positive() });

const strategy = defineStrategy({
  id: 'threshold',
  horizon: 'swing',
  schedule: ['intraday'],
  paramsSchema: ParamsSchema,
  run: (ctx) =>
    Promise.resolve({ proposals: [], notes: `threshold=${String(ctx.params.threshold)}` }),
});

describe('TICKS / PROPOSAL_INTENTS', () => {
  it('match the documented tick names', () => {
    expect(TICKS).toEqual(['pre-open', 'intraday', 'eod']);
    expect(PROPOSAL_INTENTS).toContain('stop');
    expect(PROPOSAL_INTENTS).toContain('square_off');
  });
});

describe('StrategyDefSchema', () => {
  it('accepts a minimal def', () => {
    expect(
      StrategyDefSchema.parse({
        id: 'dca',
        bookId: 'long_term',
        horizon: 'long_term',
        enabled: true,
        params: { a: 1 },
      }).params,
    ).toEqual({ a: 1 });
  });

  it('rejects a book id outside the four horizons', () => {
    expect(() =>
      StrategyDefSchema.parse({
        id: 'dca',
        bookId: 'crypto',
        horizon: 'long_term',
        enabled: true,
        params: {},
      }),
    ).toThrow();
  });

  it('accepts an explicit tick override', () => {
    expect(
      StrategyDefSchema.parse({
        id: 'dca',
        bookId: 'long_term',
        horizon: 'long_term',
        enabled: true,
        params: {},
        ticks: ['eod'],
      }).ticks,
    ).toEqual(['eod']);
  });
});

describe('defineStrategy', () => {
  it('keeps the identity fields', () => {
    expect(strategy.id).toBe('threshold');
    expect(strategy.horizon).toBe('swing');
    expect(strategy.schedule).toEqual(['intraday']);
  });

  it('validates params on the way in', async () => {
    const ok = await strategy.run(makeStrategyContext({ params: { threshold: 3 } }));
    expect(ok.notes).toBe('threshold=3');
  });

  it('rejects invalid persisted params rather than running blind', async () => {
    await expect(
      strategy.run(makeStrategyContext({ params: { threshold: -1 } })),
    ).rejects.toThrow();
    await expect(strategy.run(makeStrategyContext({ params: {} }))).rejects.toThrow();
  });

  it('exposes params validation on its own', () => {
    expect(strategy.parseParams({ threshold: 2 })).toEqual({ threshold: 2 });
    expect(() => strategy.parseParams({})).toThrow();
  });
});
