/**
 * `@pm/broker-dhan` — the DhanHQ v2 implementation of core's `BrokerAdapter`
 * (docs/02 §2.6).
 *
 * Importing this package does **nothing** on its own: `registerDhanAdapter()`
 * is an explicit call, so only a process that asks for order capability gets it
 * (docs/00 §0.7.4).
 *
 * Typical execution-backend wiring:
 *
 * ```ts
 * const instruments = new DhanInstrumentMaster();
 * instruments.loadFromCsv(await fetchCsv(http), new Date());
 * registerDhanAdapter({ instruments, session: (c) => sessionStore.get(c) });
 * const adapter = createAdapter({ broker: 'dhan', dhan: creds });   // @pm/core
 * ```
 */

export * from './http.js';
export * from './errors.js';
export * from './wire.js';
export * from './instruments.js';
export * from './auth.js';
export * from './consent.js';
export * from './adapter.js';
export * from './register.js';
