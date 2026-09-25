/**
 * `portfolio/{uid}/…` — the cached read model (docs/03 §3.6).
 *
 * The app never calls a broker. These documents are whatever the backend last
 * wrote, and `updatedAt` is shown next to them so a stale number is visibly
 * stale rather than quietly wrong (docs/06 §6.6).
 */
import { useMemo } from 'react';
import { collection, doc, query } from 'firebase/firestore';
import {
  FundsDocSchema,
  HoldingDocSchema,
  PositionDocSchema,
  type FundsDoc,
  type HoldingDoc,
  type PositionDoc,
} from '@pm/core';
import { getDb } from '../lib/firebase';
import { useDocumentSnapshot, useQuerySnapshot, type Subscription } from './firestore';

export interface PortfolioSummary {
  /** Σ quantity × lastPrice over holdings. */
  marketValueInr: number;
  /** Σ quantity × avgCostPrice. */
  costBasisInr: number;
  /** Σ holding.pnl — the broker's own unrealised number, not ours. */
  unrealisedPnlInr: number;
  /** Σ position.realizedPnl + Σ position.unrealizedPnl — today's moves. */
  dayPnlInr: number;
  holdingsCount: number;
  positionsCount: number;
  /** Newest `updatedAt` across the slices, for the staleness label. */
  updatedAt: string | undefined;
}

export function summarise(
  holdings: readonly HoldingDoc[],
  positions: readonly PositionDoc[],
  funds: FundsDoc | undefined,
): PortfolioSummary {
  let marketValueInr = 0;
  let costBasisInr = 0;
  let unrealisedPnlInr = 0;
  for (const h of holdings) {
    marketValueInr += h.quantity * h.lastPrice;
    costBasisInr += h.quantity * h.avgCostPrice;
    unrealisedPnlInr += h.pnl;
  }
  let dayPnlInr = 0;
  for (const p of positions) dayPnlInr += p.realizedPnl + p.unrealizedPnl;

  const stamps = [
    ...holdings.map((h) => h.updatedAt),
    ...positions.map((p) => p.updatedAt),
    ...(funds === undefined ? [] : [funds.updatedAt]),
  ].sort();

  return {
    marketValueInr,
    costBasisInr,
    unrealisedPnlInr,
    dayPnlInr,
    holdingsCount: holdings.length,
    positionsCount: positions.length,
    updatedAt: stamps[stamps.length - 1],
  };
}

export interface PortfolioState {
  holdings: Subscription<HoldingDoc[]>;
  positions: Subscription<PositionDoc[]>;
  funds: Subscription<FundsDoc | undefined>;
  summary: PortfolioSummary;
  loading: boolean;
}

export function usePortfolio(uid: string | undefined): PortfolioState {
  const holdingsQuery = useMemo(
    () => (uid === undefined ? null : query(collection(getDb(), 'portfolio', uid, 'holdings'))),
    [uid],
  );
  const positionsQuery = useMemo(
    () => (uid === undefined ? null : query(collection(getDb(), 'portfolio', uid, 'positions'))),
    [uid],
  );
  const fundsRef = useMemo(
    () => (uid === undefined ? null : doc(getDb(), 'portfolio', uid, 'funds', 'current')),
    [uid],
  );

  const holdings = useQuerySnapshot(holdingsQuery, HoldingDocSchema, 'holding');
  const positions = useQuerySnapshot(positionsQuery, PositionDocSchema, 'position');
  const funds = useDocumentSnapshot(fundsRef, FundsDocSchema, 'funds');

  const summary = useMemo(
    () => summarise(holdings.data, positions.data, funds.data),
    [holdings.data, positions.data, funds.data],
  );

  return {
    holdings,
    positions,
    funds,
    summary,
    loading: holdings.loading || positions.loading || funds.loading,
  };
}
