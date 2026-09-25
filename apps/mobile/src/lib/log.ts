/**
 * The app's only logger (docs/00 §0.7.5 — apps log through their own structured
 * logger, which redacts credential fields).
 *
 * Two rules, enforced here rather than at every call site:
 *   1. Nothing that looks like a credential is ever printed. `redact` walks the
 *      payload and replaces any value under a sensitive key with `[redacted]`.
 *   2. `info` is a no-op outside `__DEV__`, so a release build only ever emits
 *      warnings and errors.
 */

const SENSITIVE_KEY = /token|secret|password|credential|authorization|apikey|api_key|assertion/i;

/**
 * Anything shaped like a JWT is dropped wholesale, whatever key it sits under:
 * three base64url-ish segments, the first two at least ten characters. A short
 * dotted string (`NSE.EQ.INFY`) is left alone.
 */
const JWT_LIKE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return JWT_LIKE.test(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function isDev(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

export const log = {
  info(message: string, context?: unknown): void {
    if (!isDev()) return;
    console.warn(`[pm] ${message}`, context === undefined ? '' : redact(context));
  },
  warn(message: string, context?: unknown): void {
    console.warn(`[pm] ${message}`, context === undefined ? '' : redact(context));
  },
  error(message: string, context?: unknown): void {
    console.error(`[pm] ${message}`, context === undefined ? '' : redact(context));
  },
};
