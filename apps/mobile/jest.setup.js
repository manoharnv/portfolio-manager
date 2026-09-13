/**
 * Global test doubles.
 *
 * docs/00 §0.5 is binding here: **no network, no Firestore, no real broker, no
 * wall-clock dependence**. Every native module and both Firebase runtimes are
 * replaced with in-memory fakes, and `fetch` is a jest.fn that must be given an
 * implementation by the test that needs it — an un-stubbed call throws, so a
 * test can never accidentally reach the internet.
 */

// ---------------------------------------------------------------------------
// expo-constants — the app's only config source
// ---------------------------------------------------------------------------
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        backendBaseUrl: 'https://backend.test',
        firebase: {
          apiKey: 'test-api-key',
          authDomain: 'test.firebaseapp.com',
          projectId: 'test-project',
          storageBucket: 'test.firebasestorage.app',
          messagingSenderId: '123456789',
          appId: '1:123456789:web:abc',
        },
        google: { webClientId: 'web.test', iosClientId: 'ios.test' },
        brokerLoginUrlTemplates: {},
        brokerRedirectUrl: 'pm://broker-callback',
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Firebase JS SDK
// ---------------------------------------------------------------------------
jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({ name: 'pm' })),
  getApp: jest.fn(() => ({ name: 'pm' })),
  getApps: jest.fn(() => []),
}));

jest.mock('firebase/auth', () => {
  const state = { user: null, listeners: new Set() };
  globalThis.__authMock = {
    state,
    setUser(user) {
      state.user = user;
      for (const listener of state.listeners) listener(user);
    },
    reset() {
      state.user = null;
      state.listeners.clear();
    },
  };
  const auth = {
    get currentUser() {
      return state.user;
    },
  };
  return {
    getAuth: jest.fn(() => auth),
    initializeAuth: jest.fn(() => auth),
    getReactNativePersistence: jest.fn(() => ({ type: 'rn' })),
    onAuthStateChanged: jest.fn((_auth, next) => {
      state.listeners.add(next);
      next(state.user);
      return () => state.listeners.delete(next);
    }),
    signOut: jest.fn(async () => {
      globalThis.__authMock.setUser(null);
    }),
    signInWithCredential: jest.fn(async () => ({ user: state.user })),
    updateProfile: jest.fn(async () => undefined),
    GoogleAuthProvider: { credential: jest.fn((token) => ({ provider: 'google', token })) },
    OAuthProvider: class {
      constructor(id) {
        this.id = id;
      }
      credential(params) {
        return { provider: this.id, ...params };
      }
    },
  };
});

jest.mock('firebase/firestore', () => {
  const registry = {
    listeners: new Map(),
    updates: [],
    updateError: undefined,
  };
  globalThis.__firestoreMock = {
    registry,
    /** Push a document snapshot to every listener on `path`. */
    emitDoc(path, data, options = {}) {
      for (const entry of registry.listeners.get(path) ?? []) {
        entry.next({
          id: options.id ?? path.split('/').pop(),
          exists: () => data !== undefined,
          data: () => data,
          metadata: { fromCache: options.fromCache ?? false },
        });
      }
    },
    /** Push a query snapshot; `docs` is `[{ id, data }]`. */
    emitCollection(path, docs, options = {}) {
      for (const entry of registry.listeners.get(path) ?? []) {
        entry.next({
          docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
          metadata: { fromCache: options.fromCache ?? false },
        });
      }
    },
    emitError(path, error) {
      for (const entry of registry.listeners.get(path) ?? []) entry.error(error);
    },
    listenerCount(path) {
      return (registry.listeners.get(path) ?? []).length;
    },
    reset() {
      registry.listeners.clear();
      registry.updates.length = 0;
      registry.updateError = undefined;
    },
    failNextUpdate(error) {
      registry.updateError = error;
    },
    get updates() {
      return registry.updates;
    },
  };

  const pathOf = (ref) => (typeof ref === 'string' ? ref : ref.path);

  return {
    getFirestore: jest.fn(() => ({ __db: true })),
    initializeFirestore: jest.fn(() => ({ __db: true })),
    memoryLocalCache: jest.fn(() => ({ kind: 'memory' })),
    doc: jest.fn((_db, ...segments) => ({ __ref: 'doc', path: segments.join('/') })),
    collection: jest.fn((_db, ...segments) => ({ __ref: 'collection', path: segments.join('/') })),
    query: jest.fn((ref, ...constraints) => ({ __ref: 'query', path: ref.path, constraints })),
    where: jest.fn((field, op, value) => ({ type: 'where', field, op, value })),
    orderBy: jest.fn((field, dir) => ({ type: 'orderBy', field, dir })),
    limit: jest.fn((n) => ({ type: 'limit', n })),
    arrayUnion: jest.fn((...values) => ({ __arrayUnion: values })),
    onSnapshot: jest.fn((ref, next, error) => {
      const path = pathOf(ref);
      const entry = { next, error: error ?? (() => undefined) };
      const list = registry.listeners.get(path) ?? [];
      list.push(entry);
      registry.listeners.set(path, list);
      return () => {
        const current = registry.listeners.get(path) ?? [];
        registry.listeners.set(
          path,
          current.filter((e) => e !== entry),
        );
      };
    }),
    updateDoc: jest.fn(async (ref, data) => {
      if (registry.updateError !== undefined) {
        const error = registry.updateError;
        registry.updateError = undefined;
        throw error;
      }
      registry.updates.push({ path: pathOf(ref), data });
    }),
  };
});

