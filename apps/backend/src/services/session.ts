/**
 * Broker session lifecycle — docs/04 §4.6, docs/02 §2.8.
 *
 * The backend owns the credentials end-to-end, and for BOTH brokers the daily
 * login finishes on this backend, never in the app:
 *
 *   1. `loginUrl` starts a login and remembers it as *the* pending login. Dhan:
 *      a consent is generated with the api key/secret. Kite: a `state` nonce
 *      is minted and carried in Kite's `redirect_params`.
 *   2. The user signs in on the broker's own page in the system browser.
 *   3. The broker redirects to `GET /v1/auth/:broker/redirect` here —
 *      `completeRedirect` — which exchanges what the redirect carries
 *      (`tokenId` / `request_token`) for the day's access token, checks the
 *      account that signed in is the configured one, stores the token, and the
 *      route bounces the browser to the app with a status.
 *
 * That redirect is unauthenticated by nature (the broker's page sends it), so
 * it is honoured only while a login this backend itself started is pending,
 * within a short TTL, and — for Kite — with the state nonce echoed back.
 *
 * `completeLogin` (`POST /v1/auth/kite/callback`) remains for a client that
 * received Kite's `request_token` directly; Dhan tokens are never accepted
 * from a client. The daily access token goes straight to Secret Manager;
 * Firestore only ever sees the expiry. After a login the strategy engine's
 * read-creds secret is brought up to date too (services/strategy-creds.ts).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { IsoDateTimeSchema } from '@pm/core';
import type { Broker, SessionStatus } from '@pm/core';
import type { BrokerSession } from '@pm/core';
import { consumeConsent, generateConsent } from '@pm/broker-dhan';
import type { HttpClient as DhanHttpClient } from '@pm/broker-dhan';
import { exchangeRequestToken, loginUrl as kiteLoginUrl } from '@pm/broker-kite';
import type { HttpClient } from '@pm/broker-kite';
import type { BrokerSecretNames } from '../config.js';
import type { Logger } from '../logger.js';
import { sessionRefusal, toSessionStatus } from '../session-status.js';
import type { Clock, SecretStore, SessionStore } from '../ports/index.js';
import type { AuditWriter } from './audit.js';
import type { StrategyCredsSync } from './strategy-creds.js';

export const BROKERS: readonly Broker[] = ['dhan', 'kite'];

/**
 * How long a started login stays redeemable. Long enough for a login + OTP on
 * a slow evening, short enough that a stale consent or request token cannot
 * be replayed against this backend a day later.
 */
export const LOGIN_TTL_MS = 15 * 60 * 1000;

export interface BrokerSessionView extends SessionStatus {
  /** `true` when an order placed right now would be refused for session reasons. */
  needsLogin: boolean;
  /** Why it would be refused; `null` when the session is usable. */
  reason: string | null;
}

export type SessionStatusResult = {
  ok: true;
  activeBroker: Broker | null;
  brokers: BrokerSessionView[];
};

export type LoginUrlResult =
  | { ok: true; broker: Broker; url: string; verifyLive: boolean }
  | { ok: false; reason: 'SECRET_MISSING' | 'CONSENT_FAILED'; detail: string };

export type CompleteLoginResult =
  | { ok: true; broker: Broker; connected: true; expiresAt: string }
  | {
      ok: false;
      reason: 'INVALID_PAYLOAD' | 'SECRET_MISSING' | 'EXCHANGE_FAILED' | 'NOT_SUPPORTED';
      detail: string;
    };

/** The broker's redirect, query string as key → first value. */
export type RedirectQuery = Readonly<Record<string, string | undefined>>;

export type RedirectResult =
  | { ok: true; broker: Broker; uid: string; connected: true; expiresAt: string }
  | {
      ok: false;
      reason:
        | 'NO_PENDING_LOGIN'
        | 'INVALID_REQUEST'
        | 'STATE_MISMATCH'
        | 'SECRET_MISSING'
        | 'EXCHANGE_FAILED'
        | 'CLIENT_MISMATCH';
      detail: string;
    };

/** A login this backend started and has not yet seen come back. */
export interface PendingLogin {
  uid: string;
  broker: Broker;
  /** Nonce; carried through Kite's `redirect_params`, kept private for Dhan. */
  state: string;
  /** ISO — when `loginUrl` started it. */
  startedAt: string;
}

/**
 * One slot, not a map: Dhan's redirect carries no state parameter that could
 * pick a uid, so at most one login may be in flight, and it belongs to the
 * uid that started it. Memory-only on purpose — a restart mid-login simply
 * means "tap Connect again".
 */
