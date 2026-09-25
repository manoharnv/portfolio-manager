import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import { StopTargetMonitorParamsSchema, stopTargetMonitorStrategy } from './stop-target-monitor.js';
import {
  RELIANCE,
  instrumentMap,
  makeDef,
  makeInstrument,
  makeLedgerEntry,
  makeQuote,
  makeStrategyContext,
  makeSwingBook,
  quoteMap,
} from '../../test-utils/index.js';
import type { StrategyResult } from '../../types.js';

const DEF = makeDef({ id: 'stop_target_monitor', bookId: 'swing', horizon: 'swing' });
const BOOK = makeSwingBook();

const params = {
  levels: [{ symbol: RELIANCE, stopPrice: 2800, targetPrice: 3100 }],
};

const owned = (qty: number, bookId = 'swing') =>
  makeLedgerEntry({ bookId, qty, price: 2900, symbolKey: symbolKey(RELIANCE) });

async function run(ltp: number, over: Record<string, unknown> = {}): Promise<StrategyResult> {
  return stopTargetMonitorStrategy.run(
    makeStrategyContext({
      params,
      def: DEF,
      book: BOOK,
      ledger: [owned(10)],
      quotes: quoteMap([makeQuote({ ltp })]),
      instruments: instrumentMap([makeInstrument()]),
      ...over,
    }),
  );
}

describe('StopTargetMonitorParamsSchema', () => {
  it('needs at least one level price', () => {
    expect(() => StopTargetMonitorParamsSchema.parse({ levels: [{ symbol: RELIANCE }] })).toThrow();
  });

  it('rejects a target at or below the stop', () => {
    expect(() =>
      StopTargetMonitorParamsSchema.parse({
        levels: [{ symbol: RELIANCE, stopPrice: 100, targetPrice: 100 }],
      }),
    ).toThrowError(/above stopPrice/);
  });
});

describe('stop-target monitor', () => {
  it('proposes nothing between the levels', async () => {
    expect((await run(2950)).proposals).toEqual([]);
  });

  it('fires the stop at exactly the stop price (≤, not <)', async () => {
    const result = await run(2800);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.order).toMatchObject({
      side: 'SELL',
      quantity: 10,
      orderType: 'SL-M',
      product: 'DELIVERY',
      triggerPrice: 2800,
    });
    expect(result.proposals[0]?.order.limitPrice).toBeUndefined();
    expect(result.proposals[0]?.intent).toBe('stop');
  });

  it('fires the target at exactly the target price (≥, not >)', async () => {
    const result = await run(3100);
    expect(result.proposals[0]?.order).toMatchObject({
      side: 'SELL',
      quantity: 10,
      orderType: 'LIMIT',
      limitPrice: 3100,
    });
    expect(result.proposals[0]?.intent).toBe('target');
  });

  it('one tick inside a level does nothing', async () => {
    expect((await run(2800.05)).proposals).toEqual([]);
    expect((await run(3099.95)).proposals).toEqual([]);
  });

  it('cannot fire both levels at once — the schema keeps target above stop', async () => {
    // With target > stop, `ltp ≤ stop` and `ltp ≥ target` are mutually exclusive,
    // so the "stop wins" branch is a defensive guard, not a live tie-break.
    await expect(
      stopTargetMonitorStrategy.run(
        makeStrategyContext({
          params: { levels: [{ symbol: RELIANCE, stopPrice: 3200, targetPrice: 3100 }] },
          def: DEF,
          book: BOOK,
          ledger: [owned(10)],
          quotes: quoteMap([makeQuote({ ltp: 3150 })]),
          instruments: instrumentMap([makeInstrument()]),
        }),
      ),
    ).rejects.toThrowError(/above stopPrice/);
  });

  it('never sells what this book does not own', async () => {
    expect((await run(2800, { ledger: [] })).proposals).toEqual([]);
    expect((await run(2800, { ledger: [owned(10, 'long_term')] })).proposals).toEqual([]);
  });

  it('sells only the quantity the book owns, rounded down to a lot', async () => {
    const result = await run(2800, {
      ledger: [owned(7)],
      instruments: instrumentMap([makeInstrument({ lotSize: 5 })]),
    });
    expect(result.proposals[0]?.order.quantity).toBe(5);
  });

  it('uses the book product, so a swing exit cannot touch another product', async () => {
    const result = await run(2800, {
      ledger: [makeLedgerEntry({ bookId: 'swing', qty: 10, product: 'INTRADAY' })],
    });
    expect(result.proposals).toEqual([]);
  });

  it('supports a stop-only level', async () => {
    const result = await stopTargetMonitorStrategy.run(
      makeStrategyContext({
        params: { levels: [{ symbol: RELIANCE, stopPrice: 2800 }] },
        def: DEF,
        book: BOOK,
        ledger: [owned(10)],
        quotes: quoteMap([makeQuote({ ltp: 2700 })]),
        instruments: instrumentMap([makeInstrument()]),
      }),
    );
    expect(result.proposals[0]?.intent).toBe('stop');
  });

  it('supports a target-only level', async () => {
    const result = await stopTargetMonitorStrategy.run(
      makeStrategyContext({
        params: { levels: [{ symbol: RELIANCE, targetPrice: 3100 }] },
        def: DEF,
        book: BOOK,
        ledger: [owned(10)],
        quotes: quoteMap([makeQuote({ ltp: 3200 })]),
        instruments: instrumentMap([makeInstrument()]),
      }),
    );
    expect(result.proposals[0]?.intent).toBe('target');
  });

  it('skips a symbol with no usable quote — fail closed', async () => {
    expect((await run(2800, { quotes: quoteMap([]) })).proposals).toEqual([]);
    expect((await run(0)).proposals).toEqual([]);
  });
});
