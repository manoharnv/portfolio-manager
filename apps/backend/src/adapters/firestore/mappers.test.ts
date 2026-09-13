import { describe, expect, it } from 'vitest';
import { ProposalSchema } from '@pm/core';
import {
  DocumentShapeError,
  bookPath,
  decodeAll,
  decodeDoc,
  fundsPath,
  istDayBounds,
  ledgerCollection,
  portfolioCollection,
  portfolioDocId,
  sessionPath,
} from './mappers.js';
import type { FsDocSnapshot } from './db.js';
import { stripUndefined } from './db.js';
import { INFY, RELIANCE, makeProposal } from '../../test-utils/fixtures.js';

function snap(id: string, data: Record<string, unknown> | undefined): FsDocSnapshot {
  return { id, exists: data !== undefined, data: () => data };
}

describe('decodeDoc', () => {
  it('validates a well-formed document', () => {
    const proposal = makeProposal();
    expect(decodeDoc('proposals', snap('p1', proposal), ProposalSchema)).toEqual(proposal);
  });

  it('returns undefined for a missing document', () => {
    expect(decodeDoc('proposals', undefined, ProposalSchema)).toBeUndefined();
    expect(decodeDoc('proposals', snap('p1', undefined), ProposalSchema)).toBeUndefined();
  });

  it('throws rather than coercing a malformed document', () => {
    const broken = { ...makeProposal(), status: 'nonsense' };
    expect(() => decodeDoc('proposals', snap('p1', broken), ProposalSchema)).toThrow(
      DocumentShapeError,
    );
    try {
      decodeDoc('proposals', snap('p1', broken), ProposalSchema);
    } catch (err) {
      expect(err).toMatchObject({ collection: 'proposals', docId: 'p1' });
      expect((err as Error).message).toContain('status');
    }
  });
});

describe('decodeAll', () => {
  it('decodes every document in a query snapshot', () => {
    const docs = [snap('p1', makeProposal()), snap('p2', makeProposal({ id: 'p2' }))];
    expect(decodeAll('proposals', docs, ProposalSchema).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('skips documents that do not exist', () => {
    expect(decodeAll('proposals', [snap('p1', undefined)], ProposalSchema)).toEqual([]);
  });

  it('propagates a malformed document instead of silently dropping it', () => {
    const docs = [snap('p1', makeProposal()), snap('p2', { id: 'p2' })];
    expect(() => decodeAll('proposals', docs, ProposalSchema)).toThrow(DocumentShapeError);
  });
});

describe('document paths', () => {
  it('builds the documented paths', () => {
    expect(sessionPath('u1', 'dhan')).toBe('brokerSessions/u1/brokers/dhan');
    expect(bookPath('u1', 'swing')).toBe('books/u1/books/swing');
    expect(ledgerCollection('u1')).toBe('ledger/u1/entries');
    expect(portfolioCollection('u1', 'holdings')).toBe('portfolio/u1/holdings');
    expect(fundsPath('u1')).toBe('portfolio/u1/funds/current');
  });

  it('derives a stable portfolio doc id from the symbol', () => {
    expect(portfolioDocId(RELIANCE)).toBe('NSE:EQ:RELIANCE');
    expect(portfolioDocId(INFY)).toBe('NSE:EQ:INFY');
  });

  it('escapes a slash so the doc id cannot become a path', () => {
    expect(portfolioDocId({ exchange: 'NSE', segment: 'FNO', tradingSymbol: 'A/B' })).toBe(
      'NSE:FNO:A_B',
    );
  });
});

describe('istDayBounds', () => {
  it('spans the IST trading day in UTC', () => {
    expect(istDayBounds(new Date('2026-01-13T04:30:00.000Z'))).toEqual({
      dateKey: '2026-01-13',
      fromIso: '2026-01-12T18:30:00.000Z',
      toIso: '2026-01-13T18:30:00.000Z',
    });
  });

  it('rolls to the next IST day just after 18:30 UTC', () => {
    expect(istDayBounds(new Date('2026-01-13T18:31:00.000Z')).dateKey).toBe('2026-01-14');
  });
});

describe('stripUndefined', () => {
  it('drops undefined values Firestore would reject, keeping null', () => {
    expect(stripUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});
