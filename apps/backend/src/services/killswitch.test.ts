import { beforeEach, describe, expect, it } from 'vitest';
import { createAuditWriter } from './audit.js';
import { createKillSwitchService, type KillSwitchService } from './killswitch.js';
import { FakeAuditLog, FakeConfigRepo, FixedClock, SeqIdGenerator } from '../test-utils/fakes.js';
import { makeConfig } from '../test-utils/fixtures.js';

const NOW = '2026-01-13T05:00:00.000Z';

interface Harness {
  service: KillSwitchService;
  configs: FakeConfigRepo;
  auditLog: FakeAuditLog;
}

function harness(): Harness {
  const clock = new FixedClock(NOW);
  const configs = new FakeConfigRepo([makeConfig()]);
  const auditLog = new FakeAuditLog();
  const service = createKillSwitchService({
    configs,
    clock,
    audit: createAuditWriter({ audit: auditLog, ids: new SeqIdGenerator(), clock, ip: '1.2.3.4' }),
  });
  return { service, configs, auditLog };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('setKillSwitch', () => {
  it('arms the switch and audits the transition', async () => {
    const result = await h.service.setKillSwitch({
      uid: 'u1',
      enabled: true,
      reason: 'weird fills',
    });

    expect(result).toEqual({ ok: true, killSwitch: true });
    expect(h.configs.docs.get('u1')).toMatchObject({ killSwitch: true, updatedAt: NOW });
    expect(h.auditLog.byType('killswitch.toggled')[0]).toMatchObject({
      actor: 'app-user',
      detail: { from: false, to: true, reason: 'weird fills' },
    });
  });

  it('disarms the switch', async () => {
    h.configs.docs.set('u1', makeConfig({ killSwitch: true }));
    expect(await h.service.setKillSwitch({ uid: 'u1', enabled: false })).toEqual({
      ok: true,
      killSwitch: false,
    });
    expect(h.auditLog.byType('killswitch.toggled')[0]?.detail).toMatchObject({
      from: true,
      to: false,
      reason: null,
    });
  });

  it('is idempotent', async () => {
    await h.service.setKillSwitch({ uid: 'u1', enabled: true });
    expect(await h.service.setKillSwitch({ uid: 'u1', enabled: true })).toEqual({
      ok: true,
      killSwitch: true,
    });
    expect(h.auditLog.byType('killswitch.toggled')).toHaveLength(2);
  });

  it('reports a missing config rather than inventing one', async () => {
    const result = await h.service.setKillSwitch({ uid: 'ghost', enabled: true });

    expect(result).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(h.configs.docs.has('ghost')).toBe(false);
    expect(h.auditLog.events).toHaveLength(0);
  });
});
