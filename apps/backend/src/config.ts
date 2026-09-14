/**
 * Process configuration — parsed once, at the composition root, from the
 * environment (docs/04 §4.8, §4.9; docs/08 infrastructure).
 *
 * Three rules shape this file:
 *   1. **Only secret *names* live here, never secret values.** The VM's service
 *      account resolves the names against Secret Manager at runtime (docs/04 §4.9).
 *   2. **Fail closed.** `ALLOWED_UIDS` defaults to *empty*, which denies every
 *      caller; `ENVIRONMENT` defaults to `dry-run`; `prod` additionally requires a
 *      declared `STATIC_IP` so `orders.ipUsed` can never be blank on a real order.
 *   3. **Pure.** `parseConfig` reads its input, not `process.env`, and never
 *      touches the clock — so it is exhaustively testable.
 */

import { z } from 'zod';
import { SegmentSchema, type Segment } from '@pm/core';

export type Env = Record<string, string | undefined>;

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** `"a, b ,,c"` → `['a','b','c']`; blank/absent → `[]` (deny-all for uids). */
function csv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const csvList = z.string().optional().transform(csv);

/** `undefined` → default; otherwise must parse as a finite number in range. */
function intEnv(fallback: number, min: number, max: number): z.ZodType<number> {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v.trim())))
    .pipe(
      z
        .number()
        .int('expected an integer')
        .min(min, `must be ≥ ${min}`)
        .max(max, `must be ≤ ${max}`),
    );
}

function stringEnv(fallback: string): z.ZodType<string> {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : v.trim()));
}

export const EnvironmentSchema = z.enum(['dry-run', 'paper', 'prod']);
export type BackendEnvironment = z.infer<typeof EnvironmentSchema>;

export const LogLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/** Secret Manager secret *names* for one broker. Values are never held here. */
export interface BrokerSecretNames {
  /** Long-lived API key. */
  apiKey: string;
  /** Long-lived API secret — used only for the daily exchange (docs/04 §4.6). */
  apiSecret: string;
  /** Where today's access token is written after the exchange. */
  accessToken: string;
  /** Dhan's client id; unused by Kite. */
  clientId: string;
}

const RawConfigSchema = z.object({
  PORT: intEnv(8080, 1, 65_535),
  HOST: stringEnv('0.0.0.0'),
  ENVIRONMENT: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'dry-run' : v.trim()))
    .pipe(EnvironmentSchema),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'info' : v.trim()))
    .pipe(LogLevelSchema),

  GCP_PROJECT: stringEnv(''),
  FIREBASE_PROJECT_ID: stringEnv(''),

  DHAN_API_KEY_SECRET: stringEnv('dhan-api-key'),
  DHAN_API_SECRET_SECRET: stringEnv('dhan-api-secret'),
  DHAN_ACCESS_TOKEN_SECRET: stringEnv('dhan-access-token'),
  DHAN_CLIENT_ID_SECRET: stringEnv('dhan-client-id'),

  KITE_API_KEY_SECRET: stringEnv('kite-api-key'),
  KITE_API_SECRET_SECRET: stringEnv('kite-api-secret'),
  KITE_ACCESS_TOKEN_SECRET: stringEnv('kite-access-token'),

  /** Empty ⇒ deny every uid. Never defaulted to a wildcard. */
  ALLOWED_UIDS: csvList,
  /** Written to `orders.ipUsed` and every audit event (docs/04 §4.9). */
  STATIC_IP: stringEnv(''),
  /**
   * Directory where the downloaded instrument masters are cached for the
   * strategy engine to read via file:// (docs/11 §11.4 #8). Empty ⇒ disabled.
   */
  INSTRUMENTS_CACHE_DIR: stringEnv(''),
  /**
   * Secret Manager id of the strategy engine's READ-creds secret, rewritten
   * after every broker login (services/strategy-creds.ts). Blank ⇒ the default
   * name; the sync itself is best-effort and never fails a login.
   */
  STRATEGY_READ_CREDS_SECRET: stringEnv('pm-strategy-read-creds'),
  /**
   * Where `GET /v1/auth/dhan/redirect` bounces the browser once Dhan's consent
   * is consumed (`?broker=dhan&status=ok|error…` is appended). The app's scheme.
   */
  APP_CALLBACK_URL: stringEnv('pm://broker-callback'),

  RATE_LIMIT_MAX: intEnv(60, 1, 10_000),
  RATE_LIMIT_WINDOW_MS: intEnv(60_000, 100, 3_600_000),

  RECONCILE_INTERVAL_MS: intEnv(15_000, 1_000, 3_600_000),
  PORTFOLIO_REFRESH_INTERVAL_MS: intEnv(60_000, 1_000, 3_600_000),
  /** dry-run/paper only: how long after submission the simulator fills. */
  SIMULATOR_FILL_AFTER_MS: intEnv(2_000, 0, 3_600_000),
  /** A proposal parked in `approved`/`placing` this long is presumed abandoned. */
  STUCK_PROPOSAL_AFTER_MS: intEnv(300_000, 1_000, 86_400_000),

  /** IST `YYYY-MM-DD` exchange holidays; merged into core's market-hours check. */
  MARKET_HOLIDAYS: csvList.pipe(z.array(IsoDateSchema)),
  /**
   * Neutral segments the instrument masters keep in memory (`EQ`, `FNO`,
   * `CURRENCY`, `COMMODITY`). The Dhan master alone is ~200k rows, all but a
   * few thousand of them F&O contracts; indexing everything costs ~350 MB per
   * process, which the 1 GB VM cannot afford twice. Blank ⇒ `EQ`.
   */
  INSTRUMENT_SEGMENTS: csvList
    .pipe(z.array(SegmentSchema))
    .transform((list): Segment[] => (list.length === 0 ? ['EQ'] : list)),
});

