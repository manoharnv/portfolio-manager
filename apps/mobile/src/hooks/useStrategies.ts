/**
 * `strategies/{uid}/defs/{strategyId}` — docs/03 §3.1.
 *
 * Read through a Firestore listener (the rules allow owner reads); **written
 * only through `PATCH /v1/strategies/:strategyId`**, because the same rules set
 * `allow write: if false` for the client. `@pm/core` does not model this
 * document, so the schema lives here and is deliberately forgiving about the
 * fields the engine adds.
 */
import { useCallback, useMemo, useState } from 'react';
import { collection, query } from 'firebase/firestore';
import { z } from 'zod';
import { backend } from '../lib/backend';
import { describeReason, isFailure, type StrategyPatch } from '../lib/api';
import { getDb } from '../lib/firebase';
import { useQuerySnapshot, type Subscription } from './firestore';

export const StrategyDefSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type StrategyDef = z.infer<typeof StrategyDefSchema>;

export interface StrategiesState extends Subscription<StrategyDef[]> {
  /** Server values with any in-flight optimistic change applied. */
  defs: StrategyDef[];
  /** Which strategy has a request in flight, if any. */
  pending: string | undefined;
  /** The last failure, already humanised. */
  error: string | undefined;
  patch: (strategyId: string, patch: StrategyPatch) => Promise<boolean>;
}

export function useStrategies(uid: string | undefined): StrategiesState {
  const q = useMemo(() => {
    if (uid === undefined) return null;
    return query(collection(getDb(), 'strategies', uid, 'defs'));
  }, [uid]);

  const snapshot = useQuerySnapshot(q, StrategyDefSchema, 'strategy');
  const [optimistic, setOptimistic] = useState<Record<string, StrategyPatch>>({});
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  /**
   * Optimistic, with rollback: the override is applied immediately and dropped
   * again the moment the route answers — success leaves the listener's own
   * value in place, failure restores it and says why.
   */
  const patch = useCallback(async (strategyId: string, change: StrategyPatch) => {
    setOptimistic((prev) => ({ ...prev, [strategyId]: { ...prev[strategyId], ...change } }));
    setPending(strategyId);
    setFailure(undefined);

    const result = await backend().patchStrategy(strategyId, change);
    setPending(undefined);
    setOptimistic((prev) => {
      const { [strategyId]: _dropped, ...rest } = prev;
      return rest;
    });

    if (isFailure(result)) {
      setFailure(
        result.reason === 'NOT_FOUND'
          ? `No strategy "${strategyId}" on the backend — it may have been removed.`
          : `${describeReason(result.reason).title}: ${result.detail}`,
      );
      return false;
    }
    return true;
  }, []);

  const defs = useMemo(
    () =>
      snapshot.data
        .map((def) => {
          const override = optimistic[def.id];
          return override === undefined
            ? def
            : {
                ...def,
                ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
                ...(override.params === undefined ? {} : { params: override.params }),
              };
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
    [snapshot.data, optimistic],
  );

  return {
    ...snapshot,
    defs,
    pending,
    error: failure ?? snapshot.error,
    patch,
  };
}
