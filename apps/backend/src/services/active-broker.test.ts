import { beforeEach, describe, expect, it } from 'vitest';
import { createAuditWriter } from './audit.js';
import { createActiveBrokerService, type ActiveBrokerService } from './active-broker.js';
import {
  FakeAuditLog,
  FakeConfigRepo,
  FakeSessionStore,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import { MARKET_OPEN_NOW, makeBrokerSession, makeConfig } from '../test-utils/fixtures.js';

interface Harness {
  service: ActiveBrokerService;
  configs: FakeConfigRepo;
  sessions: FakeSessionStore;
  auditLog: FakeAuditLog;
}

function harness(): Harness {
  const clock = new FixedClock(MARKET_OPEN_NOW);
  const configs = new FakeConfigRepo([makeConfig({ activeBroker: 'dhan' })]);
  const sessions = new FakeSessionStore([
    { uid: 'u1', session: makeBrokerSession({ broker: 'dhan' }) },
    { uid: 'u1', session: makeBrokerSession({ broker: 'kite' }) },
  ]);
  const auditLog = new FakeAuditLog();
  const service = createActiveBrokerService({
    configs,
    sessions,
    clock,
    audit: createAuditWriter({ audit: auditLog, ids: new SeqIdGenerator(), clock, ip: '1.2.3.4' }),
  });
  return { service, configs, sessions, auditLog };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('setActiveBroker', () => {
  it('switches when the target broker has a live session', async () => {
    const result = await h.service.setActiveBroker({ uid: 'u1', broker: 'kite' });

    expect(result).toEqual({ ok: true, activeBroker: 'kite' });
    expect(h.configs.docs.get('u1')?.activeBroker).toBe('kite');
    expect(h.configs.docs.get('u1')?.updatedAt).toBe(MARKET_OPEN_NOW);
  });

  it('audits the change with the old and new broker', async () => {
    await h.service.setActiveBroker({ uid: 'u1', broker: 'kite' });

    expect(h.auditLog.byType('config.changed')[0]).toMatchObject({
      actor: 'app-user',
      detail: { field: 'activeBroker', from: 'dhan', to: 'kite' },
    });
  });

  it('is a no-op when the broker is already active', async () => {
    const result = await h.service.setActiveBroker({ uid: 'u1', broker: 'dhan' });

    expect(result).toEqual({ ok: true, activeBroker: 'dhan' });
    // No write, no audit — a non-change is not a change.
    expect(h.auditLog.events).toHaveLength(0);
    expect(h.configs.docs.get('u1')?.updatedAt).toBe('2026-01-13T03:00:00.000Z');
  });

  it('refuses when the target broker was never connected', async () => {
    h.sessions.docs.delete('u1:kite');
    const result = await h.service.setActiveBroker({ uid: 'u1', broker: 'kite' });

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect((result as { detail: string }).detail).toContain('kite');
    expect(h.configs.docs.get('u1')?.activeBroker).toBe('dhan');
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('refuses a disconnected target session', async () => {
    await h.sessions.set('u1', makeBrokerSession({ broker: 'kite', connected: false }));
    expect(await h.service.setActiveBroker({ uid: 'u1', broker: 'kite' })).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('refuses a target session inside the expiry safety margin', async () => {
    await h.sessions.set(
      'u1',
      makeBrokerSession({ broker: 'kite', expiresAt: '2026-01-13T04:31:00.000Z' }),
    );
    const result = await h.service.setActiveBroker({ uid: 'u1', broker: 'kite' });

    expect(result).toMatchObject({ ok: false, reason: 'SESSION_INVALID' });
    expect((result as { detail: string }).detail).toMatch(/safety margin/);
  });

  it('refuses a target session whose IP was rejected', async () => {
    await h.sessions.set('u1', makeBrokerSession({ broker: 'kite', staticIpOk: false }));
    expect(await h.service.setActiveBroker({ uid: 'u1', broker: 'kite' })).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('gates a redundant switch on the session too, so 200 always means usable', async () => {
    await h.sessions.set('u1', makeBrokerSession({ broker: 'dhan', connected: false }));
    expect(await h.service.setActiveBroker({ uid: 'u1', broker: 'dhan' })).toMatchObject({
      ok: false,
      reason: 'SESSION_INVALID',
    });
  });

  it('reports a missing config rather than inventing one', async () => {
    const result = await h.service.setActiveBroker({ uid: 'ghost', broker: 'kite' });

    expect(result).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(h.configs.docs.has('ghost')).toBe(false);
  });
});
