/**
 * One UUID v4 per approval tap (docs/04 §4.4, docs/06 §6.4).
 *
 * The key is minted at the moment the human commits, never reused across taps:
 * the backend burns it, and a replay of a burned key comes back as
 * `IDEMPOTENT_REPLAY` rather than a second order. The prefix exists so a key in
 * the audit log is obviously app-minted.
 */
import * as Crypto from 'expo-crypto';

/** `pm-<uuid v4>` — 39 chars, inside the backend's 8..200 bound. */
export function newIdempotencyKey(): string {
  return `pm-${Crypto.randomUUID()}`;
}

const KEY_RE = /^pm-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIdempotencyKey(value: string): boolean {
  return KEY_RE.test(value);
}
