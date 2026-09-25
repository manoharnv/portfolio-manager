import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KITE_TAG_MAX_LENGTH, kiteTagFor } from './tag.js';

describe('kiteTagFor', () => {
  it('is deterministic for the same key', () => {
    expect(kiteTagFor('idem-key-1')).toBe(kiteTagFor('idem-key-1'));
  });

  it('is at most 20 chars and alphanumeric', () => {
    const tag = kiteTagFor('a-fairly-long-idempotency-key-that-would-never-fit-in-20-chars');
    expect(tag.length).toBeLessThanOrEqual(KITE_TAG_MAX_LENGTH);
    expect(tag).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('matches a hand-computed SHA-256 prefix', () => {
    const expected = createHash('sha256').update('order-42', 'utf8').digest('hex').slice(0, 20);
    expect(kiteTagFor('order-42')).toBe(expected);
  });

  it('differs for different keys', () => {
    expect(kiteTagFor('key-a')).not.toBe(kiteTagFor('key-b'));
  });

  it('produces 10,000 distinct tags for 10,000 distinct keys (collision resistance)', () => {
    const tags = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      tags.add(kiteTagFor(`idempotency-key-${String(i)}`));
    }
    expect(tags.size).toBe(10_000);
  });
});
