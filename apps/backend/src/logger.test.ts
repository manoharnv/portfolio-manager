import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { REDACTED_PLACEHOLDER, createLogger, silentLogger } from './logger.js';

/** Collects pino's NDJSON output without touching a real stream. */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('redacts credential fields at the top level', () => {
    const sink = capture();
    const logger = createLogger({ level: 'info', destination: sink.stream });
    logger.info({ accessToken: 'secret-token', apiSecret: 'shh', apiKey: 'k' }, 'creds');

    const line = sink.lines()[0]!;
    expect(line['accessToken']).toBe(REDACTED_PLACEHOLDER);
    expect(line['apiSecret']).toBe(REDACTED_PLACEHOLDER);
    expect(line['apiKey']).toBe(REDACTED_PLACEHOLDER);
    expect(JSON.stringify(line)).not.toContain('secret-token');
  });

  it('redacts nested credential fields and auth headers', () => {
    const sink = capture();
    const logger = createLogger({ level: 'info', destination: sink.stream });
    logger.warn(
      {
        creds: { accessToken: 'nested-token', requestToken: 'rt' },
        req: { headers: { authorization: 'Bearer abc.def.ghi' } },
      },
      'request',
    );

    const raw = JSON.stringify(sink.lines()[0]);
    expect(raw).not.toContain('nested-token');
    expect(raw).not.toContain('Bearer abc.def.ghi');
    expect(raw).not.toContain('"rt"');
    expect(raw).toContain(REDACTED_PLACEHOLDER);
  });

  it('keeps non-credential fields intact', () => {
    const sink = capture();
    const logger = createLogger({ level: 'info', destination: sink.stream });
    logger.info({ orderId: 'ord_1', accessToken: 'x' }, 'placed');

    const line = sink.lines()[0]!;
    expect(line['orderId']).toBe('ord_1');
    expect(line['msg']).toBe('placed');
  });

  it('applies static base bindings and the level', () => {
    const sink = capture();
    const logger = createLogger({
      level: 'debug',
      base: { service: 'pm-backend' },
      destination: sink.stream,
    });
    logger.debug({ a: 1 }, 'hello');

    const line = sink.lines()[0]!;
    expect(line['service']).toBe('pm-backend');
    expect(logger.level).toBe('debug');
  });

  it('redacts through a child logger too', () => {
    const sink = capture();
    const logger = createLogger({ level: 'info', destination: sink.stream }).child({ uid: 'u1' });
    logger.error({ accessToken: 'child-token' }, 'oops');

    const raw = JSON.stringify(sink.lines()[0]);
    expect(raw).not.toContain('child-token');
    expect(raw).toContain('u1');
  });
});

describe('silentLogger', () => {
  it('swallows everything and keeps returning itself', () => {
    const logger = silentLogger();
    expect(() => {
      logger.info({}, 'a');
      logger.warn({}, 'b');
      logger.error({}, 'c');
      logger.debug({}, 'd');
    }).not.toThrow();
    expect(logger.child({ uid: 'u1' })).toBe(logger);
  });
});
