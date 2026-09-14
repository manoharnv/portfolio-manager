import { describe, expect, it } from 'vitest';
import { sessionRefusal, toSessionStatus } from './session-status.js';
import { makeBrokerSession, makeSessionStatus } from './test-utils/fixtures.js';

const NOW = new Date('2026-01-13T04:30:00.000Z');

describe('toSessionStatus', () => {
  it('maps the Firestore document onto the neutral status', () => {
    expect(toSessionStatus(makeBrokerSession())).toEqual({
      broker: 'dhan',
      connected: true,
      staticIpOk: true,
      expiresAt: '2026-01-13T18:30:00.000Z',
    });
  });

  it('drops a null expiry rather than passing null through', () => {
    const status = toSessionStatus(makeBrokerSession({ expiresAt: null }));
    expect(status.expiresAt).toBeUndefined();
    expect('expiresAt' in status).toBe(false);
  });
});

describe('sessionRefusal', () => {
  it('accepts a healthy session', () => {
    expect(sessionRefusal(makeSessionStatus(), 'dhan', NOW)).toBeUndefined();
  });

  it('refuses an absent session', () => {
    expect(sessionRefusal(undefined, 'dhan', NOW)).toMatch(/no broker session/);
  });

  it('refuses a session for a different broker', () => {
    expect(sessionRefusal(makeSessionStatus({ broker: 'kite' }), 'dhan', NOW)).toMatch(
      /activeBroker/,
    );
  });

  it('refuses a disconnected session', () => {
    expect(sessionRefusal(makeSessionStatus({ connected: false }), 'dhan', NOW)).toMatch(
      /not connected/,
    );
  });

  it('refuses after an IP rejection', () => {
    expect(sessionRefusal(makeSessionStatus({ staticIpOk: false }), 'dhan', NOW)).toMatch(
      /IP-rejected/,
    );
  });

  it('refuses when the expiry is unknown', () => {
    expect(sessionRefusal(makeSessionStatus({ expiresAt: undefined }), 'dhan', NOW)).toMatch(
      /expiry unknown/,
    );
  });

  it('refuses an unparseable expiry', () => {
    expect(sessionRefusal(makeSessionStatus({ expiresAt: 'soon' }), 'dhan', NOW)).toMatch(
      /unparseable/,
    );
  });

  it('refuses inside the safety margin but accepts just outside it', () => {
    // Core's default margin is 120s.
    expect(
      sessionRefusal(makeSessionStatus({ expiresAt: '2026-01-13T04:32:00.000Z' }), 'dhan', NOW),
    ).toMatch(/safety margin/);
    expect(
      sessionRefusal(makeSessionStatus({ expiresAt: '2026-01-13T04:32:01.000Z' }), 'dhan', NOW),
    ).toBeUndefined();
  });

  it('honours a custom margin', () => {
    expect(
      sessionRefusal(
        makeSessionStatus({ expiresAt: '2026-01-13T05:00:00.000Z' }),
        'dhan',
        NOW,
        3600,
      ),
    ).toMatch(/safety margin/);
  });
});
