import type { Proposal } from '@pm/core';
import * as logger from 'firebase-functions/logger';

import { proposalCreatedPush } from '../catalogue.js';
import { sendToUser } from '../notify.js';
import type { Db, DocCreatedEvent, Messaging } from '../ports.js';

export interface OnProposalCreatedResult {
  sent: boolean;
}

/**
 * docs/06 §6.5 "New proposal". Fires for a new `proposals/{id}` doc: pushes
 * to every fcmToken on `users/{uid}` when the proposal is `pending`; no-op
 * otherwise (a proposal is only ever created `pending`, but a replayed or
 * backfilled event could hand us any status, so this stays defensive).
 */
export async function onProposalCreated(
  deps: { db: Db; messaging: Messaging },
  event: DocCreatedEvent<Proposal>,
): Promise<OnProposalCreatedResult> {
  const proposal = event.data;

  if (proposal.status !== 'pending') {
    logger.info('onProposalCreated: non-pending proposal, skipping', {
      proposalId: event.id,
      status: proposal.status,
    });
    return { sent: false };
  }

  const payload = proposalCreatedPush({
    proposalId: event.id,
    side: proposal.order.side,
    quantity: proposal.order.quantity,
    tradingSymbol: proposal.order.symbol.tradingSymbol,
  });

  const result = await sendToUser(deps, proposal.uid, payload);
  return { sent: result.sent > 0 };
}
