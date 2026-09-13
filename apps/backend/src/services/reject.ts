/**
 * `POST /v1/proposals/:id/reject` — docs/04 §4.3.
 *
 * The app *can* write this transition directly under the Firestore rules
 * (docs/03 §3.9), but routing it through the backend gives one audit trail and
 * one owner check for every decision, approve or reject.
 */

import { assertTransition } from '@pm/core';
import type { ProposalRepo } from '../ports/index.js';
import type { Clock } from '../ports/index.js';
import type { AuditWriter } from './audit.js';

export interface RejectInput {
  uid: string;
  proposalId: string;
  reason?: string | undefined;
}

export type RejectResult =
  | { ok: true; status: 'rejected' }
  | { ok: false; reason: 'UNAUTHORIZED' | 'STALE_PROPOSAL'; detail: string };

export interface RejectDeps {
  proposals: ProposalRepo;
  audit: AuditWriter;
  clock: Clock;
}

export interface RejectService {
  rejectProposal(input: RejectInput): Promise<RejectResult>;
}

export function createRejectService(deps: RejectDeps): RejectService {
  return {
    async rejectProposal(input: RejectInput): Promise<RejectResult> {
      const proposal = await deps.proposals.get(input.proposalId);
      if (proposal === undefined) {
        return {
          ok: false,
          reason: 'STALE_PROPOSAL',
          detail: `proposal '${input.proposalId}' not found`,
        };
      }
      if (proposal.uid !== input.uid) {
        return {
          ok: false,
          reason: 'UNAUTHORIZED',
          detail: 'caller is not the owner of this proposal',
        };
      }
      if (proposal.status !== 'pending') {
        return {
          ok: false,
          reason: 'STALE_PROPOSAL',
          detail: `proposal status '${proposal.status}' can no longer be rejected`,
        };
      }

      assertTransition('pending', 'rejected');
      const moved = await deps.proposals.transition(input.proposalId, 'pending', 'rejected', {
        decidedBy: input.uid,
        decidedAt: deps.clock.now().toISOString(),
        ...(input.reason === undefined ? {} : { failureReason: input.reason }),
      });
      if (!moved.ok) {
        return {
          ok: false,
          reason: 'STALE_PROPOSAL',
          detail:
            moved.reason === 'not-found'
              ? `proposal '${input.proposalId}' not found`
              : `proposal moved to '${moved.current}' concurrently`,
        };
      }

      await deps.audit.record({
        uid: input.uid,
        type: 'proposal.rejected',
        refId: input.proposalId,
        actor: 'app-user',
        detail: { reason: input.reason ?? 'rejected by user' },
      });
      return { ok: true, status: 'rejected' };
    },
  };
}
