import {
  attachPushHandlers,
  getFcmToken,
  registerBackgroundHandler,
  registerForPush,
  registerFcmToken,
  requestPushPermission,
  routeForMessage,
} from './notifications';

const messaging = () => globalThis.__messagingMock;
const firestore = () => globalThis.__firestoreMock;

describe('permission', () => {
  it('accepts AUTHORIZED and PROVISIONAL', async () => {
    messaging().requestPermission.mockResolvedValueOnce(1);
    await expect(requestPushPermission()).resolves.toBe('granted');

    messaging().requestPermission.mockResolvedValueOnce(2);
    await expect(requestPushPermission()).resolves.toBe('provisional');
  });

  it('reports denied and unavailable', async () => {
    messaging().requestPermission.mockResolvedValueOnce(0);
    await expect(requestPushPermission()).resolves.toBe('denied');

    messaging().requestPermission.mockRejectedValueOnce(new Error('no native module'));
    await expect(requestPushPermission()).resolves.toBe('unavailable');
  });
});

describe('token registration', () => {
  it('writes the token into users/{uid}.fcmTokens with arrayUnion', async () => {
    await expect(registerFcmToken('u1', 'fcm-token-123')).resolves.toBe(true);

    expect(firestore().updates).toEqual([
      { path: 'users/u1', data: { fcmTokens: { __arrayUnion: ['fcm-token-123'] } } },
    ]);
    // firestore.rules `hasOnly(['fcmTokens','prefs'])` — only fcmTokens is sent.
    expect(Object.keys(firestore().updates[0]!.data)).toEqual(['fcmTokens']);
  });

  it('is non-fatal when the write is refused', async () => {
    firestore().failNextUpdate(new Error('permission-denied'));
    await expect(registerFcmToken('u1', 't')).resolves.toBe(false);
  });

  it('returns undefined rather than an empty token', async () => {
    messaging().getToken.mockResolvedValueOnce('');
    await expect(getFcmToken()).resolves.toBeUndefined();

    messaging().getToken.mockRejectedValueOnce(new Error('no APNs token'));
    await expect(getFcmToken()).resolves.toBeUndefined();
  });

  it('runs permission → token → Firestore in one call', async () => {
    messaging().requestPermission.mockResolvedValueOnce(1);
    messaging().getToken.mockResolvedValueOnce('fcm-xyz');

    await expect(registerForPush('u1')).resolves.toEqual({
      permission: 'granted',
      registered: true,
      token: 'fcm-xyz',
    });
    expect(firestore().updates[0]?.path).toBe('users/u1');
  });

  it('does not even ask for a token when permission is denied', async () => {
    messaging().requestPermission.mockResolvedValueOnce(0);
    await expect(registerForPush('u1')).resolves.toEqual({
      permission: 'denied',
      registered: false,
    });
    expect(messaging().getToken).not.toHaveBeenCalled();
  });

  it('reports not-registered when there is no token', async () => {
    messaging().requestPermission.mockResolvedValueOnce(1);
    messaging().getToken.mockResolvedValueOnce('');
    await expect(registerForPush('u1')).resolves.toEqual({
      permission: 'granted',
      registered: false,
    });
  });
});

describe('deep-link routing from a push', () => {
  // The catalogue's five link families (functions/src/catalogue.ts).
  it.each([
    [{ type: 'proposal', proposalId: 'p1', deepLink: 'pm://proposals/p1' }, '/proposals/p1'],
    [{ type: 'order', orderId: 'o1', deepLink: 'pm://orders/o1' }, '/orders/o1'],
    [{ type: 'session', deepLink: 'pm://broker-connect' }, '/broker'],
    [{ type: 'audit', deepLink: 'pm://audit' }, '/audit'],
    [{ type: 'killswitch', deepLink: 'pm://dashboard' }, '/'],
  ])('%j → %s', (data, expected) => {
    expect(routeForMessage({ data } as never)).toBe(expected);
  });

  it('ignores a message with no data at all', () => {
    expect(routeForMessage(null)).toBeUndefined();
    expect(routeForMessage({} as never)).toBeUndefined();
  });

  it('drops non-string data values instead of coercing them', () => {
    expect(routeForMessage({ data: { type: 'audit', n: 3 } } as never)).toBe('/audit');
  });
});

