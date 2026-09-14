/**
 * Audit-event construction — docs/03 §3.7, docs/04 §4.9 ("every
 * execute/reject/cancel/killswitch/login writes an immutable `auditLog` event
 * with actor, ip, and refId").
 *
 * A thin seam on purpose: it owns id minting and the clock read so no service
 * has to, and it guarantees `ip` is stamped on every event from one place.
 */

import type { AuditEvent, AuditEventType } from '@pm/core';
import type { AuditLog, Clock, IdGenerator } from '../ports/index.js';

export interface AuditWriterDeps {
  audit: AuditLog;
  ids: IdGenerator;
  clock: Clock;
  /** The VM's static IP — stamped on every event (docs/04 §4.9). */
  ip: string;
}

export interface AuditInput {
  uid: string;
  type: AuditEventType;
  refId?: string | undefined;
  detail?: Record<string, unknown> | undefined;
  actor?: AuditEvent['actor'] | undefined;
}

export interface AuditWriter {
  record(input: AuditInput): Promise<void>;
}

export function createAuditWriter(deps: AuditWriterDeps): AuditWriter {
  return {
    async record(input: AuditInput): Promise<void> {
      const event: AuditEvent = {
        id: deps.ids.auditId(),
        uid: input.uid,
        ts: deps.clock.now().toISOString(),
        actor: input.actor ?? 'backend',
        type: input.type,
        detail: input.detail ?? {},
        ...(input.refId === undefined ? {} : { refId: input.refId }),
        ...(deps.ip === '' ? {} : { ip: deps.ip }),
      };
      await deps.audit.append(event);
    },
  };
}
