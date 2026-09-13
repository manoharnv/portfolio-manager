/**
 * Kite's `tag` order field — docs/02-broker-abstraction.md §2.7.
 *
 * Kite caps `tag` at 20 characters and requires it to be alphanumeric. The
 * caller-generated `idempotencyKey` (a full-length opaque string, potentially
 * a UUID or longer) will not fit, so we derive a deterministic, collision
 * resistant, alphanumeric digest of it instead.
 *
 * The FULL idempotency key is stored server-side (Firestore, per docs/02
 * §2.7's note) — only this short hash ever travels to the broker. Because the
 * digest is a pure function of the key, retries of the same logical order
 * reuse the same tag, which is what lets a human (or the backend) recognise a
 * retried order on the broker's own order book.
 */

import { createHash } from 'node:crypto';

/** Kite's documented cap on `tag`. */
export const KITE_TAG_MAX_LENGTH = 20;

/**
 * Deterministic ≤20-char alphanumeric tag for a given idempotency key.
 * SHA-256 hex digest, truncated — hex digits are already alphanumeric
 * (`[0-9a-f]`), so no further sanitisation is needed.
 */
export function kiteTagFor(idempotencyKey: string): string {
  const digestHex = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
  return digestHex.slice(0, KITE_TAG_MAX_LENGTH);
}
