/**
 * The hard boundary, checked as a test (docs/05 §5.1).
 *
 * Types and lint already forbid it; this is the third, independent mechanism: a
 * plain text scan of every source file. It catches a dynamic `import()`, a
 * string-built member access, or a lint rule someone disabled inline — none of
 * which the other two would see.
 *
 * Filesystem access is allowed *here only*; every other test is pure.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const THIS_FILE = 'policy.test.ts';

/**
 * Identifiers that would give this process order capability. Kept as strings so
 * this file does not itself reference them as code.
 */
const FORBIDDEN = [
  'createAdapter',
  'registerAdapter',
  'createDhanAdapter',
  'createKiteAdapter',
  'registerDhanAdapter',
  'registerKiteAdapter',
  'BrokerAdapter',
  'placeOrder',
  'modifyOrder',
  'cancelOrder',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

describe('strategy-engine boundary policy', () => {
  const files = sourceFiles(SRC_DIR).filter((f) => !f.endsWith(THIS_FILE));

  it('finds the sources to scan', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(FORBIDDEN)('no source file mentions %s', (identifier) => {
    const pattern = new RegExp(`\\b${identifier}\\b`);
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });

  it('only ever asks for the read-only broker surface', () => {
    const mentions = files.filter((file) =>
      /\bBrokerReadAdapter\b/.test(readFileSync(file, 'utf8')),
    );
    expect(mentions.length).toBeGreaterThan(0);
  });

  it('writes to no Firestore collection other than proposals and auditLog', () => {
    const writes: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // `.set()` on proposals/auditLog is the only write; these never appear.
      for (const match of text.matchAll(/\.(update|delete)\(/g)) {
        writes.push(`${relative(SRC_DIR, file)}: ${match[0]}`);
      }
    }
    expect(writes).toEqual([]);
  });
});
