/**
 * The Fastify app factory — docs/04 §4.3 and §4.9.
 *
 * `buildApp` never listens; the composition root does that. Everything the app
 * needs arrives as `deps`, so `app.inject()` in a test drives the exact same
 * code path a real request would.
 *
 * Security posture baked in here:
 *   - `/health` and the brokers' login redirects (`GET /v1/auth/:broker/redirect`,
 *     sent by the broker's login page, not by the app) are the ONLY
 *     unauthenticated routes; the redirects are still rate-limited by IP and
 *     only honoured while a login this backend started is pending
 *     (services/session.ts).
 *   - Every other route: `Authorization: Bearer <Firebase ID token>` → uid, then
 *     an `ALLOWED_UIDS` allowlist check (empty list ⇒ 403 for everyone).
 *   - Per-uid rate limit, hard-capped well below broker OPS limits.
 *   - Responses carry no secrets and no stack traces, ever.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { BrokerError } from '@pm/core';
import type { OrderRecord } from '@pm/core';
import { isAllowedUid, type BackendConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { Clock, TokenVerifier } from '../ports/index.js';
import type { ExecutionService } from '../services/execution.js';
import type { RejectService } from '../services/reject.js';
import type { CancelService } from '../services/cancel.js';
import type { KillSwitchService } from '../services/killswitch.js';
import type { SessionService } from '../services/session.js';
import type { PortfolioService } from '../services/portfolio.js';
import type { ReconcileService } from '../services/reconcile.js';
import type { ActiveBrokerService } from '../services/active-broker.js';
import type { QuotesService } from '../services/quotes.js';
import type { StrategiesService } from '../services/strategies.js';
import { brokerErrorStatus, executionOutcome, failureBody, simpleStatus } from './mapping.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook; absent on `/health`. */
    uid?: string | undefined;
  }
}

export interface Services {
  execution: ExecutionService;
  reject: RejectService;
  cancel: CancelService;
  killswitch: KillSwitchService;
  session: SessionService;
  portfolio: PortfolioService;
  reconcile: ReconcileService;
  activeBroker: ActiveBrokerService;
  quotes: QuotesService;
  strategies: StrategiesService;
}

export interface AppDeps {
  config: BackendConfig;
  logger: Logger;
  verifier: TokenVerifier;
  services: Services;
  clock: Clock;
}

/** The brokers' browser redirects — sent by their login pages, not by the app. */
export const REDIRECT_PATHS: ReadonlySet<string> = new Set([
  '/v1/auth/dhan/redirect',
  '/v1/auth/kite/redirect',
]);

/** The routes that answer without a token. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health', ...REDIRECT_PATHS]);
/** The routes exempt from the rate limit — the redirect is NOT one of them. */
const UNMETERED_PATHS: ReadonlySet<string> = new Set(['/health']);

/**
 * `APP_CALLBACK_URL` plus the outcome, e.g.
 * `pm://broker-callback?broker=dhan&status=ok&expiresAt=…`. Built by hand
 * because `URL` mangles custom schemes on some runtimes.
 */
export function appCallbackUrl(base: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

const BrokerParamSchema = z.object({ broker: z.enum(['dhan', 'kite']) });

/** The redirect's query string as key → first value; anything odd is dropped. */
function stringQuery(raw: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value.slice(0, 512);
    else if (Array.isArray(value) && typeof value[0] === 'string')
      out[key] = value[0].slice(0, 512);
  }
  return out;
}
const IdParamSchema = z.object({ id: z.string().min(1) });

const ExecuteBodySchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  /** Required: the staleness guard cannot run without it (docs/04 §4.4 J). */
  clientSeenLtp: z.number().positive().finite(),
  biometricAssertion: z.string().min(1).optional(),
});

const StrategyParamSchema = z.object({ strategyId: z.string().min(1) });
const ActiveBrokerBodySchema = z.object({ broker: z.enum(['dhan', 'kite']) });
const QuotesQuerySchema = z.object({ symbols: z.string().min(1) });

const RejectBodySchema = z.object({ reason: z.string().min(1).max(500).optional() });
const KillSwitchBodySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(500).optional(),
});

function pathOf(request: FastifyRequest): string {
  const raw = request.url;
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/** `orders/{id}` minus the raw broker payload — never echoed to a client. */
export function sanitizeOrder(record: OrderRecord): Record<string, unknown> {
  const { brokerRawAck: _raw, ...rest } = record;
  return rest;
}

function badRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  return reply.code(400).send({
    ok: false,
    reason: 'INVALID_REQUEST',
    detail: error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
  });
}