export interface PendingLoginStore {
  get(): PendingLogin | undefined;
  set(pending: PendingLogin): void;
  clear(): void;
}

export function createMemoryPendingLoginStore(): PendingLoginStore {
  let slot: PendingLogin | undefined;
  return {
    get: () => slot,
    set: (pending) => {
      slot = pending;
    },
    clear: () => {
      slot = undefined;
    },
  };
}

const KiteCallbackSchema = z.object({ requestToken: z.string().min(1) });
/** Kept only to give a precise refusal to a client still using the old shape. */
const LegacyDhanCallbackSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: IsoDateTimeSchema.optional(),
});

export interface SessionDeps {
  secrets: SecretStore;
  sessions: SessionStore;
  audit: AuditWriter;
  clock: Clock;
  /** Kite transport. */
  http: HttpClient;
  /** Dhan transport (auth.dhan.co). */
  dhanHttp: DhanHttpClient;
  secretNames: { dhan: BrokerSecretNames; kite: BrokerSecretNames };
  /** Used to report which broker the session checks are graded against. */
  activeBrokerFor(uid: string): Promise<Broker | undefined>;
  /**
   * The Zerodha client id a Kite login must belong to (`KITE_USER_ID`). Blank
   * ⇒ any account that completes the login is accepted, with a warning.
   */
  kiteUserId?: string | undefined;
  /** Keeps the strategy engine's read-creds secret current; optional in tests. */
  strategyCreds?: StrategyCredsSync | undefined;
  pendingLogin?: PendingLoginStore | undefined;
  /** State nonce source; injected in tests. */
  nonce?: (() => string) | undefined;
  logger?: Logger | undefined;
  /** Overrides Kite's base URL in tests. */
  kiteBaseUrl?: string | undefined;
  /** Overrides Dhan's auth host in tests. */
  dhanAuthBaseUrl?: string | undefined;
}

export interface SessionService {
  status(uid: string): Promise<SessionStatusResult>;
  loginUrl(uid: string, broker: Broker): Promise<LoginUrlResult>;
  completeLogin(uid: string, broker: Broker, payload: unknown): Promise<CompleteLoginResult>;
  /** `GET /v1/auth/:broker/redirect` — the broker's browser redirect. */
  completeRedirect(broker: Broker, query: RedirectQuery): Promise<RedirectResult>;
}

type SecretMissing = { ok: false; reason: 'SECRET_MISSING'; detail: string };