describe('attachPushHandlers', () => {
  it('routes a notification tap through onOpened', () => {
    let openedListener: ((m: unknown) => void) | undefined;
    messaging().onNotificationOpenedApp.mockImplementation((_m: unknown, listener: never) => {
      openedListener = listener;
      return jest.fn();
    });

    const onOpened = jest.fn();
    attachPushHandlers({ onForeground: jest.fn(), onOpened });

    openedListener?.({ data: { type: 'order', orderId: 'o7', deepLink: 'pm://orders/o7' } });
    expect(onOpened).toHaveBeenCalledWith('/orders/o7', expect.anything());
  });

  it('ignores a tap whose payload routes nowhere', () => {
    let openedListener: ((m: unknown) => void) | undefined;
    messaging().onNotificationOpenedApp.mockImplementation((_m: unknown, listener: never) => {
      openedListener = listener;
      return jest.fn();
    });
    const onOpened = jest.fn();
    attachPushHandlers({ onForeground: jest.fn(), onOpened });

    openedListener?.({ data: { type: 'mystery' } });
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('passes a foreground message straight through', () => {
    let foregroundListener: ((m: unknown) => void) | undefined;
    messaging().onMessage.mockImplementation((_m: unknown, listener: never) => {
      foregroundListener = listener;
      return jest.fn();
    });
    const onForeground = jest.fn();
    attachPushHandlers({ onForeground, onOpened: jest.fn() });

    foregroundListener?.({ data: { type: 'proposal' } });
    expect(onForeground).toHaveBeenCalled();
  });

  it('routes a cold-start notification', async () => {
    messaging().getInitialNotification.mockResolvedValueOnce({
      data: { type: 'proposal', proposalId: 'p3', deepLink: 'pm://proposals/p3' },
    });
    const onOpened = jest.fn();
    attachPushHandlers({ onForeground: jest.fn(), onOpened });

    await Promise.resolve();
    await Promise.resolve();
    expect(onOpened).toHaveBeenCalledWith('/proposals/p3', expect.anything());
  });

  it('does not route a cold-start notification after unsubscribe', async () => {
    let resolveInitial: (value: unknown) => void = () => undefined;
    messaging().getInitialNotification.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );
    const onOpened = jest.fn();
    const detach = attachPushHandlers({ onForeground: jest.fn(), onOpened });

    detach();
    resolveInitial({ data: { type: 'audit', deepLink: 'pm://audit' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('unsubscribes both listeners', () => {
    const unsubA = jest.fn();
    const unsubB = jest.fn();
    messaging().onMessage.mockReturnValueOnce(unsubA);
    messaging().onNotificationOpenedApp.mockReturnValueOnce(unsubB);

    attachPushHandlers({ onForeground: jest.fn(), onOpened: jest.fn() })();
    expect(unsubA).toHaveBeenCalled();
    expect(unsubB).toHaveBeenCalled();
  });

  it('swallows a failing getInitialNotification', async () => {
    messaging().getInitialNotification.mockRejectedValueOnce(new Error('nope'));
    expect(() =>
      attachPushHandlers({ onForeground: jest.fn(), onOpened: jest.fn() }),
    ).not.toThrow();
    await Promise.resolve();
  });
});

describe('registerBackgroundHandler', () => {
  it('installs a handler that does not throw on a data push', async () => {
    registerBackgroundHandler();
    const handler = messaging().setBackgroundMessageHandler.mock.calls[0]?.[1] as (
      m: unknown,
    ) => Promise<void>;
    await expect(handler({ data: { type: 'proposal' } })).resolves.toBeUndefined();
    await expect(handler({})).resolves.toBeUndefined();
  });
});
