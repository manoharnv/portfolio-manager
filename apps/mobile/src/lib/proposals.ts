/**
 * Everything the approval screen needs that is *not* I/O.
 *
 * `approvalGate` is the client-side mirror of the backend's refusal ladder
 * (apps/backend/src/services/execution.ts §4.4 A–J). It exists so the human is
 * told *before* tapping why an order cannot go — never to replace the backend
 * check. It fails closed in exactly the same places: no config, no quote, no
 * session ⇒ blocked.
 */
import { clampConfigToCeilings, isTerminalStatus } from '@pm/core';
import type { Config, Proposal } from '@pm/core';
import { doc, updateDoc } from 'firebase/firestore';
import type { SessionPayload } from './api';
import { getDb } from './firebase';

// ---------------------------------------------------------------------------
// Reject — the one write the client is allowed to make to a proposal
// ---------------------------------------------------------------------------

/**
 * firestore.rules permits exactly this diff on a *pending* proposal:
 * `hasOnly(['status','decidedBy','decidedAt'])`, `status == 'rejected'`, and
 * `decidedBy == request.auth.uid`. Anything more is rejected by the rules, so
 * the payload is built literally — never spread from the document.
 *
 * Done client-side rather than through `POST /v1/proposals/:id/reject` so that
 * saying "no" still works when the backend is unreachable (docs/06 §6.6). The
 * backend route remains the server-side equivalent; see README.
 */
