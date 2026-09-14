/**
 * Broker session lifecycle — docs/04 §4.6, docs/02 §2.8.
 *
 * The backend owns the credentials end-to-end.
 *
 * Kite: the app opens the connect URL, Kite redirects into the app with a
 * short-lived `request_token`, the app POSTs it to `/v1/auth/kite/callback`
 * and the exchange with the api_secret happens here.
 *
 * Dhan: nothing passes through the app at all. `loginUrl` generates a consent
 * with the api key/secret; the user signs in on Dhan's page in the system
 * browser; Dhan redirects **to this backend** (`GET /v1/auth/dhan/redirect
 * ?tokenId=…`), which consumes the consent (`completeDhanRedirect`), checks the
 * account is the configured one, and only then bounces the browser to the app
 * with a status. That redirect is unauthenticated by nature (it is Dhan's page,
 * not the app, that sends it), so it is only honoured while a login this
 * backend itself started is pending.
 *
 * Either way the daily access token goes straight to Secret Manager; Firestore
 * only ever sees the expiry. After a login the strategy engine's read-creds
 * secret is brought up to date too (services/strategy-creds.ts).
 */

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
 * How long a started Dhan login stays redeemable. Long enough for a login +
 * OTP on a slow evening, short enough that a stale consent cannot be replayed
 * against this backend a day later.
 */
export const DHAN_CONSENT_TTL_MS = 15 * 60 * 1000;

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

export type DhanRedirectResult =
  | { ok: true; broker: 'dhan'; uid: string; connected: true; expiresAt: string }
  | {
      ok: false;
      reason: 'NO_PENDING_LOGIN' | 'SECRET_MISSING' | 'EXCHANGE_FAILED' | 'CLIENT_MISMATCH';
      detail: string;
    };

/** A Dhan login this backend started and has not yet seen come back. */
export interface PendingConsent {
  uid: string;
  consentAppId: string;
  /** ISO — when `loginUrl` generated it. */
  startedAt: string;
}

/**
 * One slot, not a map: Dhan's redirect carries no state parameter that could
 * pick a uid, so at most one login may be in flight, and it belongs to the
 * uid that started it. Memory-only on purpose — a restart mid-login simply
 * means "tap Connect again".
 */
export interface PendingConsentStore {
  get(): PendingConsent | undefined;
  set(pending: PendingConsent): void;
  clear(): void;
}

export function createMemoryPendingConsentStore(): PendingConsentStore {
  let slot: PendingConsent | undefined;
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
  /** Keeps the strategy engine's read-creds secret current; optional in tests. */
  strategyCreds?: StrategyCredsSync | undefined;
  pendingConsent?: PendingConsentStore | undefined;
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
  /** `GET /v1/auth/dhan/redirect?tokenId=…` — Dhan's browser redirect. */
  completeDhanRedirect(tokenId: string): Promise<DhanRedirectResult>;
}

type SecretMissing = { ok: false; reason: 'SECRET_MISSING'; detail: string };

export function createSessionService(deps: SessionDeps): SessionService {
  const names = (broker: Broker): BrokerSecretNames => deps.secretNames[broker];
  const pending = deps.pendingConsent ?? createMemoryPendingConsentStore();

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
      if (broker === 'kite') {
        const got = await requireSecrets({ apiKey: names('kite').apiKey });
        if ('ok' in got) return got;
        return { ok: true, broker, url: kiteLoginUrl(got.apiKey), verifyLive: false };
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
        pending.set({
          uid,
          consentAppId: started.consentAppId,
          startedAt: deps.clock.now().toISOString(),
        });
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
      const got = await requireSecrets({
        apiKey: names('kite').apiKey,
        apiSecret: names('kite').apiSecret,
      });
      if ('ok' in got) return got;

      let accessToken: string;
      let expiresAt: string;
      try {
        const exchanged = await exchangeRequestToken(
          deps.http,
          { apiKey: got.apiKey, apiSecret: got.apiSecret, requestToken: parsed.data.requestToken },
          deps.clock.now(),
          deps.kiteBaseUrl,
        );
        accessToken = exchanged.accessToken;
        expiresAt = exchanged.expiresAt;
      } catch (err) {
        return {
          ok: false,
          reason: 'EXCHANGE_FAILED',
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      await persistLogin(uid, 'kite', accessToken, expiresAt, { kite: { apiKey: got.apiKey } });
      return { ok: true, broker, connected: true, expiresAt };
    },

    async completeDhanRedirect(tokenId: string): Promise<DhanRedirectResult> {
      const now = deps.clock.now();
      const inFlight = pending.get();
      if (inFlight === undefined) {
        return {
          ok: false,
          reason: 'NO_PENDING_LOGIN',
          detail: 'no Dhan login was started from the app — tap Connect and try again',
        };
      }
      if (now.getTime() - Date.parse(inFlight.startedAt) > DHAN_CONSENT_TTL_MS) {
        pending.clear();
        return {
          ok: false,
          reason: 'NO_PENDING_LOGIN',
          detail: 'the Dhan login took too long — tap Connect and try again',
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
    },
  };
}