export function createSessionService(deps: SessionDeps): SessionService {
  const names = (broker: Broker): BrokerSecretNames => deps.secretNames[broker];
  const pending = deps.pendingLogin ?? createMemoryPendingLoginStore();
  const nonce = deps.nonce ?? ((): string => randomUUID());

  /** All named secrets, or one SECRET_MISSING naming the absent ones. */
  async function requireSecrets<K extends string>(
    wanted: Record<K, string>,
  ): Promise<Record<K, string> | SecretMissing> {
    const out = {} as Record<K, string>;
    const missing: string[] = [];
    for (const [key, name] of Object.entries(wanted) as [K, string][]) {
      const secret = await deps.secrets.get(name);
      if (secret === undefined || secret.value === '') missing.push(name);
      else out[key] = secret.value;
    }
    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'SECRET_MISSING',
        detail: `secret${missing.length > 1 ? 's' : ''} '${missing.join("', '")}' not set`,
      };
    }
    return out;
  }

  /** Token → Secret Manager; expiry → Firestore + audit; engine creds → in step. */
  async function persistLogin(
    uid: string,
    broker: Broker,
    accessToken: string,
    expiresAt: string,
    engineCreds: { dhan?: { clientId: string } | undefined; kite?: { apiKey: string } | undefined },
  ): Promise<void> {
    const now = deps.clock.now();
    await deps.secrets.set(names(broker).accessToken, { value: accessToken, expiresAt });
    const session: BrokerSession = {
      broker,
      connected: true,
      expiresAt,
      staticIpOk: true,
      lastConnectedAt: now.toISOString(),
    };
    await deps.sessions.set(uid, session);
    await deps.audit.record({
      uid,
      type: 'session.connected',
      refId: broker,
      detail: { broker, expiresAt },
    });
    if (deps.strategyCreds !== undefined) {
      const activeBroker = await deps.activeBrokerFor(uid);
      const outcome = await deps.strategyCreds.update({
        broker,
        activeBroker,
        ...(engineCreds.dhan === undefined
          ? {}
          : { dhan: { clientId: engineCreds.dhan.clientId, accessToken, expiresAt } }),
        ...(engineCreds.kite === undefined
          ? {}
          : { kite: { apiKey: engineCreds.kite.apiKey, accessToken, expiresAt } }),
      });
      deps.logger?.info({ broker, outcome }, 'strategy read-creds sync');
    }
  }

  async function exchangeKite(
    requestToken: string,
  ): Promise<
    | { ok: true; apiKey: string; accessToken: string; userId: string; expiresAt: string }
    | SecretMissing
    | { ok: false; reason: 'EXCHANGE_FAILED'; detail: string }
  > {
    const got = await requireSecrets({
      apiKey: names('kite').apiKey,
      apiSecret: names('kite').apiSecret,
    });
    if ('ok' in got) return got;
    try {
      const exchanged = await exchangeRequestToken(
        deps.http,
        { apiKey: got.apiKey, apiSecret: got.apiSecret, requestToken },
        deps.clock.now(),
        deps.kiteBaseUrl,
      );
      return {
        ok: true,
        apiKey: got.apiKey,
        accessToken: exchanged.accessToken,
        userId: exchanged.userId,
        expiresAt: exchanged.expiresAt,
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'EXCHANGE_FAILED',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function completeKiteRedirect(
    inFlight: PendingLogin,
    query: RedirectQuery,
  ): Promise<RedirectResult> {
    const requestToken = query['request_token'] ?? query['requestToken'];
    if (requestToken === undefined || requestToken === '') {
      return {
        ok: false,
        reason: 'INVALID_REQUEST',
        detail: 'Kite redirected without a request_token — tap Connect and try again',
      };
    }
    // Only Kite's own redirect of THIS login echoes the nonce. A forged hit
    // must not spend the genuine pending login, so nothing is cleared here.
    if (query['state'] !== inFlight.state) {
      deps.logger?.warn({ broker: 'kite' }, 'kite redirect without the expected state nonce');
      return {
        ok: false,
        reason: 'STATE_MISMATCH',
        detail: 'the Kite redirect did not belong to the login this app started',
      };
    }

    const exchanged = await exchangeKite(requestToken);
    if (!exchanged.ok) return exchanged;

    const expected = deps.kiteUserId ?? '';
    if (expected === '') {
      deps.logger?.warn(
        { userId: exchanged.userId },
        'KITE_USER_ID is not set — accepting whichever Zerodha account completed the login',
      );
    } else if (exchanged.userId !== expected) {
      pending.clear();
      deps.logger?.warn(
        { expected, got: exchanged.userId },
        'kite login completed by a different Zerodha account — refused',
      );
      return {
        ok: false,
        reason: 'CLIENT_MISMATCH',
        detail: 'the Zerodha account that signed in is not the one configured for this backend',
      };
    }

    pending.clear();
    await persistLogin(inFlight.uid, 'kite', exchanged.accessToken, exchanged.expiresAt, {
      kite: { apiKey: exchanged.apiKey },
    });
    return {
      ok: true,
      broker: 'kite',
      uid: inFlight.uid,
      connected: true,
      expiresAt: exchanged.expiresAt,
    };
  }

  async function completeDhanRedirect(
    inFlight: PendingLogin,
    query: RedirectQuery,
    now: Date,
  ): Promise<RedirectResult> {
    const tokenId = query['tokenId'];
    if (tokenId === undefined || tokenId === '') {
      return {
        ok: false,
        reason: 'INVALID_REQUEST',
        detail: 'Dhan redirected without a tokenId — tap Connect and try again',
      };
    }

    const got = await requireSecrets({
      apiKey: names('dhan').apiKey,
      apiSecret: names('dhan').apiSecret,
      clientId: names('dhan').clientId,
    });
    if ('ok' in got) return got;

    let consumed;
    try {
      consumed = await consumeConsent(
        deps.dhanHttp,
        { apiKey: got.apiKey, apiSecret: got.apiSecret },
        tokenId,
        { authBaseUrl: deps.dhanAuthBaseUrl, now },
      );
    } catch (err) {
      // The consent (if it was one) is spent either way; the pending slot
      // stays so a genuine retry within the TTL still works.
      return {
        ok: false,
        reason: 'EXCHANGE_FAILED',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // A consent is generated for the configured client id, but never trust
    // that alone: the account that actually signed in must be that client.
    if (consumed.clientId !== got.clientId) {
      pending.clear();
      deps.logger?.warn(
        { expected: got.clientId, got: consumed.clientId },
        'dhan consent completed by a different client id — refused',
      );
      return {
        ok: false,
        reason: 'CLIENT_MISMATCH',
        detail: 'the Dhan account that signed in is not the one configured for this backend',
      };
    }

    pending.clear();
    await persistLogin(inFlight.uid, 'dhan', consumed.accessToken, consumed.expiresAt, {
      dhan: { clientId: consumed.clientId },
    });
    return {
      ok: true,
      broker: 'dhan',
      uid: inFlight.uid,
      connected: true,
      expiresAt: consumed.expiresAt,
    };
  }

  return {
    async status(uid: string): Promise<SessionStatusResult> {
      const now = deps.clock.now();
      const active = (await deps.activeBrokerFor(uid)) ?? null;
      const brokers: BrokerSessionView[] = [];
      for (const broker of BROKERS) {
        const stored = await deps.sessions.get(uid, broker);
        const status: SessionStatus =
          stored === undefined
            ? { broker, connected: false, staticIpOk: false }
            : toSessionStatus(stored);
        const reason = sessionRefusal(status, broker, now) ?? null;
        brokers.push({ ...status, needsLogin: reason !== null, reason });
      }
      return { ok: true, activeBroker: active, brokers };
    },

    async loginUrl(uid: string, broker: Broker): Promise<LoginUrlResult> {
      const state = nonce();
      const startedAt = deps.clock.now().toISOString();

      if (broker === 'kite') {
        const got = await requireSecrets({ apiKey: names('kite').apiKey });
        if ('ok' in got) return got;
        pending.set({ uid, broker, state, startedAt });
        return {
          ok: true,
          broker,
          url: kiteLoginUrl(got.apiKey, { redirectParams: { state } }),
          verifyLive: false,
        };
      }

      const got = await requireSecrets({
        apiKey: names('dhan').apiKey,
        apiSecret: names('dhan').apiSecret,
        clientId: names('dhan').clientId,
      });
      if ('ok' in got) return got;
      try {
        const started = await generateConsent(
          deps.dhanHttp,
          { apiKey: got.apiKey, apiSecret: got.apiSecret },
          got.clientId,
          { authBaseUrl: deps.dhanAuthBaseUrl },
        );
        pending.set({ uid, broker, state, startedAt });
        return { ok: true, broker, url: started.loginUrl, verifyLive: false };
      } catch (err) {
        return {
          ok: false,
          reason: 'CONSENT_FAILED',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async completeLogin(
      uid: string,
      broker: Broker,
      payload: unknown,
    ): Promise<CompleteLoginResult> {
      if (broker === 'dhan') {
        // Nothing the app could carry here is acceptable: a token would mean the
        // app saw it (docs/06 §6.7). The login finishes on the redirect route.
        const legacy = LegacyDhanCallbackSchema.safeParse(payload);
        return {
          ok: false,
          reason: 'NOT_SUPPORTED',
          detail: legacy.success
            ? 'Dhan tokens are never accepted from a client — the login completes on GET /v1/auth/dhan/redirect'
            : 'Dhan logins complete on GET /v1/auth/dhan/redirect; nothing is posted here',
        };
      }

      const parsed = KiteCallbackSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'expected { requestToken }' };
      }
      const exchanged = await exchangeKite(parsed.data.requestToken);
      if (!exchanged.ok) return exchanged;

      await persistLogin(uid, 'kite', exchanged.accessToken, exchanged.expiresAt, {
        kite: { apiKey: exchanged.apiKey },
      });
      return { ok: true, broker, connected: true, expiresAt: exchanged.expiresAt };
    },

    async completeRedirect(broker: Broker, query: RedirectQuery): Promise<RedirectResult> {
      const now = deps.clock.now();
      const inFlight = pending.get();
      if (inFlight === undefined || inFlight.broker !== broker) {
        return {
          ok: false,
          reason: 'NO_PENDING_LOGIN',
          detail: `no ${broker} login was started from the app — tap Connect and try again`,
        };
      }
      if (now.getTime() - Date.parse(inFlight.startedAt) > LOGIN_TTL_MS) {
        pending.clear();
        return {
          ok: false,
          reason: 'NO_PENDING_LOGIN',
          detail: `the ${broker} login took too long — tap Connect and try again`,
        };
      }
      return broker === 'kite'
        ? completeKiteRedirect(inFlight, query)
        : completeDhanRedirect(inFlight, query, now);
    },
  };
}
