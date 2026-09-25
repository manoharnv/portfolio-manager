/**
 * Structured logging (docs/00 §0.7.5 — no `console`, ever).
 *
 * Everything that could carry a broker credential is redacted at the logger, not
 * at the call site, so a careless `log.info({ creds })` cannot leak a token.
 */

import pino, { type DestinationStream, type LoggerOptions as PinoOptions } from 'pino';
import type { Logger } from './types.js';

/** Redacted wherever they appear, at the top level or one level down. */
export const REDACT_PATHS: readonly string[] = [
  'accessToken',
  'apiKey',
  'apiSecret',
  'clientId',
  'password',
  'token',
  'authorization',
  'creds',
  '*.accessToken',
  '*.apiKey',
  '*.apiSecret',
  '*.clientId',
  '*.password',
  '*.token',
  '*.authorization',
  '*.creds',
];

export const REDACT_CENSOR = '[REDACTED]';

export interface CreateLoggerOptions {
  level?: string | undefined;
  name?: string | undefined;
  /** Human-readable output via pino-pretty. Ignored when `destination` is set. */
  pretty?: boolean | undefined;
  /** Tests pass an in-memory stream; production writes to stdout. */
  destination?: DestinationStream | undefined;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const base: PinoOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service: options.name ?? 'strategy-engine' },
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
  };

  if (options.destination !== undefined) {
    return pino(base, options.destination);
  }
  if (options.pretty === true) {
    return pino({ ...base, transport: { target: 'pino-pretty' } });
  }
  return pino(base);
}