export async function rejectProposal(proposalId: string, uid: string, now: Date): Promise<void> {
  await updateDoc(doc(getDb(), 'proposals', proposalId), {
    status: 'rejected',
    decidedBy: uid,
    decidedAt: now.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

export function secondsUntil(iso: string, now: Date): number {
  const expiry = new Date(iso).getTime();
  if (Number.isNaN(expiry)) return 0;
  return Math.max(0, (expiry - now.getTime()) / 1000);
}

export function isExpired(proposal: Proposal, now: Date): boolean {
  return secondsUntil(proposal.ttlExpiresAt, now) <= 0;
}

// ---------------------------------------------------------------------------
// Collar
// ---------------------------------------------------------------------------

export type CollarBasis = 'limit' | 'proposal-ltp';

export interface CollarState {
  /** `config.guardrails.priceCollarPct`, after the code ceilings are applied. */
  pct: number;
  basis: CollarBasis;
  /** The price the live LTP is compared against. */
  reference: number | undefined;
  liveLtp: number | undefined;
  /** |live − reference| / live × 100, matching the backend's formula. */
  deviationPct: number | undefined;
  within: boolean;
}

/**
 * Mirrors guardrail 12 for LIMIT/SL (limit vs live LTP) and, for MARKET/SL-M
 * where there is no limit to collar, measures drift from the LTP the proposal
 * was built on — which is what docs/06 §6.3 means by "price moved — refresh".
 */
export function collarState(
  proposal: Proposal,
  config: Config | undefined,
  liveLtp: number | undefined,
): CollarState {
  const pct = config === undefined ? 0 : clampConfigToCeilings(config).guardrails.priceCollarPct;
  const usesLimit = proposal.order.orderType === 'LIMIT' || proposal.order.orderType === 'SL';
  const basis: CollarBasis = usesLimit ? 'limit' : 'proposal-ltp';
  const reference = usesLimit ? proposal.order.limitPrice : proposal.marketContext.ltpAtProposal;

  if (
    config === undefined ||
    reference === undefined ||
    liveLtp === undefined ||
    !Number.isFinite(liveLtp) ||
    liveLtp <= 0
  ) {
    return { pct, basis, reference, liveLtp, deviationPct: undefined, within: false };
  }

  const deviationPct = (Math.abs(reference - liveLtp) / liveLtp) * 100;
  return { pct, basis, reference, liveLtp, deviationPct, within: deviationPct <= pct };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type ApprovalBlock =
  | 'NO_CONFIG'
  | 'NOT_PENDING'
  | 'TTL_EXPIRED'
  | 'KILL_SWITCH'
  | 'TRADING_DISABLED'
  | 'NO_SESSION'
  | 'BACKEND_DOWN'
  | 'NO_QUOTE'
  | 'PRICE_OUT_OF_COLLAR'
  | 'PRECHECK_FAILED';

export interface ApprovalBlockDetail {
  reason: ApprovalBlock;
  detail: string;
}

export interface ApprovalGateInput {
  proposal: Proposal;
  config: Config | undefined;
  session: SessionPayload | undefined;
  /** `false` when `/health` or the last call failed (docs/06 §6.6). */
  backendReachable: boolean;
  liveLtp: number | undefined;
  now: Date;
}

export interface ApprovalGate {
  canApprove: boolean;
  blocks: ApprovalBlockDetail[];
  collar: CollarState;
  secondsRemaining: number;
}

export function approvalGate(input: ApprovalGateInput): ApprovalGate {
  const { proposal, config, session, now } = input;
  const blocks: ApprovalBlockDetail[] = [];
  const collar = collarState(proposal, config, input.liveLtp);
  const secondsRemaining = secondsUntil(proposal.ttlExpiresAt, now);

  if (config === undefined) {
    blocks.push({
      reason: 'NO_CONFIG',
      detail: 'your config has not loaded — approving without it is not possible',
    });
  }
  if (proposal.status !== 'pending') {
    blocks.push({
      reason: 'NOT_PENDING',
      detail: isTerminalStatus(proposal.status)
        ? `this proposal is ${proposal.status} — it is read-only now`
        : `this proposal is already ${proposal.status}`,
    });
  }
  if (secondsRemaining <= 0) {
    blocks.push({ reason: 'TTL_EXPIRED', detail: 'the proposal TTL has elapsed' });
  }
  if (config?.killSwitch === true) {
    blocks.push({ reason: 'KILL_SWITCH', detail: 'the kill switch is on — all orders refused' });
  }
  if (config !== undefined && !config.tradingEnabled) {
    blocks.push({ reason: 'TRADING_DISABLED', detail: 'trading is disabled in settings' });
  }
  if (!input.backendReachable) {
    blocks.push({
      reason: 'BACKEND_DOWN',
      detail: 'execution unavailable — the backend is not answering',
    });
  }

  const active = session?.brokers.find((b) => b.broker === session.activeBroker);
  if (session === undefined) {
    blocks.push({
      reason: 'NO_SESSION',
      detail: 'broker session status is unknown — connect your broker to be sure',
    });
  } else if (session.activeBroker === null) {
    blocks.push({ reason: 'NO_SESSION', detail: 'no active broker is configured' });
  } else if (active === undefined || active.needsLogin) {
    blocks.push({
      reason: 'NO_SESSION',
      detail: active?.reason ?? `${session.activeBroker} needs today's login`,
    });
  }

  if (collar.liveLtp === undefined) {
    blocks.push({
      reason: 'NO_QUOTE',
      detail: 'no live price for this symbol — approval is gated on a fresh quote',
    });
  } else if (!collar.within) {
    blocks.push({
      reason: 'PRICE_OUT_OF_COLLAR',
      detail:
        collar.deviationPct === undefined
          ? 'the price collar cannot be evaluated'
          : `price moved ${collar.deviationPct.toFixed(2)}% from ${
              collar.basis === 'limit' ? 'your limit' : 'the proposal price'
            } (collar ±${collar.pct}%) — refresh`,
    });
  }

  if (!proposal.guardrailPrecheck.passed) {
    blocks.push({
      reason: 'PRECHECK_FAILED',
      detail: 'the strategy engine’s guardrail precheck did not pass',
    });
  }

  return { canApprove: blocks.length === 0, blocks, collar, secondsRemaining };
}
