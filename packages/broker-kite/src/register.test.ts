import { afterEach, describe, expect, it } from 'vitest';
import { clearBrokerRegistry, createAdapter, createReadAdapter, type BrokerCreds } from '@pm/core';
import { createKiteAdapter, createKiteReadAdapter, registerKiteAdapter } from './register.js';
import {
  FakeHttpClient,
  fixedClock,
  makeLoadedInstrumentMaster,
  makeSession,
  sampleHoldingsResponse,
} from './test-utils.js';

const kiteCreds: BrokerCreds = {
  broker: 'kite',
  kite: { apiKey: 'my-key', accessToken: 'my-token' },
};

afterEach(() => {
  clearBrokerRegistry();
});

describe('registerKiteAdapter', () => {
  it('registers both the full and read adapters so core.createAdapter/createReadAdapter work', async () => {
    registerKiteAdapter();

    const full = createAdapter(kiteCreds);
    expect(full.broker).toBe('kite');
    expect(typeof full.placeOrder).toBe('function');

    const read = createReadAdapter(kiteCreds);
    expect(read.broker).toBe('kite');
    expect('placeOrder' in (read as unknown as Record<string, unknown>)).toBe(false);
  });

  it('wires the supplied static deps (http/instruments/clock) into every adapter it builds', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleHoldingsResponse());
    registerKiteAdapter({ http, instruments: makeLoadedInstrumentMaster(), clock: fixedClock() });

    const adapter = createAdapter(kiteCreds);
    await adapter.getHoldings();
    expect(http.requests).toHaveLength(1);
  });
});

describe('createKiteAdapter', () => {
  it('throws a clear error when BrokerCreds.kite is missing', () => {
    expect(() => createKiteAdapter({ broker: 'kite' })).toThrow(/BrokerCreds.kite/);
  });

  it('builds a working adapter from explicit deps, including a session override', async () => {
    const http = new FakeHttpClient();
    http.enqueue(sampleHoldingsResponse());
    const adapter = createKiteAdapter(kiteCreds, {
      http,
      instruments: makeLoadedInstrumentMaster(),
      clock: fixedClock(),
      session: () => makeSession({ accessToken: 'override-token' }),
    });
    await adapter.getHoldings();
    expect(http.requests[0]?.headers['Authorization']).toBe('token test-api-key:override-token');
  });

  it('honours an explicit expiresAt without a full session override', async () => {
    const adapter = createKiteAdapter(kiteCreds, {
      clock: fixedClock('2026-01-13T04:30:00.000Z'),
      expiresAt: '2026-01-13T18:30:00.000Z',
    });
    const status = await adapter.getSessionStatus();
    expect(status).toEqual({
      broker: 'kite',
      connected: true,
      expiresAt: '2026-01-13T18:30:00.000Z',
    });
  });

  it('fails closed when neither deps.expiresAt nor BrokerCreds.kite.expiresAt is supplied', async () => {
    // docs/00 §0.7.1: an unknown token lifetime is not "fine" — never invent a
    // future expiry. The registry path (createAdapter) relies on this too.
    const adapter = createKiteAdapter(kiteCreds, { clock: fixedClock('2026-01-13T04:30:00.000Z') });
    const status = await adapter.getSessionStatus();
    expect(status.connected).toBe(false);
  });

  it('uses BrokerCreds.kite.expiresAt when the credentials carry one', async () => {
    const adapter = createKiteAdapter(
      {
        broker: 'kite',
        kite: { apiKey: 'my-key', accessToken: 'my-token', expiresAt: '2026-01-13T18:30:00.000Z' },
      },
      { clock: fixedClock('2026-01-13T04:30:00.000Z') },
    );
    expect(await adapter.getSessionStatus()).toEqual({
      broker: 'kite',
      connected: true,
      expiresAt: '2026-01-13T18:30:00.000Z',
    });
  });

  it('reports connected:false when BrokerCreds.kite.expiresAt is already in the past', async () => {
    const adapter = createKiteAdapter(
      {
        broker: 'kite',
        kite: { apiKey: 'my-key', accessToken: 'my-token', expiresAt: '2026-01-13T00:30:00.000Z' },
      },
      { clock: fixedClock('2026-01-13T04:30:00.000Z') },
    );
    expect(await adapter.getSessionStatus()).toMatchObject({ connected: false });
  });

  it('lets an explicit deps.expiresAt override the expiry stored with the credentials', async () => {
    const adapter = createKiteAdapter(
      {
        broker: 'kite',
        kite: { apiKey: 'my-key', accessToken: 'my-token', expiresAt: '2026-01-13T00:30:00.000Z' },
      },
      { clock: fixedClock('2026-01-13T04:30:00.000Z'), expiresAt: '2026-01-13T18:30:00.000Z' },
    );
    expect(await adapter.getSessionStatus()).toMatchObject({
      connected: true,
      expiresAt: '2026-01-13T18:30:00.000Z',
    });
  });
});

describe('createKiteReadAdapter', () => {
  it('returns a read-only facade over the same credentials', () => {
    const read = createKiteReadAdapter(kiteCreds, { instruments: makeLoadedInstrumentMaster() });
    expect(read.broker).toBe('kite');
    expect('placeOrder' in (read as unknown as Record<string, unknown>)).toBe(false);
  });
});
