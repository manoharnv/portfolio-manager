import { MAX_PARAMS_BYTES, formatParams, parseParams, utf8Bytes } from './strategyParams';

describe('utf8Bytes', () => {
  it('counts multi-byte characters properly', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('₹')).toBe(3);
    expect(utf8Bytes('😀')).toBe(4);
    expect(utf8Bytes('')).toBe(0);
  });
});

describe('parseParams', () => {
  it('treats a blank editor as "no params"', () => {
    expect(parseParams('')).toEqual({ ok: true, value: {} });
    expect(parseParams('   \n ')).toEqual({ ok: true, value: {} });
  });

  it('accepts a plain JSON object', () => {
    expect(parseParams('{"rsiPeriod": 14, "band": {"lower": 2}}')).toEqual({
      ok: true,
      value: { rsiPeriod: 14, band: { lower: 2 } },
    });
  });

  it('refuses anything that is not a plain object', () => {
    expect(parseParams('[1,2]')).toMatchObject({ ok: false });
    expect(parseParams('null')).toMatchObject({ ok: false });
    expect(parseParams('42')).toMatchObject({ ok: false });
    expect(parseParams('"text"')).toMatchObject({ ok: false });
    expect((parseParams('[1,2]') as { error: string }).error).toContain('JSON object');
  });

  it('refuses malformed JSON with the parser’s own message', () => {
    const result = parseParams('{oops}');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('not valid JSON');
  });

  it('refuses a body over the 8 KB cap', () => {
    const big = JSON.stringify({ blob: 'x'.repeat(MAX_PARAMS_BYTES) });
    const result = parseParams(big);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('at most 8 KB');
  });

  it('accepts a body just under the cap', () => {
    const nearly = JSON.stringify({ blob: 'x'.repeat(MAX_PARAMS_BYTES - 200) });
    expect(parseParams(nearly).ok).toBe(true);
  });
});

describe('formatParams', () => {
  it('pretty-prints and treats empty as blank', () => {
    expect(formatParams({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatParams({})).toBe('');
    expect(formatParams(undefined)).toBe('');
  });
});