// ---------------------------------------------------------------------------
// Native modules
// ---------------------------------------------------------------------------
jest.mock('@react-native-firebase/messaging', () => {
  // RNFB v26 modular API: free functions taking a `Messaging` instance.
  const api = {
    getMessaging: jest.fn(() => ({ __messaging: true })),
    requestPermission: jest.fn(async () => 1),
    getToken: jest.fn(async () => 'fcm-token-123'),
    onMessage: jest.fn(() => jest.fn()),
    onNotificationOpenedApp: jest.fn(() => jest.fn()),
    getInitialNotification: jest.fn(async () => null),
    setBackgroundMessageHandler: jest.fn(),
    AuthorizationStatus: {
      NOT_DETERMINED: -1,
      DENIED: 0,
      AUTHORIZED: 1,
      PROVISIONAL: 2,
      EPHEMERAL: 3,
    },
  };
  globalThis.__messagingMock = api;
  return api;
});

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })),
  maybeCompleteAuthSession: jest.fn(),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '11111111-2222-4333-8444-555555555555'),
  getRandomBytes: jest.fn((n) => new Uint8Array(n).fill(7)),
  digestStringAsync: jest.fn(async (_alg, value) => `sha256(${value})`),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: jest.fn(async () => true),
  signInAsync: jest.fn(async () => ({
    identityToken: 'apple-identity-token',
    fullName: { givenName: 'Ada', familyName: 'Lovelace' },
    email: 'ada@example.com',
  })),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(async () => true),
    signIn: jest.fn(async () => ({ data: { idToken: 'google-id-token' } })),
    signOut: jest.fn(async () => undefined),
  },
  statusCodes: {
    SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
    IN_PROGRESS: 'IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

// ---------------------------------------------------------------------------
// expo-router — screens are rendered directly in tests, never through a router
// ---------------------------------------------------------------------------
jest.mock('expo-router', () => {
  const React = require('react');
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  };
  globalThis.__routerMock = router;
  const params = { current: {} };
  globalThis.__routeParams = params;
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
  const Stack = passthrough;
  Stack.Screen = () => null;
  const Tabs = passthrough;
  Tabs.Screen = () => null;
  return {
    useRouter: () => router,
    useLocalSearchParams: () => params.current,
    useSegments: () => [],
    usePathname: () => '/',
    // A mounted screen under the test renderer is a focused screen: run the
    // effect and its cleanup exactly as react-navigation would.
    useFocusEffect: (callback) => React.useEffect(callback, [callback]),
    Link: passthrough,
    Redirect: () => null,
    Stack,
    Tabs,
    SplashScreen: { preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() },
  };
});

// `SafeAreaProvider` renders nothing until it receives insets from a real
// layout pass, which never happens under the test renderer.
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children, ...props }) => React.createElement(View, props, children),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
    initialWindowMetrics: { insets, frame: { x: 0, y: 0, width: 390, height: 844 } },
  };
});

jest.mock('expo-linking', () => ({
  useURL: jest.fn(() => null),
  createURL: jest.fn((path) => `pm://${path}`),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
}));

// ---------------------------------------------------------------------------
// fetch — no test may reach the network (docs/00 §0.5)
// ---------------------------------------------------------------------------
beforeEach(() => {
  globalThis.fetch = jest.fn(() => {
    throw new Error('unexpected network call in a unit test');
  });
  globalThis.__firestoreMock?.reset();
  globalThis.__authMock?.reset();
  // `src/lib/log.ts` deliberately logs refusals; keep them out of the report.
  // `log.test.ts` re-spies on these and gets the same mock back.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
