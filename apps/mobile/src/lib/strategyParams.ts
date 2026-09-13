/**
 * Validation for the strategy `params` editor (Settings → Strategies).
 *
 * Pure, so the rule the UI enforces and the rule the tests assert are the same
 * one. The backend validates again — this only stops obvious nonsense from
 * becoming a 400 round-trip, and stops a paste of something enormous.
 */

/** The backend's cap on a `params` body. */
export const MAX_PARAMS_BYTES = 8 * 1024;

/**
 * UTF-8 byte length without depending on `TextEncoder`, which is not present on
 * every Hermes build.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      i += 1; // surrogate pair
    }
  }
  return bytes;
}

export type ParamsParse =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Blank text means "no params" (`{}`), not an error. Anything else must be a
 * JSON **plain object** — an array, `null` or a bare scalar is refused, because
 * the route's body type is `Record<string, unknown>`.
 */
export function parseParams(text: string): ParamsParse {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: {} };

  if (utf8Bytes(trimmed) > MAX_PARAMS_BYTES) {
    return {
      ok: false,
      error: `params must be at most ${MAX_PARAMS_BYTES / 1024} KB (this is ${Math.ceil(
        utf8Bytes(trimmed) / 1024,
      )} KB)`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (caught) {
    return {
      ok: false,
      error: `not valid JSON: ${caught instanceof Error ? caught.message : 'parse failed'}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'params must be a JSON object, e.g. {"rsiPeriod": 14}' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export function formatParams(params: Record<string, unknown> | undefined): string {
  if (params === undefined || Object.keys(params).length === 0) return '';
  return JSON.stringify(params, null, 2);
}
