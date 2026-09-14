/** Collection paths — docs/03-data-model.md §3.1. */

export const CONFIG_COLLECTION = 'config';
export const PROPOSALS_COLLECTION = 'proposals';
export const AUDIT_LOG_COLLECTION = 'auditLog';
export const FUNDS_DOC_ID = 'current';

export const strategyDefsPath = (uid: string): string => `strategies/${uid}/defs`;
export const booksPath = (uid: string): string => `books/${uid}/books`;
export const ledgerEntriesPath = (uid: string): string => `ledger/${uid}/entries`;
export const brokerSessionsPath = (uid: string): string => `brokerSessions/${uid}/brokers`;
export const holdingsPath = (uid: string): string => `portfolio/${uid}/holdings`;
export const positionsPath = (uid: string): string => `portfolio/${uid}/positions`;
export const fundsPath = (uid: string): string => `portfolio/${uid}/funds`;

/**
 * Proposal statuses that still represent a live intent, so a new draft for the
 * same intent would be a duplicate (docs/05 §5.4).
 */
export const OPEN_PROPOSAL_STATUSES = ['pending', 'approved', 'placing', 'placed'] as const;

/** IST day bounds for a `YYYY-MM-DD` key, as ISO-8601 instants. */
export function istDayBounds(istDateKey: string): { from: string; to: string } {
  return {
    from: `${istDateKey}T00:00:00.000+05:30`,
    to: `${istDateKey}T23:59:59.999+05:30`,
  };
}
