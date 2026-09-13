/**
 * The "live" LTP the approval screen collars against.
 *
 * The backend exposes **no quote route** today (see the route table in
 * apps/backend/src/http/app.ts) — the only price the app can legitimately get
 * is the one the backend caches while refreshing the portfolio. So this hook:
 *
 *   1. seeds from `portfolio/{uid}/{holdings,positions}` (Firestore, realtime),
 *   2. polls `GET /v1/portfolio/holdings` + `/positions`, which makes the
 *      backend re-pull from the broker and rewrite that cache,
 *   3. reports the quote's **age**, so a stale price is visibly stale.
 *
 * `fresh` is what the gate uses. A price older than `maxAgeSeconds` is not a
 * quote — docs/06 §6.6, "approve gated on a fresh quote", docs/00 §0.7.1.
 *
 * VERIFY-LIVE: if a `GET /v1/quote/:symbolKey` route is ever added, point this
 * at it; the rest of the screen does not change.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CanonicalSymbol } from '@pm/core';
import { backend } from '../lib/backend';
import { isFailure } from '../lib/api';
import type { HoldingDoc, PositionDoc } from '@pm/core';

export const QUOTE_POLL_MS = 20_000;
/** Older than this and the app treats the price as absent. */
export const QUOTE_MAX_AGE_SECONDS = 120;

export function symbolKeyOf(symbol: CanonicalSymbol): string {
  return `${symbol.exchange}:${symbol.segment}:${symbol.tradingSymbol}`;
}

export interface LiveQuote {
  /** `undefined` whenever there is no *usable* price — never a stale fallback. */
  ltp: number | undefined;
  /** The raw cached price even when stale, for the "last seen" label. */
  cachedLtp: number | undefined;
  ageSeconds: number | undefined;
  stale: boolean;
  refreshing: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
}

/** Picks the newest cached price for a symbol out of the portfolio read model. */
export function priceFromCache(
  symbol: CanonicalSymbol,
  holdings: readonly HoldingDoc[],
  positions: readonly PositionDoc[],
): { ltp: number; at: string } | undefined {
  const key = symbolKeyOf(symbol);
  const candidates: { ltp: number; at: string }[] = [];
  for (const h of holdings) {
    if (h.symbolKey === key && h.lastPrice > 0)
      candidates.push({ ltp: h.lastPrice, at: h.updatedAt });
  }
  for (const p of positions) {
    if (p.symbolKey === key && p.lastPrice > 0)
      candidates.push({ ltp: p.lastPrice, at: p.updatedAt });
  }
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

export interface UseLiveQuoteOptions {
  holdings: readonly HoldingDoc[];
  positions: readonly PositionDoc[];
  pollMs?: number | undefined;
  maxAgeSeconds?: number | undefined;
  /** Off for a read-only/expired proposal — no point hammering the broker. */
  enabled?: boolean | undefined;
}

export function useLiveQuote(
  symbol: CanonicalSymbol | undefined,
  options: UseLiveQuoteOptions,
): LiveQuote {
  const pollMs = options.pollMs ?? QUOTE_POLL_MS;
  const maxAge = options.maxAgeSeconds ?? QUOTE_MAX_AGE_SECONDS;
  const enabled = options.enabled ?? true;

  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(() => Date.now());

  const cached = useMemo(
    () =>
      symbol === undefined
        ? undefined
        : priceFromCache(symbol, options.holdings, options.positions),
    [symbol, options.holdings, options.positions],
  );

  const refresh = useCallback(async () => {
    if (symbol === undefined) return;
    setRefreshing(true);
    const [holdings, positions] = await Promise.all([backend().holdings(), backend().positions()]);
    const failed = isFailure(holdings) && isFailure(positions);
    setError(failed ? (isFailure(holdings) ? holdings.detail : undefined) : undefined);
    setRefreshing(false);
    setTick(Date.now());
  }, [symbol]);

  useEffect(() => {
    if (!enabled || symbol === undefined) return;
    void refresh();
    const poll = setInterval(() => void refresh(), pollMs);
    // Separate, faster tick so `ageSeconds` counts up between polls.
    const age = setInterval(() => setTick(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(age);
    };
  }, [enabled, symbol, pollMs, refresh]);

  const ageSeconds = useMemo(() => {
    if (cached === undefined) return undefined;
    const at = new Date(cached.at).getTime();
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, (tick - at) / 1000);
  }, [cached, tick]);

  const stale = ageSeconds === undefined || ageSeconds > maxAge;

  return {
    ltp: stale ? undefined : cached?.ltp,
    cachedLtp: cached?.ltp,
    ageSeconds,
    stale,
    refreshing,
    error,
    refresh,
  };
}
