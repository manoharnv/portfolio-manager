import { describe, expect, it } from 'vitest';

import { FakeDb, FakeMessaging } from '../test-utils/fakes.js';
import { makeBrokerSession, makeConfig } from '../test-utils/fixtures.js';
import { sessionReminder } from './sessionReminder.js';

function deps() {
  return { db: new FakeDb(), messaging: new FakeMessaging() };
}

describe('sessionReminder', () => {
  it('pushes for a user disconnected on their active broker', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'dhan' }));
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed(
      'brokerSessions/u1/brokers/dhan',
      makeBrokerSession({ broker: 'dhan', connected: false }),
    );

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 1 });
    expect(d.messaging.sent[0]?.notification.body).toBe('Connect your broker for today');
    expect(d.messaging.sent[0]?.data['deepLink']).toBe('pm://broker-connect');
  });

  it('skips a user connected on their active broker', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'dhan' }));
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed(
      'brokerSessions/u1/brokers/dhan',
      makeBrokerSession({ broker: 'dhan', connected: true }),
    );

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 0 });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('only checks the active broker — a connected inactive broker does not count', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'kite' }));
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    // Connected on dhan, but dhan is not the active broker; kite has no session doc.
    d.db.seed(
      'brokerSessions/u1/brokers/dhan',
      makeBrokerSession({ broker: 'dhan', connected: true }),
    );

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 1 });
  });

  it('treats a missing session doc as disconnected', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'dhan' }));
    d.db.seed('users/u1', { fcmTokens: ['t1'] });

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 1 });
  });

  it('treats a malformed brokerSession doc as disconnected (fails schema validation)', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'dhan' }));
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed('brokerSessions/u1/brokers/dhan', { connected: 'yes-please' });

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 1 });
  });

  it('handles multiple users independently', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'dhan' }));
    d.db.seed('config/u2', makeConfig({ uid: 'u2', activeBroker: 'kite' }));
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed('users/u2', { fcmTokens: ['t2'] });
    d.db.seed(
      'brokerSessions/u1/brokers/dhan',
      makeBrokerSession({ broker: 'dhan', connected: true }),
    );
    d.db.seed(
      'brokerSessions/u2/brokers/kite',
      makeBrokerSession({ broker: 'kite', connected: false }),
    );

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 1 });
    expect(d.messaging.sent).toHaveLength(1);
  });

  it('no tokens → not counted as notified even when disconnected', async () => {
    const d = deps();
    d.db.seed('config/u1', makeConfig({ uid: 'u1', activeBroker: 'dhan' }));
    d.db.seed('users/u1', { fcmTokens: [] });

    const result = await sessionReminder(d);

    expect(result).toEqual({ notifiedCount: 0 });
  });
});
