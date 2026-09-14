/**
 * Structured logging — pino, with credential redaction (docs/04 §4.9:
 * "Secrets: only from Secret Manager at boot/refresh; never logged. Structured
 * logs redact order-cred fields.")
 *
 * `console` is banned repo-wide (docs/00 §0.7.5); everything logs through here.
 */

import { pino, type Logger as PinoLogger } from 'pino';
import type { LogLevel } from './config.js';

/**
 * Every path pino scrubs. Redaction is by *path*, so each credential field is
 * listed at the depths we actually log at (top level, one level down, and inside
 * the common `req`/`creds`/`session`/`detail` envelopes).
 */
export const REDACTED_PATHS: readonly string[] = [
  'accessToken',
  'apiSecret',
  'apiKey',
  'requestToken',
  'authorization',
  'access-token',
  '*.accessToken',
  '*.apiSecret',
  '*.apiKey',
  '*.requestToken',
  '*.authorization',
  '*.access-token',
  '*.*.accessToken',
  '*.*.apiSecret',
  '*.*.apiKey',
  '*.*.requestToken',
  '*.*.authorization',
  '*.*.access-token',
  'req.headers.authorization',
  'req.headers["access-token"]',
  'headers.authorization',
  'headers["access-token"]',
];

export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * The logging surface the app depends on. Deliberately narrower than pino's —
 * services take this, so a test can pass a capturing fake and nothing reaches a
 * real stream.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: object): Logger;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Static bindings, e.g. `{ service: 'backend', environment: 'dry-run' }`. */
  base?: Record<string, unknown> | undefined;
  /** Test/dev only: write to an injected stream instead of stdout. */
  destination?: NodeJS.WritableStream | undefined;
  /** Human-readable output for local dev (`pino-pretty`). Never in prod. */
  pretty?: boolean | undefined;
}

/** A pino logger with {@link REDACTED_PATHS} scrubbed. */
export function createLogger(options: CreateLoggerOptions): PinoLogger {
  const opts = {
    level: options.level,
    base: options.base ?? {},
    redact: { paths: [...REDACTED_PATHS], censor: REDACTED_PLACEHOLDER },
    ...(options.pretty === true
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };
  return options.destination === undefined ? pino(opts) : pino(opts, options.destination);
}

/** A logger that discards everything — for tests and for `--help`-style paths. */
export function silentLogger(): Logger {
  const noop = (): void => undefined;
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
