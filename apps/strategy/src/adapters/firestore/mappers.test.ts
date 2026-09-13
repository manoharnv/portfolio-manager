import { describe, expect, it } from 'vitest';
import { symbolKey } from '@pm/core';
import {
  fromAuditEvent,
  fromProposal,
  toBook,
  toConfig,
  toFunds,
  toHolding,
  toLedgerEntry,
  toPosition,
  toProposal,
  toSessionStatus,
  toStrategyDef,
} from './mappers.js';
import {
  NOW_IST_1000,
  RELIANCE,
  makeAuditEvent,
  makeBook,
  makeConfig,
  makeLedgerEntry,
  makeProposal,
} from '../../test-utils/index.js';

describe('toConfig / toBook / toLedgerEntry / toProposal', () => {
  it('round-trip a valid document', () => {
    expect(toConfig(makeConfig())).toEqual(makeConfig());
    expect(toBook(makeBook())).toEqual(makeBook());
    const entry = makeLedgerEntry();
    expect(toLedgerEntry(entry)).toEqual(entry);
    expect(toProposal(makeProposal())).toEqual(makeProposal());
  });

  it('reject a malformed document rather than half-building an order', () => {
    expect(() => toConfig({ uid: 'u1' })).toThrow();
    expect(() => toBook({ id: 'crypto' })).toThrow();
    expect(() => toLedgerEntry({ ...makeLedgerEntry(), qty: -1 })).toThrow();
    expect(() => toProposal({ ...makeProposal(), status: 'invented' })).toThrow();
  });

  it('strip unknown fields Firestore may have accumulated', () => {
    expect(toBook({ ...makeBook(), legacyField: 'x' })).toEqual(makeBook());
  });
});

describe('toStrategyDef', () => {
  it('takes the id from the document path, not the body', () => {
    const def = toStrategyDef('dca', {
      id: 'stale-id',
      bookId: 'long_term',
      horizon: 'long_term',
      enabled: true,
      params: { amountInrPerInstrument: 5000 },
    });
    expect(def.id).toBe('dca');
    expect(def.params).toEqual({ amountInrPerInstrument: 5000 });
  });

  it('tolerates a non-object body by failing validation, not crashing', () => {
    expect(() => toStrategyDef('dca', null)).toThrow();
  });
});

describe('toSessionStatus', () => {
  it('maps the non-secret session document', () => {
    expect(
      toSessionStatus({
        broker: 'dhan',
        connected: true,
        expiresAt: '2026-01-13T18:30:00.000Z',
        staticIpOk: true,
        lastConnectedAt: null,
      }),
    ).toEqual({
      broker: 'dhan',
      connected: true,
      expiresAt: '2026-01-13T18:30:00.000Z',
      staticIpOk: true,
    });
  });

  it('drops a null expiry so the sessionValid guardrail fails closed', () => {
    const status = toSessionStatus({
      broker: 'kite',
      connected: true,
      expiresAt: null,
      staticIpOk: false,
      lastConnectedAt: null,
    });
    expect(status.expiresAt).toBeUndefined();
    expect(status.staticIpOk).toBe(false);
  });
});

describe('portfolio read-model mappers', () => {
  const holdingDoc = {
    symbolKey: symbolKey(RELIANCE),
    updatedAt: NOW_IST_1000,
    symbol: RELIANCE,
    quantity: 10,
    avgCostPrice: 2900,
    lastPrice: 2950,
    pnl: 500,
    raw: { src: 'dhan' },
  };

  it('maps a holding and keeps the raw payload', () => {
    expect(toHolding(holdingDoc)).toEqual({
      symbol: RELIANCE,
      quantity: 10,
      avgCostPrice: 2900,
      lastPrice: 2950,
      pnl: 500,
      raw: { src: 'dhan' },
    });
  });

  it('defaults a missing raw payload to null', () => {
    const { raw: _raw, ...withoutRaw } = holdingDoc;
    expect(toHolding(withoutRaw).raw).toBeNull();
  });

  it('maps a position', () => {
    expect(
      toPosition({
        symbolKey: symbolKey(RELIANCE),
        updatedAt: NOW_IST_1000,
        symbol: RELIANCE,
        netQty: -5,
        product: 'INTRADAY',
        avgPrice: 2900,
        lastPrice: 2950,
        realizedPnl: 0,
        unrealizedPnl: -250,
      }),
    ).toMatchObject({ netQty: -5, product: 'INTRADAY', raw: null });
  });

  it('maps funds', () => {
    expect(
      toFunds({
        updatedAt: NOW_IST_1000,
        availableCash: 1,
        usedMargin: 2,
        availableMargin: 3,
      }),
    ).toEqual({ availableCash: 1, usedMargin: 2, availableMargin: 3, raw: null });
  });

  it('rejects a position with an unknown product', () => {
    expect(() => toPosition({ ...holdingDoc, netQty: 1, product: 'SPOT' })).toThrow();
  });
});

describe('write mappers', () => {
  it('re-validate on the way out', () => {
    expect(fromProposal(makeProposal())).toEqual({ ...makeProposal() });
    expect(fromAuditEvent(makeAuditEvent())).toEqual({ ...makeAuditEvent() });
    expect(() => fromAuditEvent({ ...makeAuditEvent(), type: 'nope' as never })).toThrow();
  });
});
