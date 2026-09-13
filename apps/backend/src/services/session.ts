/**
 * Broker session lifecycle — docs/04 §4.6, docs/02 §2.8.
 *
 * The backend owns the credentials end-to-end: the app carries only a
 * short-lived `request_token`/consent here, and what comes back is metadata
 * (`connected`, `expiresAt`) — never a token. The daily access token goes
 * straight to Secret Manager; Firestore only ever sees the expiry.
 */

import { z } from 'zod';
import { IsoDateTimeSchema } from '@pm/core';
import type { Broker, SessionStatus } from '@pm/core';
import type { BrokerSession } from '@pm/core';
import { exchangeRequestToken, loginUrl as kiteLoginUrl } from '@pm/broker-kite';
import type { HttpClient } from '@pm/broker-kite';
import type { BrokerSecretNames } from '../config.js';
import { sessionRefusal, toSessionStatus } from '../session-status.js';
import type { Clock, SecretStore, SessionStore } from '../ports/index.js';
import type { AuditWriter } from './audit.js';

export const BROKERS: readonly Broker[] = ['dhan', 'kite'];

/**
 * VERIFY-LIVE: Dhan's interactive consent URL. `@pm/broker-dhan` deliberately
 * stops short of the consent exchange (docs/02 §2.8 — the app must never see the
 * secret), so the hook point is this URL plus the `{accessToken, expiresAt}`
 * callback below. Confirm the exact host/param against Dhan's partner docs on
 * the VM before first use.
 */
export const DHAN_CONSENT_URL_TEMPLATE =
  'https://auth.dhan.co/login/consentApp-login?consentAppId=';

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
  | { ok: false; reason: 'SECRET_MISSING'; detail: string };

export type CompleteLoginResult =
  | { ok: true; broker: Broker; connected: true; expiresAt: string }
  | {
      ok: false;
      reason: 'INVALID_PAYLOAD' | 'SECRET_MISSING' | 'EXCHANGE_FAILED';
      detail: string;
    };

const KiteCallbackSchema = z.object({ requestToken: z.string().min(1) });
/**
 * Dhan: the consent flow mints the token outside this process; the callback
 * carries it plus its true expiry (docs/02 §2.4 — without `expiresAt` the
 * adapter must fail closed, so it is required here).
 */
const DhanCallbackSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: IsoDateTimeSchema,
});

export interface SessionDeps {
  secrets: SecretStore;
  sessions: SessionStore;
  audit: AuditWriter;
  clock: Clock;
  http: HttpClient;
  secretNames: { dhan: BrokerSecretNames; kite: BrokerSecretNames };
  /** Used to report which broker the session checks are graded against. */
  activeBrokerFor(uid: string): Promise<Broker | undefined>;
  /** Overrides Kite's base URL in tests. */
  kiteBaseUrl?: string | undefined;
}

export interface SessionService {
  status(uid: string): Promise<SessionStatusResult>;
  loginUrl(uid: string, broker: Broker): Promise<LoginUrlResult>;
  completeLogin(uid: string, broker: Broker, payload: unknown): Promise<CompleteLoginResult>;
}

export function createSessionService(deps: SessionDeps): SessionService {
  const names = (broker: Broker): BrokerSecretNames => deps.secretNames[broker];

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

    async loginUrl(_uid: string, broker: Broker): Promise<LoginUrlResult> {
      const apiKey = await deps.secrets.get(names(broker).apiKey);
      if (apiKey === undefined || apiKey.value === '') {
        return {
          ok: false,
          reason: 'SECRET_MISSING',
          detail: `secret '${names(broker).apiKey}' is not set`,
        };
      }
      if (broker === 'kite') {
        return { ok: true, broker, url: kiteLoginUrl(apiKey.value), verifyLive: false };
      }
      return {
        ok: true,
        broker,
        url: `${DHAN_CONSENT_URL_TEMPLATE}${encodeURIComponent(apiKey.value)}`,
        verifyLive: true,
      };
    },

    async completeLogin(
      uid: string,
      broker: Broker,
      payload: unknown,
    ): Promise<CompleteLoginResult> {
      const now = deps.clock.now();
      const secretNames = names(broker);

      let accessToken: string;
      let expiresAt: string;

      if (broker === 'kite') {
        const parsed = KiteCallbackSchema.safeParse(payload);
        if (!parsed.success) {
          return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'expected { requestToken }' };
        }
        const apiKey = await deps.secrets.get(secretNames.apiKey);
        const apiSecret = await deps.secrets.get(secretNames.apiSecret);
        if (apiKey === undefined || apiSecret === undefined) {
          return {
            ok: false,
            reason: 'SECRET_MISSING',
            detail: `secrets '${secretNames.apiKey}' / '${secretNames.apiSecret}' must both be set`,
          };
        }
        try {
          const exchanged = await exchangeRequestToken(
            deps.http,
            {
              apiKey: apiKey.value,
              apiSecret: apiSecret.value,
              requestToken: parsed.data.requestToken,
            },
            now,
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
      } else {
        // VERIFY-LIVE: Dhan's consent exchange happens outside this process; the
        // callback delivers the minted token and its true expiry.
        const parsed = DhanCallbackSchema.safeParse(payload);
        if (!parsed.success) {
          return {
            ok: false,
            reason: 'INVALID_PAYLOAD',
            detail: 'expected { accessToken, expiresAt }',
          };
        }
        accessToken = parsed.data.accessToken;
        expiresAt = parsed.data.expiresAt;
      }

      await deps.secrets.set(secretNames.accessToken, { value: accessToken, expiresAt });
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
      return { ok: true, broker, connected: true, expiresAt };
    },
  };
}
