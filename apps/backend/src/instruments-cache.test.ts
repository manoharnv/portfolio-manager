import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DHAN_CACHE_FILE, KITE_CACHE_FILE, writeInstrumentCache } from './instruments-cache.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pm-instruments-cache-'));
}

describe('writeInstrumentCache', () => {
  it('is disabled when the directory is empty — writes nothing, returns undefined', async () => {
    await expect(writeInstrumentCache('', DHAN_CACHE_FILE, 'a,b\n')).resolves.toBeUndefined();
  });

  it('creates the directory, writes the file world-readable, and leaves no temp file behind', async () => {
    const root = await tempDir();
    const dir = join(root, 'nested', 'instruments');

    const written = await writeInstrumentCache(dir, DHAN_CACHE_FILE, 'symbol,id\nRELIANCE,11536\n');

    expect(written).toEqual({ path: join(dir, DHAN_CACHE_FILE), bytes: 25 });
    await expect(readFile(join(dir, DHAN_CACHE_FILE), 'utf8')).resolves.toBe(
      'symbol,id\nRELIANCE,11536\n',
    );
    expect((await stat(join(dir, DHAN_CACHE_FILE))).mode & 0o777).toBe(0o644);
    expect((await stat(dir)).mode & 0o777).toBe(0o755);
    await expect(readdir(dir)).resolves.toEqual([DHAN_CACHE_FILE]);
  });

  it('replaces a previous master in place (rename is atomic)', async () => {
    const dir = await tempDir();
    await writeInstrumentCache(dir, KITE_CACHE_FILE, 'v1\n');
    await writeInstrumentCache(dir, KITE_CACHE_FILE, 'v2\n');

    await expect(readFile(join(dir, KITE_CACHE_FILE), 'utf8')).resolves.toBe('v2\n');
    await expect(readdir(dir)).resolves.toEqual([KITE_CACHE_FILE]);
  });

  it('counts bytes, not characters', async () => {
    const dir = await tempDir();
    const written = await writeInstrumentCache(dir, DHAN_CACHE_FILE, '₹\n');
    expect(written?.bytes).toBe(4); // ₹ is 3 bytes in UTF-8
  });

  it('rejects a file name that is not a plain name', async () => {
    const dir = await tempDir();
    await expect(writeInstrumentCache(dir, '../escape.csv', 'x')).rejects.toThrow(/invalid/);
    await expect(writeInstrumentCache(dir, '.hidden', 'x')).rejects.toThrow(/invalid/);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});