export interface BackendConfig {
  port: number;
  host: string;
  environment: BackendEnvironment;
  logLevel: LogLevel;
  gcpProject: string;
  firebaseProjectId: string;
  secrets: { dhan: BrokerSecretNames; kite: BrokerSecretNames };
  /** Empty ⇒ deny all (fail closed). */
  allowedUids: readonly string[];
  staticIp: string;
  /** '' ⇒ no local instrument-master cache is written. */
  instrumentsCacheDir: string;
  /** Secret id the login flow rewrites for the engine; '' (tests only) ⇒ never. */
  strategyReadCredsSecret: string;
  appCallbackUrl: string;
  rateLimit: { max: number; windowMs: number };
  reconcileIntervalMs: number;
  portfolioRefreshIntervalMs: number;
  simulatorFillAfterMs: number;
  stuckProposalAfterMs: number;
  marketHolidays: readonly string[];
  /** Which neutral segments the instrument masters index; never empty. */
  instrumentSegments: readonly Segment[];
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid backend configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parse and validate the process environment. Pure: give it the same map and it
 * returns the same config. Throws {@link ConfigError} rather than starting a
 * process that can place orders with a half-understood configuration.
 */
export function parseConfig(env: Env): BackendConfig {
  const parsed = RawConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const raw = parsed.data;

  const issues: string[] = [];
  if (raw.ENVIRONMENT === 'prod' && raw.STATIC_IP === '') {
    issues.push('STATIC_IP: required when ENVIRONMENT=prod (orders.ipUsed must be recorded)');
  }
  if (raw.ENVIRONMENT === 'prod' && raw.ALLOWED_UIDS.length === 0) {
    issues.push('ALLOWED_UIDS: required when ENVIRONMENT=prod (an empty allowlist denies all)');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    port: raw.PORT,
    host: raw.HOST,
    environment: raw.ENVIRONMENT,
    logLevel: raw.LOG_LEVEL,
    gcpProject: raw.GCP_PROJECT,
    firebaseProjectId: raw.FIREBASE_PROJECT_ID,
    secrets: {
      dhan: {
        apiKey: raw.DHAN_API_KEY_SECRET,
        apiSecret: raw.DHAN_API_SECRET_SECRET,
        accessToken: raw.DHAN_ACCESS_TOKEN_SECRET,
        clientId: raw.DHAN_CLIENT_ID_SECRET,
      },
      kite: {
        apiKey: raw.KITE_API_KEY_SECRET,
        apiSecret: raw.KITE_API_SECRET_SECRET,
        accessToken: raw.KITE_ACCESS_TOKEN_SECRET,
        clientId: '',
      },
    },
    allowedUids: raw.ALLOWED_UIDS,
    staticIp: raw.STATIC_IP,
    instrumentsCacheDir: raw.INSTRUMENTS_CACHE_DIR,
    strategyReadCredsSecret: raw.STRATEGY_READ_CREDS_SECRET,
    appCallbackUrl: raw.APP_CALLBACK_URL,
    rateLimit: { max: raw.RATE_LIMIT_MAX, windowMs: raw.RATE_LIMIT_WINDOW_MS },
    reconcileIntervalMs: raw.RECONCILE_INTERVAL_MS,
    portfolioRefreshIntervalMs: raw.PORTFOLIO_REFRESH_INTERVAL_MS,
    simulatorFillAfterMs: raw.SIMULATOR_FILL_AFTER_MS,
    stuckProposalAfterMs: raw.STUCK_PROPOSAL_AFTER_MS,
    marketHolidays: raw.MARKET_HOLIDAYS,
    instrumentSegments: raw.INSTRUMENT_SEGMENTS,
  };
}

/**
 * `true` when `uid` may use this backend at all (docs/04 §4.9). An empty
 * allowlist denies everyone — the fail-closed default.
 */
export function isAllowedUid(config: BackendConfig, uid: string): boolean {
  return config.allowedUids.includes(uid);
}
