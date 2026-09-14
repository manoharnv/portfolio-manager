import { describe, expect, it } from 'vitest';
import { REDACT_CENSOR, REDACT_PATHS, createLogger } from './logger.js';

function capture(): { write: (chunk: string) => void; entries: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  return {
    write: (chunk: string): void => {
      chunks.push(chunk);
    },
    entries: (): Record<string, unknown>[] =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('writes structured JSON with a service name', () => {
    const sink = capture();
    createLogger({ destination: sink, level: 'info', name: 'test-engine' }).info(
      { proposalId: 'p1' },
      'written',
    );
    const [entry] = sink.entries();
    expect(entry).toMatchObject({ service: 'test-engine', proposalId: 'p1', msg: 'written' });
  });

  it('redacts credentials at the top level and one level down', () => {
    const sink = capture();
    const log = createLogger({ destination: sink, level: 'info' });
    log.info({ accessToken: 'secret-1', broker: { apiKey: 'secret-2' } }, 'never leak');
    const [entry] = sink.entries();
    expect(entry?.['accessToken']).toBe(REDACT_CENSOR);
    expect(entry?.['broker']).toEqual({ apiKey: REDACT_CENSOR });
    expect(JSON.stringify(entry)).not.toContain('secret-');
  });

  it('covers every credential-shaped field name', () => {
    expect(REDACT_PATHS).toContain('accessToken');
    expect(REDACT_PATHS).toContain('*.accessToken');
    expect(REDACT_PATHS).toContain('creds');
  });

  it('carries child bindings onto every line', () => {
    const sink = capture();
    createLogger({ destination: sink, level: 'info' })
      .child({ uid: 'u1', tick: 'intraday' })
      .warn({ reason: 'kill_switch' }, 'skipped');
    const [entry] = sink.entries();
    expect(entry).toMatchObject({ uid: 'u1', tick: 'intraday', reason: 'kill_switch' });
  });

  it('respects the configured level', () => {
    const sink = capture();
    const log = createLogger({ destination: sink, level: 'warn' });
    log.info({}, 'dropped');
    log.debug({}, 'dropped');
    log.error({}, 'kept');
    expect(sink.entries().map((e) => e['msg'])).toEqual(['kept']);
  });

  it('builds a default stdout logger without throwing', () => {
    expect(typeof createLogger().info).toBe('function');
  });
});
