/**
 * Proposal lifecycle state machine — docs/03-data-model.md §3.3.
 *
 *   pending  → rejected | expired | approved
 *   approved → blocked  | placing
 *   placing  → placed   | failed
 *   placed   → filled   | rejected      (broker RMS reject after acceptance)
 *
 * Terminal: filled, rejected, expired, blocked, failed.
 *
 * Authority split (§3.3): the app may only drive `pending → approved` and
 * `pending → rejected`. Everything else is the backend's.
 */

import { PROPOSAL_STATUSES, type ProposalStatus } from './schemas.js';

const TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['placing', 'blocked'],
  placing: ['placed', 'failed'],
  placed: ['filled', 'rejected'],
  filled: [],
  rejected: [],
  expired: [],
  failed: [],
  blocked: [],
};

export const TERMINAL_STATUSES: readonly ProposalStatus[] = [
  'filled',
  'rejected',
  'expired',
  'failed',
  'blocked',
];

/**
 * The only two transitions a client (the app) may request. Even these route
 * through the backend in v1; the list exists so rules and the backend agree on
 * what "client-allowed" means.
 */
export const CLIENT_ALLOWED_TRANSITIONS: readonly (readonly [ProposalStatus, ProposalStatus])[] = [
  ['pending', 'approved'],
  ['pending', 'rejected'],
];

/** Statuses a proposal may still be executed from (docs/04 §4.4). */
export const EXECUTABLE_STATUSES: readonly ProposalStatus[] = ['pending', 'approved'];

export function isTerminalStatus(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * `true` iff the edge exists in the state diagram. Self-transitions are NOT
 * allowed — re-writing the same status is a no-op the caller must handle, never
 * a transition (it would otherwise mask a double-execute).
 */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Every status reachable in one step from `from`. */
export function allowedTransitions(from: ProposalStatus): readonly ProposalStatus[] {
  return TRANSITIONS[from] ?? [];
}

export class InvalidProposalTransitionError extends Error {
  readonly from: ProposalStatus;
  readonly to: ProposalStatus;

  constructor(from: ProposalStatus, to: ProposalStatus) {
    super(
      `Invalid proposal transition ${from} → ${to}. ` +
        `Allowed from '${from}': [${(TRANSITIONS[from] ?? []).join(', ') || 'none (terminal)'}]`,
    );
    this.name = 'InvalidProposalTransitionError';
    this.from = from;
    this.to = to;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Throws {@link InvalidProposalTransitionError} unless the edge exists. */
export function assertTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidProposalTransitionError(from, to);
  }
}

export function isClientAllowedTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return CLIENT_ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * `true` for every transition the app may NOT perform — i.e. anything past
 * `approved`, plus every invalid edge. Deliberately the inverse of
 * {@link isClientAllowedTransition} so an unknown/invalid edge is denied to
 * clients rather than accidentally permitted.
 */
export function isBackendOnlyTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return !isClientAllowedTransition(from, to);
}

/** All statuses, for exhaustive iteration in tests and UI. */
export const ALL_PROPOSAL_STATUSES: readonly ProposalStatus[] = PROPOSAL_STATUSES;
