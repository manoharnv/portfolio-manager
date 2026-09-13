/**
 * One shared subscription set for the whole app.
 *
 * Seven screens all want the same handful of documents (config, books,
 * portfolio, pending proposals, broker session). Subscribing once here rather
 * than per-screen keeps a single source of truth for "can anything be approved
 * right now?" and avoids four listeners racing on the same document.
 *
 * Tests render `<AppContext.Provider value={fixture}>` directly, so screens
 * never need a live Firestore to be exercised.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import type {
  Book,
  BrokerSession,
  Config,
  FundsDoc,
  HoldingDoc,
  PositionDoc,
  Proposal,
} from '@pm/core';
import type { SessionPayload } from './lib/api';
import { useSession } from './hooks/useSession';
import { useConfig, type ConfigPatch } from './hooks/useConfig';
import { useBooks } from './hooks/useBooks';
import { useBackendSession, useBrokerSessionDocs } from './hooks/useBrokerSessions';
import { usePortfolio, summarise, type PortfolioSummary } from './hooks/usePortfolio';
import { usePendingProposals } from './hooks/useProposals';

export interface AppState {
  uid: string | undefined;
  user: User | null;
  authReady: boolean;

  config: Config | undefined;
  /** `min(config, ABS_*)` — what the backend will really enforce. */
  effectiveConfig: Config | undefined;
  configError: string | undefined;
  updateConfig: (patch: ConfigPatch, now: Date) => Promise<void>;

  session: SessionPayload | undefined;
  sessionError: string | undefined;
  /** false ⇒ "execution unavailable" (docs/06 §6.6). */
  backendReachable: boolean;
  refreshSession: () => Promise<void>;
  brokerDocs: BrokerSession[];

  books: Book[];
  holdings: HoldingDoc[];
  positions: PositionDoc[];
  funds: FundsDoc | undefined;
  portfolioSummary: PortfolioSummary;

  pendingProposals: Proposal[];
  pendingError: string | undefined;
}

export const AppContext = createContext<AppState | undefined>(undefined);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (value === undefined) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const auth = useSession();
  const config = useConfig(auth.uid);
  const books = useBooks(auth.uid);
  const brokerDocs = useBrokerSessionDocs(auth.uid);
  const backendSession = useBackendSession(auth.uid);
  const portfolio = usePortfolio(auth.uid);
  const pending = usePendingProposals(auth.uid);

  const value = useMemo<AppState>(
    () => ({
      uid: auth.uid,
      user: auth.user,
      authReady: auth.ready,

      config: config.data,
      effectiveConfig: config.effective,
      configError: auth.configError ?? config.error,
      updateConfig: config.update,

      session: backendSession.session,
      sessionError: backendSession.error,
      backendReachable: backendSession.reachable,
      refreshSession: backendSession.refresh,
      brokerDocs: brokerDocs.data,

      books: books.data,
      holdings: portfolio.holdings.data,
      positions: portfolio.positions.data,
      funds: portfolio.funds.data,
      portfolioSummary: portfolio.summary,

      pendingProposals: pending.data,
      pendingError: pending.error,
    }),
    [auth, config, books.data, brokerDocs.data, backendSession, portfolio, pending],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** A complete, inert state — the base every test fixture spreads over. */
export function emptyAppState(overrides: Partial<AppState> = {}): AppState {
  return {
    uid: undefined,
    user: null,
    authReady: true,
    config: undefined,
    effectiveConfig: undefined,
    configError: undefined,
    updateConfig: async () => undefined,
    session: undefined,
    sessionError: undefined,
    backendReachable: true,
    refreshSession: async () => undefined,
    brokerDocs: [],
    books: [],
    holdings: [],
    positions: [],
    funds: undefined,
    portfolioSummary: summarise([], [], undefined),
    pendingProposals: [],
    pendingError: undefined,
    ...overrides,
  };
}
