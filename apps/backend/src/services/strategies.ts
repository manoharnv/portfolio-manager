/**
 * `PATCH /v1/strategies/:strategyId` — docs/03 §3.1 (`strategies/{uid}/defs/{id}`).
 *
 * The app can enable/disable a strategy and tune its params; the Firestore rules
 * make `strategies/*` read-only to clients, so the write comes through here.
 *
 * What this validates is **shape**, not meaning: `params` must be a plain JSON
 * object of sane size, and that is all. Per-strategy parameter semantics belong
 * to the engine that runs the strategy, and duplicating them here would be two
 * sources of truth that disagree the first time a strategy changes.
 */

import type { StrategyDef, StrategyDefsRepo } from '../ports/index.js';
import type { AuditWriter } from './audit.js';

/** Firestore's own document ceiling is ~1 MB; this keeps a def small and legible. */
export const MAX_PARAMS_BYTES = 8 * 1024;

export interface PatchStrategyInput {
  uid: string;
  strategyId: string;
  /** Unvalidated request body. */
  patch: unknown;
}

export type PatchStrategyResult =
  | { ok: true; def: StrategyDef }
  | { ok: false; reason: 'INVALID_PAYLOAD' | 'NOT_FOUND'; detail: string };

export interface StrategiesDeps {
  defs: StrategyDefsRepo;
  audit: AuditWriter;
}

export interface StrategiesService {
  patchStrategy(input: PatchStrategyInput): Promise<PatchStrategyResult>;
}

interface ValidPatch {
  enabled?: boolean | undefined;
  params?: Record<string, unknown> | undefined;
}

export type ValidatePatchResult = { ok: true; patch: ValidPatch } | { ok: false; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shape-only validation of the request body. Pure, so it is exhaustively tested. */
export function validateStrategyPatch(body: unknown): ValidatePatchResult {
  if (!isPlainObject(body)) return { ok: false, detail: 'body must be a JSON object' };

  const keys = Object.keys(body);
  const unknownKeys = keys.filter((k) => k !== 'enabled' && k !== 'params');
  if (unknownKeys.length > 0) {
    return { ok: false, detail: `unsupported field(s): ${unknownKeys.join(', ')}` };
  }
  if (!keys.includes('enabled') && !keys.includes('params')) {
    return { ok: false, detail: 'supply at least one of { enabled, params }' };
  }

  const out: ValidPatch = {};

  if (keys.includes('enabled')) {
    if (typeof body['enabled'] !== 'boolean') {
      return { ok: false, detail: 'enabled must be a boolean' };
    }
    out.enabled = body['enabled'];
  }

  if (keys.includes('params')) {
    const params = body['params'];
    if (!isPlainObject(params)) {
      return { ok: false, detail: 'params must be a plain JSON object (not an array or null)' };
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(params), 'utf8');
    } catch {
      return { ok: false, detail: 'params must be JSON-serialisable' };
    }
    if (bytes > MAX_PARAMS_BYTES) {
      return { ok: false, detail: `params is ${bytes} bytes, limit is ${MAX_PARAMS_BYTES}` };
    }
    out.params = params;
  }

  return { ok: true, patch: out };
}

export function createStrategiesService(deps: StrategiesDeps): StrategiesService {
  return {
    async patchStrategy(input: PatchStrategyInput): Promise<PatchStrategyResult> {
      const validated = validateStrategyPatch(input.patch);
      if (!validated.ok) {
        return { ok: false, reason: 'INVALID_PAYLOAD', detail: validated.detail };
      }

      // Defs are provisioned by the operator; a PATCH never conjures one.
      const existing = await deps.defs.get(input.uid, input.strategyId);
      if (existing === undefined) {
        return {
          ok: false,
          reason: 'NOT_FOUND',
          detail: `strategy '${input.strategyId}' does not exist`,
        };
      }

      const def = await deps.defs.patch(input.uid, input.strategyId, { ...validated.patch });
      await deps.audit.record({
        uid: input.uid,
        type: 'config.changed',
        actor: 'app-user',
        refId: input.strategyId,
        detail: { field: 'strategy', strategyId: input.strategyId, patch: validated.patch },
      });
      return { ok: true, def };
    },
  };
}
