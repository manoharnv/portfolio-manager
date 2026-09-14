import { beforeEach, describe, expect, it } from 'vitest';
import { createAuditWriter } from './audit.js';
import {
  MAX_PARAMS_BYTES,
  createStrategiesService,
  validateStrategyPatch,
  type StrategiesService,
} from './strategies.js';
import {
  FakeAuditLog,
  FakeStrategyDefsRepo,
  FixedClock,
  SeqIdGenerator,
} from '../test-utils/fakes.js';
import { MARKET_OPEN_NOW } from '../test-utils/fixtures.js';

/** A params object whose JSON is just over the 8 KB ceiling. */
function oversizedParams(): Record<string, unknown> {
  return { blob: 'x'.repeat(MAX_PARAMS_BYTES) };
}

describe('validateStrategyPatch', () => {
  it('accepts either field alone and both together', () => {
    expect(validateStrategyPatch({ enabled: false })).toEqual({
      ok: true,
      patch: { enabled: false },
    });
    expect(validateStrategyPatch({ params: { dma: 20 } })).toEqual({
      ok: true,
      patch: { params: { dma: 20 } },
    });
    expect(validateStrategyPatch({ enabled: true, params: {} })).toMatchObject({ ok: true });
  });

  it('requires at least one field', () => {
    const result = validateStrategyPatch({});
    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toMatch(/at least one/);
  });

  it('rejects a non-object body', () => {
    expect(validateStrategyPatch(null)).toMatchObject({ ok: false });
    expect(validateStrategyPatch('enabled')).toMatchObject({ ok: false });
    expect(validateStrategyPatch([{ enabled: true }])).toMatchObject({ ok: false });
  });

  it('rejects unsupported fields rather than silently dropping them', () => {
    const result = validateStrategyPatch({ enabled: true, bookId: 'scalp' });
    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toMatch(/bookId/);
  });

  it('rejects a non-boolean enabled', () => {
    expect(validateStrategyPatch({ enabled: 'yes' })).toMatchObject({ ok: false });
  });

  it('rejects params that are not a plain object', () => {
    expect(validateStrategyPatch({ params: [1, 2] })).toMatchObject({ ok: false });
    expect(validateStrategyPatch({ params: null })).toMatchObject({ ok: false });
    expect(validateStrategyPatch({ params: 'dma=20' })).toMatchObject({ ok: false });
  });

  it('allows nested arrays inside params — only the top level is constrained', () => {
    expect(validateStrategyPatch({ params: { windows: [20, 50] } })).toMatchObject({ ok: true });
  });

  it('rejects params over the 8 KB ceiling', () => {
    const result = validateStrategyPatch({ params: oversizedParams() });
    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toMatch(/limit is 8192/);
  });

  it('accepts params just under the ceiling', () => {
    const params = { blob: 'x'.repeat(MAX_PARAMS_BYTES - 20) };
    expect(validateStrategyPatch({ params })).toMatchObject({ ok: true });
  });

  it('rejects params that cannot be serialised at all', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = validateStrategyPatch({ params: circular });

    expect(result).toMatchObject({ ok: false });
    expect((result as { detail: string }).detail).toMatch(/JSON-serialisable/);
  });

  it('does not judge params semantics', () => {
    expect(
      validateStrategyPatch({ params: { dma: -1, nonsense: { deeply: { nested: true } } } }),
    ).toMatchObject({ ok: true });
  });
});

interface Harness {
  service: StrategiesService;
  defs: FakeStrategyDefsRepo;
  auditLog: FakeAuditLog;
}

function harness(): Harness {
  const clock = new FixedClock(MARKET_OPEN_NOW);
  const auditLog = new FakeAuditLog();
  const defs = new FakeStrategyDefsRepo([
    {
      uid: 'u1',
      strategyId: 'momentum-v1',
      def: { id: 'momentum-v1', enabled: true, bookId: 'long_term', params: { dma: 20, atr: 14 } },
    },
  ]);
  const service = createStrategiesService({
    defs,
    audit: createAuditWriter({ audit: auditLog, ids: new SeqIdGenerator(), clock, ip: '1.2.3.4' }),
  });
  return { service, defs, auditLog };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('patchStrategy', () => {
  it('merges the patch and returns the merged document', async () => {
    const result = await h.service.patchStrategy({
      uid: 'u1',
      strategyId: 'momentum-v1',
      patch: { enabled: false },
    });

    expect(result).toMatchObject({ ok: true });
    expect((result as { def: Record<string, unknown> }).def).toEqual({
      id: 'momentum-v1',
      enabled: false,
      bookId: 'long_term',
      params: { dma: 20, atr: 14 },
    });
  });

  it('replaces params wholesale — the app sends the full object', async () => {
    const result = await h.service.patchStrategy({
      uid: 'u1',
      strategyId: 'momentum-v1',
      patch: { params: { dma: 50 } },
    });

    const def = (result as unknown as { def: Record<string, unknown> }).def;
    expect(def['params']).toEqual({ dma: 50 });
    expect(def['enabled']).toBe(true);
  });

  it('audits the change', async () => {
    await h.service.patchStrategy({
      uid: 'u1',
      strategyId: 'momentum-v1',
      patch: { enabled: false },
    });

    expect(h.auditLog.byType('config.changed')[0]).toMatchObject({
      actor: 'app-user',
      refId: 'momentum-v1',
      detail: { field: 'strategy', strategyId: 'momentum-v1', patch: { enabled: false } },
    });
  });

  it('does not create a def that the operator never provisioned', async () => {
    const result = await h.service.patchStrategy({
      uid: 'u1',
      strategyId: 'never-heard-of-it',
      patch: { enabled: true },
    });

    expect(result).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(h.defs.docs.has('u1:never-heard-of-it')).toBe(false);
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('scopes defs to the owner', async () => {
    expect(
      await h.service.patchStrategy({
        uid: 'intruder',
        strategyId: 'momentum-v1',
        patch: { enabled: false },
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(h.defs.docs.get('u1:momentum-v1')).toMatchObject({ enabled: true });
  });

  it('rejects a bad body before touching the store', async () => {
    const result = await h.service.patchStrategy({
      uid: 'u1',
      strategyId: 'momentum-v1',
      patch: {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'INVALID_PAYLOAD' });
    expect(h.defs.docs.get('u1:momentum-v1')).toMatchObject({ enabled: true });
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('rejects oversized params before touching the store', async () => {
    const result = await h.service.patchStrategy({
      uid: 'u1',
      strategyId: 'momentum-v1',
      patch: { params: oversizedParams() },
    });

    expect(result).toMatchObject({ ok: false, reason: 'INVALID_PAYLOAD' });
    expect(h.defs.docs.get('u1:momentum-v1')).toMatchObject({ params: { dma: 20, atr: 14 } });
  });
});
