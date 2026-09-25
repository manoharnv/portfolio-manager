import { beforeEach, describe, expect, it } from 'vitest';
import { BrokerError } from '@pm/core';
import { SessionUnavailableError } from '../ports/index.js';
import { createAuditWriter } from './audit.js';
import { createPortfolioService, type PortfolioService } from './portfolio.js';
import {
  FakeAuditLog,
  FakeBrokerAdapter,
  FakeBrokerGateway,
  FakePortfolioCache,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import { INFY, makeFunds, makeHolding, makePosition } from '../test-utils/fixtures.js';

const NOW = '2026-01-13T05:00:00.000Z';

interface Harness {
  service: PortfolioService;
  cache: FakePortfolioCache;
  adapter: FakeBrokerAdapter;
  broker: FakeBrokerGateway;
  auditLog: FakeAuditLog;
}

function harness(): Harness {
  const clock = new FixedClock(NOW);
  const cache = new FakePortfolioCache();
  const adapter = new FakeBrokerAdapter({
    holdings: [makeHolding(), makeHolding({ symbol: INFY, quantity: 4 })],
    positions: [makePosition()],
    funds: makeFunds({ availableMargin: 123_456 }),
  });
  const broker = new FakeBrokerGateway(adapter);
  const auditLog = new FakeAuditLog();
  const service = createPortfolioService({
    broker,
    cache,
    clock,
    audit: createAuditWriter({ audit: auditLog, ids: new SeqIdGenerator(), clock, ip: '1.2.3.4' }),
  });
  return { service, cache, adapter, broker, auditLog };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('refresh', () => {
  it('fetches the live snapshot and writes it to the cache', async () => {
    const result = await h.service.refresh('u1');

    expect(result).toMatchObject({ ok: true, at: NOW });
    const snapshot = (
      result as { snapshot: { holdings: unknown[]; funds: { availableMargin: number } } }
    ).snapshot;
    expect(snapshot.holdings).toHaveLength(2);
    expect(snapshot.funds.availableMargin).toBe(123_456);

    expect(h.cache.writes).toHaveLength(1);
    expect(h.cache.writes[0]).toMatchObject({ uid: 'u1', at: NOW });
  });

  it('reports a missing session without writing the cache', async () => {
    h.broker.error = new SessionUnavailableError('dhan', 'no token');
    const result = await h.service.refresh('u1');

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect(h.cache.writes).toHaveLength(0);
  });

  it('reports a non-session gateway failure as SESSION_INVALID too', async () => {
    h.broker.error = new Error('gateway exploded');
    expect(await h.service.refresh('u1')).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
  });

  it('never serves a stale snapshot when a read fails', async () => {
    h.adapter.script.throwOn = { getPositions: new BrokerError('NETWORK', 'timeout') };
    const result = await h.service.refresh('u1');

    expect(result).toMatchObject({ ok: false, reason: 'BROKER_ERROR', brokerErrorKind: 'NETWORK' });
    expect(h.cache.writes).toHaveLength(0);
  });

  it('maps AUTH_EXPIRED to a re-login refusal and audits it', async () => {
    h.adapter.script.throwOn = { getFunds: new BrokerError('AUTH_EXPIRED', 'token dead') };
    const result = await h.service.refresh('u1');

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect(h.auditLog.types()).toContain('session.expired');
  });

  it('maps a plain Error to UNKNOWN', async () => {
    h.adapter.script.throwOn = { getHoldings: new Error('kaboom') };
    expect(await h.service.refresh('u1')).toMatchObject({ brokerErrorKind: 'UNKNOWN' });
  });
});
