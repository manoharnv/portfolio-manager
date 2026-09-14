/**
 * Where the instrument master comes from.
 *
 * On the VM `PM_INSTRUMENTS_URL` is a `file://` path that the execution backend
 * keeps fresh (apps/backend `instruments-cache.ts`): the sandboxed strategy user
 * never needs egress to a CDN whose rotating IPs the nftables allowlist cannot
 * pin down — on the real box that made this download fail or succeed at random
 * (docs/11 §11.4 #8). `http(s)://` stays supported for local runs.
 *
 * Pure with respect to the network: the fetch implementation is injected so
 * tests never touch it (docs/00 §0.5).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface TextResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type TextFetcher = (url: string) => Promise<TextResponse>;

export async function readInstrumentsSource(
  url: string,
  fetchImpl: TextFetcher = fetch,
): Promise<string> {
  if (url.startsWith('file://')) {
    return readFile(fileURLToPath(url), 'utf8');
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`PM_INSTRUMENTS_URL must be a file:// or http(s):// URL, got "${url}"`);
  }
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return response.text();
}
