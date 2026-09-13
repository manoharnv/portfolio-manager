import { describe, expect, it } from 'vitest';
import {
  ALL_PROPOSAL_STATUSES,
  CLIENT_ALLOWED_TRANSITIONS,
  EXECUTABLE_STATUSES,
  InvalidProposalTransitionError,
  TERMINAL_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
  isBackendOnlyTransition,
  isClientAllowedTransition,
  isTerminalStatus,
} from './proposal-state.js';
import type { ProposalStatus } from './schemas.js';

/** The complete edge set of the docs/03 §3.3 state diagram. */
const ALLOWED: ReadonlyArray<readonly [ProposalStatus, ProposalStatus]> = [
  ['pending', 'approved'],
  ['pending', 'rejected'],
  ['pending', 'expired'],
  ['approved', 'placing'],
  ['approved', 'blocked'],
  ['placing', 'placed'],
  ['placing', 'failed'],
  ['placed', 'filled'],
  ['placed', 'rejected'],
];

const allowedSet = new Set(ALLOWED.map(([f, t]) => `${f}>${t}`));

describe('transition matrix', () => {
  it.each(ALLOWED)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('denies every edge not in the diagram (full N×N sweep)', () => {
    const denied: string[] = [];
    for (const from of ALL_PROPOSAL_STATUSES) {
      for (const to of ALL_PROPOSAL_STATUSES) {
        const edge = `${from}>${to}`;
        if (allowedSet.has(edge)) continue;
        if (canTransition(from, to)) denied.push(edge);
      }
    }
    expect(denied).toEqual([]);
  });

  it('covers the whole matrix in this test (9 statuses × 9)', () => {
    expect(ALL_PROPOSAL_STATUSES).toHaveLength(9);
    expect(ALLOWED).toHaveLength(9);
  });

  it.each([
    ['pending', 'placing'], // must go through approved
    ['pending', 'placed'],
    ['pending', 'filled'],
    ['pending', 'blocked'],
    ['approved', 'placed'], // must go through placing
    ['approved', 'filled'],
    ['approved', 'rejected'], // a human cannot reject after approving
    ['approved', 'expired'],
    ['placing', 'filled'],
    ['placing', 'blocked'],
    ['placed', 'placing'], // no going backwards
    ['placed', 'expired'],
    ['placed', 'blocked'],
  ] as const)('denies the representative bad edge %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(InvalidProposalTransitionError);
  });

  it.each(ALL_PROPOSAL_STATUSES)('denies the self-transition %s → %s', (status) => {
    expect(canTransition(status, status)).toBe(false);
  });

  it('reports the allowed set per status', () => {
    expect([...allowedTransitions('pending')].sort()).toEqual(['approved', 'expired', 'rejected']);
    expect([...allowedTransitions('approved')].sort()).toEqual(['blocked', 'placing']);
    expect([...allowedTransitions('placing')].sort()).toEqual(['failed', 'placed']);
    expect([...allowedTransitions('placed')].sort()).toEqual(['filled', 'rejected']);
  });
});

describe('terminal statuses', () => {
  it('lists exactly the five terminal states', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      'blocked',
      'expired',
      'failed',
      'filled',
      'rejected',
    ]);
  });

  it.each(TERMINAL_STATUSES)('%s can never transition anywhere', (from) => {
    expect(isTerminalStatus(from)).toBe(true);
    expect(allowedTransitions(from)).toEqual([]);
    for (const to of ALL_PROPOSAL_STATUSES) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it.each(['pending', 'approved', 'placing', 'placed'] as const)('%s is not terminal', (status) => {
    expect(isTerminalStatus(status)).toBe(false);
  });
});

describe('authority split', () => {
  it('allows the client exactly the two documented transitions', () => {
    expect(CLIENT_ALLOWED_TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort()).toEqual([
      'pending>approved',
      'pending>rejected',
    ]);
    expect(isClientAllowedTransition('pending', 'approved')).toBe(true);
    expect(isClientAllowedTransition('pending', 'rejected')).toBe(true);
  });

  it('marks everything past approved as backend-only', () => {
    expect(isBackendOnlyTransition('pending', 'approved')).toBe(false);
    expect(isBackendOnlyTransition('pending', 'rejected')).toBe(false);
    for (const [from, to] of ALLOWED) {
      if (from === 'pending' && (to === 'approved' || to === 'rejected')) continue;
      expect(isBackendOnlyTransition(from, to)).toBe(true);
    }
  });

  it('denies invalid edges to the client too (fail closed)', () => {
    expect(isClientAllowedTransition('placed', 'filled')).toBe(false);
    expect(isBackendOnlyTransition('filled', 'pending')).toBe(true);
  });

  it('exposes the executable statuses used by the backend', () => {
    expect([...EXECUTABLE_STATUSES].sort()).toEqual(['approved', 'pending']);
  });
});

describe('InvalidProposalTransitionError', () => {
  it('names the edge and what was allowed', () => {
    const err = new InvalidProposalTransitionError('pending', 'filled');
    expect(err.from).toBe('pending');
    expect(err.to).toBe('filled');
    expect(err.message).toContain('pending → filled');
    expect(err.message).toContain('approved, rejected, expired');
  });

  it('says "terminal" when there is nowhere to go', () => {
    expect(new InvalidProposalTransitionError('filled', 'pending').message).toContain('terminal');
  });
});
