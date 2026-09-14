import { randomUUID } from 'node:crypto';

import type { Proposal } from '@pm/core';
import * as logger from 'firebase-functions/logger';

import { proposalExpiringSoonPush } from '../catalogue.js';
import { sendToUser } from '../notify.js';
import type { Clock, Db, Messaging } from '../ports.js';

const PAGE_SIZE = 200;

/** docs/06 §6.5 "Proposal expiring soon" fires when ttlExpiresAt lands in this window from now. */
const EXPIRING_SOON_FROM_MS = 90_000;
const EXPIRING_SOON_TO_MS = 150_000;

export interface ExpireProposalsResult {
  expiredCount: number;
}

/**
 * docs/03 §3.10: a scheduled sweep flips `pending → expired` (and audits it)
 * before the Firestore TTL policy eventually deletes the document, so the app
 * reflects expiry before deletion. Runs every minute (index.ts); pages 200 at
 * a time since each page's writes remove those docs from the `pending` filter,
 * naturally advancing the next page without a cursor.
 */
export async function expireProposals(deps: {
  db: Db;
  clock: Clock;
}): Promise<ExpireProposalsResult> {
  const nowIso = deps.clock.now().toISOString();
  let expiredCount = 0;

  for (;;) {
    const due = await deps.db.queryCollection<Proposal>(
      'proposals',
      [
        { field: 'status', op: '==', value: 'pending' },
        { field: 'ttlExpiresAt', op: '<=', value: nowIso },
      ],
      PAGE_SIZE,
    );
    if (due.length === 0) {
      break;
    }

    const batch = deps.db.batch();
    for (const doc of due) {
      batch.update(`proposals/${doc.id}`, { status: 'expired' });
    }
    await batch.commit();

    for (const doc of due) {
      await deps.db.addDoc('auditLog', {
        id: randomUUID(),
        uid: doc.data.uid,
        ts: nowIso,
        actor: 'system',
        type: 'proposal.expired',
        refId: doc.id,
        detail: { ttlExpiresAt: doc.data.ttlExpiresAt },
      });
    }

    expiredCount += due.length;
    logger.info('expireProposals: expired a page', { count: due.length });

    if (due.length < PAGE_SIZE) {
      break;
    }
  }

  return { expiredCount };
}

export interface ExpiringSoonResult {
  notifiedCount: number;
}

/** A `proposals/{id}` doc with the (non-schema) idempotency stamp this module adds. */
type ProposalWithStamp = Proposal & { expiringSoonNotifiedAt?: string | undefined };

/**
 * docs/06 §6.5 "Proposal expiring soon": pushes once per proposal, stamping
 * `expiringSoonNotifiedAt` so a re-run inside the same window (this runs every
 * minute, alongside {@link expireProposals}) never double-sends.
 */
export async function expireProposalsExpiringSoon(deps: {
  db: Db;
  messaging: Messaging;
  clock: Clock;
}): Promise<ExpiringSoonResult> {
  const now = deps.clock.now();
  const from = new Date(now.getTime() + EXPIRING_SOON_FROM_MS).toISOString();
  const to = new Date(now.getTime() + EXPIRING_SOON_TO_MS).toISOString();

  const candidates = await deps.db.queryCollection<ProposalWithStamp>('proposals', [
    { field: 'status', op: '==', value: 'pending' },
    { field: 'ttlExpiresAt', op: '>=', value: from },
    { field: 'ttlExpiresAt', op: '<=', value: to },
  ]);

  let notifiedCount = 0;
  for (const doc of candidates) {
    if (doc.data.expiringSoonNotifiedAt !== undefined) {
      continue;
    }

    const result = await sendToUser(
      deps,
      doc.data.uid,
      proposalExpiringSoonPush({ proposalId: doc.id }),
    );
    await deps.db.updateDoc(`proposals/${doc.id}`, { expiringSoonNotifiedAt: now.toISOString() });
    if (result.sent > 0) {
      notifiedCount += 1;
    }
  }

  return { notifiedCount };
}
