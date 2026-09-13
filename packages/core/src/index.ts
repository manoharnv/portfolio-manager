/**
 * `@pm/core` — the shared, pure spine of the portfolio manager.
 *
 * Zero runtime dependencies except `zod`. No network, no filesystem, no clock of
 * its own: every function that needs "now" takes it as an argument. That is what
 * makes the guardrails, the coordinator and the risk manager testable and what
 * lets the strategy engine and the execution backend run the *same* code.
 */

export * from './domain.js';
export * from './errors.js';
export * from './broker.js';
export * from './schemas.js';
export * from './proposal-state.js';
export * from './mapping.js';
export * from './guardrails.js';
export * from './books.js';
export * from './ledger.js';
export * from './coordinator.js';
export * from './risk.js';
