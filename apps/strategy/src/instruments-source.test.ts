import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readInstrumentsSource, type TextFetcher } from './instruments-source.js';

const neverFetch: TextFetcher = () => {
  throw new Error('network must not be touched');
};

describe('readInstrumentsSource', () => {
  it('reads a file:// URL from disk without touching the network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-instruments-'));
    const file = join(dir, 'dhan-scrip-master.csv');
    await writeFile(file, 'SEM_SMST_SECURITY_ID,SEM_TRADING_SYMBOL\n11536,RELIANCE\n', 'utf8');

    await expect(readInstrumentsSource(pathToFileURL(file).href, neverFetch)).resolves.toBe(
      'SEM_SMST_SECURITY_ID,SEM_TRADING_SYMBOL\n11536,RELIANCE\n',
    );
  });

  it('rejects a missing file:// path', async () => {
    await expect(
      readInstrumentsSource('file:///definitely/not/here.csv', neverFetch),
    ).rejects.toThrow(/ENOENT/);
  });

  it('fetches an https:// URL through the injected fetcher', async () => {
    const seen: string[] = [];
    const fetcher: TextFetcher = async (url) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => 'a,b\n' };
    };
    await expect(
      readInstrumentsSource('https://api.kite.trade/instruments', fetcher),
    ).resolves.toBe('a,b\n');
    expect(seen).toEqual(['https://api.kite.trade/instruments']);
  });

  it('fails closed on a non-2xx response', async () => {
    const fetcher: TextFetcher = async () => ({ ok: false, status: 503, text: async () => '' });
    await expect(readInstrumentsSource('https://example.com/x.csv', fetcher)).rejects.toThrow(
      /failed with 503/,
    );
  });

  it('rejects any other scheme before touching anything', async () => {
    await expect(readInstrumentsSource('ftp://x/y.csv', neverFetch)).rejects.toThrow(
      /file:\/\/ or http\(s\)/,
    );
    await expect(readInstrumentsSource('/plain/path.csv', neverFetch)).rejects.toThrow(
      /file:\/\/ or http\(s\)/,
    );
  });
});
