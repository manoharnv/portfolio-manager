/**
 * The live LTP the approval screen collars against — `GET /v1/quotes`.
 *
 * Three rules, all of them safety rules (docs/00 §0.7.1, docs/06 §6.6):
 *
 *   1. **Poll only while the screen is focused.** A backgrounded proposal
 *      screen must not keep hitting the broker's quote API; `enabled` goes
 *      false on blur and the interval is torn down.
 *   2. **A stale quote is not a quote.** Older than `QUOTE_MAX_AGE_SECONDS`
 *      (30 s, measured against the quote's own `ts`) ⇒ `ltp` is `undefined`,
 *      which blocks approval. The last value is still exposed as `cachedLtp`
 *      so the screen can say "₹1,500 (stale)" rather than showing nothing.
 *   3. **A failed fetch is not a price.** The previous quote keeps ageing out;
 *      it is never refreshed from a failure.
 *
 * Unlike the portfolio-cache version this replaces, a symbol the account does
 * not already hold quotes fine — a BUY of a new symbol is approvable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanonicalSymbol, Quote } from '@pm/core';
import { backend } from '../lib/backend';
import { describeReason, isFailure } from '../lib/api';

/** docs/06 §6.3 — "tap within seconds" on the day-trade book. */
export const QUOTE_POLL_MS = 5_000;
/** Older than this and the app treats the price as absent. */
export const QUOTE_MAX_AGE_SECONDS = 30;

export function symbolKeyOf(symbol: CanonicalSymbol): string {
  return `${symbol.exchange}:${symbol.segment}:${symbol.tradingSymbol}`;
}

export interface LiveQuote {
  /** `undefined` whenever there is no *usable* price — never a stale fallback. */
  ltp: number | undefined;
  /** The last price received, even once stale, for the "last seen" label. */
  cachedLtp: number | undefined;
  /** The whole quote, for open/high/low context. */
  quote: Quote | undefined;
  ageSeconds: number | undefined;
  stale: boolean;
  refreshing: boolean;
  /** Why the last fetch failed, already humanised. */
  error: string | undefined;
  refresh: () => Promise<void>;
}

export interface UseLiveQuoteOptions {
  pollMs?: number | undefined;
  maxAgeSeconds?: number | undefined;
  /** False while the screen is blurred, or for a read-only proposal. */
  enabled?: boolean | undefined;
}

/** Picks the quote for `symbol` out of a batch response. */
export function matchQuote(symbol: CanonicalSymbol, quotes: readonly Quote[]): Quote | undefined {
  const key = symbolKeyOf(symbol);
  return quotes.find((q) => symbolKeyOf(q.symbol) === key && q.ltp > 0);
}

export function quoteAgeSeconds(quote: Quote, nowMs: number): number | undefined {
  const at = new Date(quote.ts).getTime();
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (nowMs - at) / 1000);
}

export function useLiveQuote(
  symbol: CanonicalSymbol | undefined,
  options: UseLiveQuoteOptions = {},
): LiveQuote {
  const pollMs = options.pollMs ?? QUOTE_POLL_MS;
  const maxAge = options.maxAgeSeconds ?? QUOTE_MAX_AGE_SECONDS;
  const enabled = (options.enabled ?? true) && symbol !== undefined;

  const [quote, setQuote] = useState<Quote | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(() => Date.now());

  // The key, not the object: a new `{exchange,…}` literal on every render must
  // not restart the poll.
  const key = symbol === undefined ? undefined : symbolKeyOf(symbol);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  const refresh = useCallback(async () => {
    const current = symbolRef.current;
    if (current === undefined) return;
    setRefreshing(true);
    const result = await backend().quotes([symbolKeyOf(current)]);
    setRefreshing(false);
    setTick(Date.now());
    if (isFailure(result)) {
      // Leave the previous quote in place — it keeps ageing out on its own.
      setError(`${describeReason(result.reason).title}: ${result.detail}`);
      return;
    }
    const match = matchQuote(current, result.quotes);
    setError(match === undefined ? 'the backend returned no quote for this symbol' : undefined);
    if (match !== undefined) setQuote(match);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const poll = setInterval(() => void refresh(), pollMs);
    // A separate 1 s tick so `ageSeconds` counts up between polls and a quote
    // goes stale on screen even if the backend stops answering.
    const age = setInterval(() => setTick(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(age);
    };
  }, [enabled, key, pollMs, refresh]);

  // A different symbol must never inherit the previous symbol's price.
  useEffect(() => {
    setQuote(undefined);
    setError(undefined);
  }, [key]);

  const ageSeconds = useMemo(
    () => (quote === undefined ? undefined : quoteAgeSeconds(quote, tick)),
    [quote, tick],
  );
  const stale = ageSeconds === undefined || ageSeconds > maxAge;

  return {
    ltp: stale ? undefined : quote?.ltp,
    cachedLtp: quote?.ltp,
    quote,
    ageSeconds,
    stale,
    refreshing,
    error,
    refresh,
  };
}
