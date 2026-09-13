/**
 * Composition root — the ONLY file that binds handlers to Cloud Functions
 * (2nd gen) triggers and the ONLY file (besides `adapters/admin.ts`) that
 * imports `firebase-admin` / `firebase-functions`. Excluded from coverage
 * (vitest.config.ts): it is pure wiring, validated instead by the
 * bundle-load smoke test documented in functions/README.md. Every handler
 * underneath is a pure function tested with in-memory fakes — see
 * `handlers/*.test.ts` (docs/00 §0.5).
 *
 * docs/08 §8.4: these functions never hold broker order credentials and never
 * import `@pm/broker-*` — they only read/write Firestore and send FCM pushes.
 */
import { AuditEventSchema, OrderRecordSchema, ProposalSchema } from '@pm/core';
import * as logger from 'firebase-functions/logger';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { createAdminClock, createAdminDb, createAdminMessaging } from './adapters/admin.js';
import { expireProposals, expireProposalsExpiringSoon } from './handlers/expireProposals.js';
import { onAuditEvent } from './handlers/onAuditEvent.js';
import { onOrderUpdated } from './handlers/onOrderUpdated.js';
import { onProposalCreated } from './handlers/onProposalCreated.js';
import { sessionReminder } from './handlers/sessionReminder.js';
import type { Deps } from './ports.js';

// docs/08 §8.1: the whole project lives in asia-south1 (Mumbai). Functions
// never place broker orders (docs/08 §8.4), so they don't need the VM's
// static IP, but co-locating with Firestore keeps reads/writes fast.
setGlobalOptions({ region: 'asia-south1' });

function makeDeps(): Deps {
  return { db: createAdminDb(), messaging: createAdminMessaging(), clock: createAdminClock() };
}

export const onProposalCreatedFn = onDocumentCreated('proposals/{id}', async (event) => {
  const snap = event.data;
  if (!snap) {
    logger.warn('onProposalCreatedFn: event carried no document snapshot');
    return;
  }

  const parsed = ProposalSchema.safeParse(snap.data());
  if (!parsed.success) {
    logger.error('onProposalCreatedFn: proposal failed schema validation, skipping push', {
      id: snap.id,
      issues: parsed.error.issues,
    });
    return;
  }

  await onProposalCreated(makeDeps(), { id: snap.id, path: snap.ref.path, data: parsed.data });
});

export const onOrderUpdatedFn = onDocumentUpdated('orders/{id}', async (event) => {
  const change = event.data;
  if (!change) {
    logger.warn('onOrderUpdatedFn: event carried no document change');
    return;
  }

  const before = OrderRecordSchema.safeParse(change.before.data());
  const after = OrderRecordSchema.safeParse(change.after.data());
  if (!before.success || !after.success) {
    logger.error('onOrderUpdatedFn: order failed schema validation, skipping push', {
      id: change.after.id,
      beforeIssues: before.success ? undefined : before.error.issues,
      afterIssues: after.success ? undefined : after.error.issues,
    });
    return;
  }

  await onOrderUpdated(makeDeps(), {
    id: change.after.id,
    path: change.after.ref.path,
    before: before.data,
    after: after.data,
  });
});

export const onAuditEventFn = onDocumentCreated('auditLog/{id}', async (event) => {
  const snap = event.data;
  if (!snap) {
    logger.warn('onAuditEventFn: event carried no document snapshot');
    return;
  }

  const parsed = AuditEventSchema.safeParse(snap.data());
  if (!parsed.success) {
    logger.error('onAuditEventFn: audit event failed schema validation, skipping push', {
      id: snap.id,
      issues: parsed.error.issues,
    });
    return;
  }

  await onAuditEvent(makeDeps(), { id: snap.id, path: snap.ref.path, data: parsed.data });
});

export const expireProposalsFn = onSchedule('every 1 minutes', async () => {
  const deps = makeDeps();
  const expired = await expireProposals(deps);
  const soon = await expireProposalsExpiringSoon(deps);
  logger.info('expireProposalsFn: swept proposals', { expired, soon });
});

export const sessionReminderFn = onSchedule(
  { schedule: '45 8 * * 1-5', timeZone: 'Asia/Kolkata' },
  async () => {
    const result = await sessionReminder(makeDeps());
    logger.info('sessionReminderFn: reminded disconnected users', result);
  },
);
