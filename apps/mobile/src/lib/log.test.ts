import { log, redact } from './log';

describe('redact', () => {
  it('replaces any value under a credential-ish key', () => {
    expect(
      redact({
        idToken: 'abc',
        accessToken: 'xyz',
        apiKey: 'k',
        Authorization: 'Bearer x',
        password: 'p',
        biometricAssertion: 'a',
        symbol: 'INFY',
      }),
    ).toEqual({
      idToken: '[redacted]',
      accessToken: '[redacted]',
      apiKey: '[redacted]',
      Authorization: '[redacted]',
      password: '[redacted]',
      biometricAssertion: '[redacted]',
      symbol: 'INFY',
    });
  });

  it('drops a JWT-shaped string even under an innocent key', () => {
    expect(redact({ note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' })).toEqual({
      note: '[redacted]',
    });
  });

  it('walks arrays and nested objects', () => {
    expect(redact({ list: [{ token: 't' }, 'plain'] })).toEqual({
      list: [{ token: '[redacted]' }, 'plain'],
    });
  });

  it('stops descending rather than recursing forever', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(redact(deep))).toContain('[deep]');
  });

  it('passes primitives through', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });
});

describe('log', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  afterAll(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  it('redacts context on every level', () => {
    log.warn('careful', { idToken: 'secret' });
    expect(warn).toHaveBeenCalledWith('[pm] careful', { idToken: '[redacted]' });

    log.error('bad', { apiKey: 'secret' });
    expect(error).toHaveBeenCalledWith('[pm] bad', { apiKey: '[redacted]' });
  });

  it('emits an empty context marker rather than the string "undefined"', () => {
    log.warn('plain');
    expect(warn).toHaveBeenCalledWith('[pm] plain', '');
  });

  it('emits info only in development', () => {
    warn.mockClear();
    log.info('dev only', { a: 1 });
    // jest-expo sets __DEV__ = true.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
