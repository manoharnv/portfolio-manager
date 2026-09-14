/**
 * Local cache of the brokers' instrument masters.
 *
 * The backend downloads both masters at start-up anyway (it has unrestricted
 * egress). Writing them to disk lets the sandboxed strategy engine load the
 * same master from a `file://` URL instead of fetching it from a CDN — whose
 * rotating IPs the pm-strategy nftables egress allowlist cannot pin down, which
 * made the engine's start-up download fail or succeed at random on the real VM
 * (docs/11 §11.4 #8). One fewer external dependency for the process that must
 * never reach anything unlisted, and both processes see one master.
 *
 * Writes are atomic (temp file + rename) so a reader never sees a torn CSV, and
 * modes are set explicitly (the systemd unit runs with UMask=0077) so the
 * other unit's user can read the result.
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DHAN_CACHE_FILE = 'dhan-scrip-master.csv';
export const KITE_CACHE_FILE = 'kite-instruments.csv';

export interface InstrumentCacheWrite {
  path: string;
  bytes: number;
}

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Write `csv` to `<dir>/<fileName>`. Returns `undefined` when `dir` is empty
 * (cache disabled). Rejects file names that are not a plain name.
 */
export async function writeInstrumentCache(
  dir: string,
  fileName: string,
  csv: string,
): Promise<InstrumentCacheWrite | undefined> {
  if (dir === '') return undefined;
  if (!SAFE_FILE_NAME.test(fileName)) {
    throw new Error(`invalid instrument cache file name: "${fileName}"`);
  }

  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755); // traversable by the strategy user regardless of umask

  const finalPath = join(dir, fileName);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, csv, 'utf8');
  await chmod(tmpPath, 0o644); // readable by the strategy user regardless of umask
  await rename(tmpPath, finalPath);

  return { path: finalPath, bytes: Buffer.byteLength(csv, 'utf8') };
}