/** The caller's uid — present on every non-public route by construction. */
function uidOf(request: FastifyRequest): string {
  return request.uid ?? '';
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // `logger: false` — the app logs through `deps.logger`, which is the one with
  // credential redaction configured (docs/04 §4.9).
  const app = Fastify({ logger: false, trustProxy: false });

  // --- authentication + allowlist (docs/04 §4.9) --------------------------
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(pathOf(request))) return;

    const token = bearer(request);
    if (token === undefined) {
      await reply
        .code(401)
        .send(failureBody('UNAUTHENTICATED', 'missing Authorization: Bearer <Firebase ID token>'));
      return;
    }
    let uid: string;
    try {
      ({ uid } = await deps.verifier.verify(token));
    } catch {
      await reply.code(401).send(failureBody('UNAUTHENTICATED', 'invalid or expired ID token'));
      return;
    }
    if (!isAllowedUid(deps.config, uid)) {
      deps.logger.warn({ uid, path: pathOf(request) }, 'uid not in ALLOWED_UIDS');
      await reply
        .code(403)
        .send(failureBody('FORBIDDEN', 'uid is not permitted to use this backend'));
      return;
    }
    request.uid = uid;
  });

  // --- per-uid rate limit -------------------------------------------------
  // Registered on `preValidation` so the auth hook has already resolved the uid
  // that the bucket is keyed on.
  await app.register(rateLimit, {
    global: true,
    max: deps.config.rateLimit.max,
    timeWindow: deps.config.rateLimit.windowMs,
    hook: 'preValidation',
    keyGenerator: (request: FastifyRequest) => request.uid ?? request.ip,
    allowList: (request: FastifyRequest) => UNMETERED_PATHS.has(pathOf(request)),
    // The plugin *throws* whatever this returns, so it must be an Error that
    // carries the status through to the error handler below.
    errorResponseBuilder: (_request: FastifyRequest, context: { statusCode?: number }) =>
      Object.assign(new Error('rate limit exceeded'), {
        statusCode: context.statusCode ?? 429,
      }),
  });

  // --- never leak internals ----------------------------------------------
  app.setErrorHandler(async (error: unknown, request, reply) => {
    if (error instanceof BrokerError) {
      deps.logger.error({ kind: error.kind, path: pathOf(request) }, 'broker error');
      await reply
        .code(brokerErrorStatus(error.kind))
        .send(failureBody('BROKER_ERROR', error.message, { brokerErrorKind: error.kind }));
      return;
    }
    const raw = error as { statusCode?: unknown; message?: unknown };
    const status = typeof raw.statusCode === 'number' ? raw.statusCode : 500;
    if (status === 429) {
      await reply.code(429).send(failureBody('RATE_LIMITED', 'too many requests — slow down'));
      return;
    }
    const message = typeof raw.message === 'string' ? raw.message : 'internal error';
    deps.logger.error({ err: message, path: pathOf(request) }, 'unhandled route error');
    // A 5xx never carries the underlying message out to a client.
    await reply
      .code(status >= 400 && status < 600 ? status : 500)
      .send(failureBody('INTERNAL', status >= 500 ? 'internal error' : message));
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send(failureBody('NOT_FOUND', 'no such route'));
  });

  // --- routes -------------------------------------------------------------

  app.get('/health', async () => ({
    ok: true,
    status: 'ok',
    environment: deps.config.environment,
    time: deps.clock.now().toISOString(),
  }));

  app.get('/v1/session', async (request) => deps.services.session.status(uidOf(request)));

  app.post('/v1/auth/:broker/login-url', async (request, reply) => {
    const params = BrokerParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const result = await deps.services.session.loginUrl(uidOf(request), params.data.broker);
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return result;
  });

  app.post('/v1/auth/:broker/callback', async (request, reply) => {
    const params = BrokerParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const result = await deps.services.session.completeLogin(
      uidOf(request),
      params.data.broker,
      request.body,
    );
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return result;
  });

  /**
   * The brokers' login redirects (docs/02 §2.8). The broker's login page sends
   * the user's browser here — Dhan with `?tokenId=`, Kite with
   * `?request_token=…&state=…` — the exchange happens server-side and the
   * browser is then bounced to the app's callback URL with a status. Whatever
   * happens, the token never appears in this response, the URL or a log — and
   * the browser is always sent back to the app, never left on an error page
   * it cannot act on.
   */
  app.get('/v1/auth/:broker/redirect', async (request, reply) => {
    const params = BrokerParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send(failureBody('NOT_FOUND', 'no such route'));
    const broker = params.data.broker;
    const bounce = (extra: Record<string, string>): FastifyReply =>
      reply.redirect(appCallbackUrl(deps.config.appCallbackUrl, { broker, ...extra }), 302);

    try {
      const result = await deps.services.session.completeRedirect(
        broker,
        stringQuery(request.query),
      );
      if (!result.ok) {
        deps.logger.warn({ broker, reason: result.reason }, 'broker login redirect refused');
        return bounce({ status: 'error', reason: result.reason });
      }
      deps.logger.info(
        { broker, expiresAt: result.expiresAt },
        'broker session connected via redirect',
      );
      return bounce({ status: 'ok', expiresAt: result.expiresAt });
    } catch (err) {
      deps.logger.error(
        { broker, err: err instanceof Error ? err.message : String(err) },
        'broker login redirect failed',
      );
      return bounce({ status: 'error', reason: 'INTERNAL' });
    }
  });

  for (const slice of ['holdings', 'positions', 'funds'] as const) {
    app.get(`/v1/portfolio/${slice}`, async (request, reply) => {
      const result = await deps.services.portfolio.refresh(uidOf(request));
      if (!result.ok) {
        return reply.code(simpleStatus(result.reason)).send(
          failureBody(result.reason, result.detail, {
            ...(result.brokerErrorKind === undefined
              ? {}
              : { brokerErrorKind: result.brokerErrorKind }),
          }),
        );
      }
      return { ok: true, at: result.at, [slice]: result.snapshot[slice] };
    });
  }

  app.post('/v1/proposals/:id/execute', async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const body = ExecuteBodySchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);

    const result = await deps.services.execution.executeProposal({
      uid: uidOf(request),
      proposalId: params.data.id,
      idempotencyKey: body.data.idempotencyKey,
      clientSeenLtp: body.data.clientSeenLtp,
      ...(body.data.biometricAssertion === undefined
        ? {}
        : { biometricAssertion: body.data.biometricAssertion }),
    });
    const outcome = executionOutcome(result);
    return reply.code(outcome.status).send(outcome.body);
  });

  app.post('/v1/proposals/:id/reject', async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const body = RejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);

    const result = await deps.services.reject.rejectProposal({
      uid: uidOf(request),
      proposalId: params.data.id,
      ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
    });
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return result;
  });

  app.post('/v1/orders/:id/cancel', async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const result = await deps.services.cancel.cancelOrder({
      uid: uidOf(request),
      orderId: params.data.id,
    });
    if (!result.ok) {
      return reply.code(simpleStatus(result.reason)).send(
        failureBody(result.reason, result.detail, {
          ...(result.brokerErrorKind === undefined
            ? {}
            : { brokerErrorKind: result.brokerErrorKind }),
        }),
      );
    }
    return result;
  });

  app.get('/v1/orders/:id', async (request, reply) => {
    const params = IdParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);
    const result = await deps.services.reconcile.syncOrder(uidOf(request), params.data.id);
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return { ok: true, order: sanitizeOrder(result.order) };
  });

  app.post('/v1/config/killswitch', async (request, reply) => {
    const body = KillSwitchBodySchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const result = await deps.services.killswitch.setKillSwitch({
      uid: uidOf(request),
      enabled: body.data.enabled,
      ...(body.data.reason === undefined ? {} : { reason: body.data.reason }),
    });
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return result;
  });

  /**
   * The broker switch (docs/02 §2.4, docs/06 §6.3). The client cannot write
   * `config.activeBroker` itself — the rules forbid it — because the switch is
   * only safe once the target broker has a live session.
   */
  app.post('/v1/config/active-broker', async (request, reply) => {
    const body = ActiveBrokerBodySchema.safeParse(request.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    const result = await deps.services.activeBroker.setActiveBroker({
      uid: uidOf(request),
      broker: body.data.broker,
    });
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return result;
  });

  /** Live quotes for arbitrary symbols — the approval screen's staleness check. */
  app.get('/v1/quotes', async (request, reply) => {
    const query = QuotesQuerySchema.safeParse(request.query ?? {});
    if (!query.success) return badRequest(reply, query.error);

    const result = await deps.services.quotes.getQuotes(uidOf(request), query.data.symbols);
    if (!result.ok) {
      return reply.code(simpleStatus(result.reason)).send(
        failureBody(result.reason, result.detail, {
          // Contract note: this route reports the broker error kind as `kind`.
          ...(result.reason === 'BROKER_ERROR' ? { kind: result.kind } : {}),
        }),
      );
    }
    return { ok: true, quotes: result.quotes };
  });

  app.patch('/v1/strategies/:strategyId', async (request, reply) => {
    const params = StrategyParamSchema.safeParse(request.params);
    if (!params.success) return badRequest(reply, params.error);

    const result = await deps.services.strategies.patchStrategy({
      uid: uidOf(request),
      strategyId: params.data.strategyId,
      patch: request.body,
    });
    if (!result.ok) {
      return reply
        .code(simpleStatus(result.reason))
        .send(failureBody(result.reason, result.detail));
    }
    return result;
  });

  /**
   * docs/04 §4.3 lists this as "(broker permitting)". Neither adapter exposes an
   * IP-whitelist API today, so this answers 501 rather than pretending.
   * VERIFY-LIVE: check whether Dhan/Kite offer a programmatic whitelist endpoint;
   * if they do, wire it through `BrokerAdapter` first, not around it.
   */
  app.post('/v1/admin/whitelist-ip', async (_request, reply) =>
    reply
      .code(501)
      .send(
        failureBody(
          'NOT_IMPLEMENTED',
          'no broker adapter exposes an IP-whitelist API; whitelist the static IP in the broker console',
          { staticIp: deps.config.staticIp },
        ),
      ),
  );

  await app.ready();
  return app;
}
