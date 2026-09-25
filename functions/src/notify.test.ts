import { describe, expect, it } from 'vitest';

import type { PushPayload } from './catalogue.js';
import { sendToUser, UNREGISTERED_TOKEN_CODES } from './notify.js';
import { FakeDb, FakeMessaging } from './test-utils/fakes.js';

const PUSH: PushPayload = {
  notification: { title: 'Test', body: 'Test body' },
  data: { type: 'test', deepLink: 'pm://dashboard' },
};

describe('sendToUser', () => {
  it('sends to every fcmToken on the user doc', async () => {
    const db = new FakeDb();
    db.seed('users/u1', { fcmTokens: ['t1', 't2'] });
    const messaging = new FakeMessaging();

    const result = await sendToUser({ db, messaging }, 'u1', PUSH);

    expect(result).toEqual({ sent: 2, pruned: [] });
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.tokens).toEqual(['t1', 't2']);
    expect(messaging.sent[0]?.notification).toEqual(PUSH.notification);
    expect(messaging.sent[0]?.data).toEqual(PUSH.data);
  });

  it('no tokens on the user doc → no send', async () => {
    const db = new FakeDb();
    db.seed('users/u1', { fcmTokens: [] });
    const messaging = new FakeMessaging();

    const result = await sendToUser({ db, messaging }, 'u1', PUSH);

    expect(result).toEqual({ sent: 0, pruned: [] });
    expect(messaging.sent).toHaveLength(0);
  });

  it('user doc has no fcmTokens field at all → no send', async () => {
    const db = new FakeDb();
    db.seed('users/u1', {});
    const messaging = new FakeMessaging();

    const result = await sendToUser({ db, messaging }, 'u1', PUSH);

    expect(result).toEqual({ sent: 0, pruned: [] });
    expect(messaging.sent).toHaveLength(0);
  });

  it('missing user doc entirely → no send', async () => {
    const db = new FakeDb();
    const messaging = new FakeMessaging();

    const result = await sendToUser({ db, messaging }, 'ghost', PUSH);

    expect(result).toEqual({ sent: 0, pruned: [] });
    expect(messaging.sent).toHaveLength(0);
  });

  it('prunes tokens FCM reports as unregistered/invalid', async () => {
    const db = new FakeDb();
    db.seed('users/u1', { fcmTokens: ['good', 'dead', 'invalid'] });
    const messaging = new FakeMessaging();
    messaging.failTokens.set('dead', 'messaging/registration-token-not-registered');
    messaging.failTokens.set('invalid', 'messaging/invalid-registration-token');

    const result = await sendToUser({ db, messaging }, 'u1', PUSH);

    expect(result.sent).toBe(1);
    expect([...result.pruned].sort()).toEqual(['dead', 'invalid']);
    expect(db.get('users/u1')?.['fcmTokens']).toEqual(['good']);
  });

  it('does not prune a token that failed for an unrelated reason', async () => {
    const db = new FakeDb();
    db.seed('users/u1', { fcmTokens: ['t1', 't2'] });
    const messaging = new FakeMessaging();
    messaging.failTokens.set('t2', 'messaging/internal-error');

    const result = await sendToUser({ db, messaging }, 'u1', PUSH);

    expect(result).toEqual({ sent: 1, pruned: [] });
    expect(db.get('users/u1')?.['fcmTokens']).toEqual(['t1', 't2']);
  });

  it('never throws when the FCM send fails outright', async () => {
    const db = new FakeDb();
    db.seed('users/u1', { fcmTokens: ['t1'] });
    const messaging = new FakeMessaging();
    messaging.throwOnSend = new Error('FCM is down');

    await expect(sendToUser({ db, messaging }, 'u1', PUSH)).resolves.toEqual({
      sent: 0,
      pruned: [],
    });
  });
});

describe('UNREGISTERED_TOKEN_CODES', () => {
  it('includes the documented FCM dead-token codes', () => {
    expect(UNREGISTERED_TOKEN_CODES.has('messaging/registration-token-not-registered')).toBe(true);
    expect(UNREGISTERED_TOKEN_CODES.has('messaging/invalid-registration-token')).toBe(true);
    expect(UNREGISTERED_TOKEN_CODES.has('messaging/internal-error')).toBe(false);
  });
});
