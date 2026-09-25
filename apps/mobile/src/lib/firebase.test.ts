import { getAuth, initializeAuth, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, initializeFirestore } from 'firebase/firestore';
import { getApps, initializeApp } from 'firebase/app';
import {
  currentUser,
  getDb,
  getFirebaseApp,
  getFirebaseAuth,
  getIdToken,
  resetFirebaseForTests,
  signOut,
  watchAuth,
} from './firebase';
import { isIdempotencyKey, newIdempotencyKey } from './idempotency';

const authMock = () => globalThis.__authMock;

beforeEach(() => resetFirebaseForTests());

describe('app and services', () => {
  it('initialises a named app once and memoises it', () => {
    const app = getFirebaseApp();
    expect(initializeApp).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'test-project' }),
      'pm',
    );
    expect(getFirebaseApp()).toBe(app);
  });

  it('reuses an already-initialised app of the same name', () => {
    (getApps as jest.Mock).mockReturnValueOnce([{ name: 'pm' }]);
    expect(getFirebaseApp()).toEqual({ name: 'pm' });
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('initialises Auth with React Native persistence and memoises it', () => {
    const auth = getFirebaseAuth();
    expect(initializeAuth).toHaveBeenCalled();
    expect(getFirebaseAuth()).toBe(auth);
  });

  it('falls back to getAuth when initializeAuth throws (Fast Refresh)', () => {
    (initializeAuth as jest.Mock).mockImplementationOnce(() => {
      throw new Error('auth/already-initialized');
    });
    expect(getFirebaseAuth()).toBeDefined();
    expect(getAuth).toHaveBeenCalled();
  });

  it('initialises Firestore with a memory cache and long-polling detection', () => {
    const db = getDb();
    expect(initializeFirestore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ experimentalAutoDetectLongPolling: true }),
    );
    expect(getDb()).toBe(db);
  });

  it('falls back to getFirestore when initializeFirestore throws', () => {
    (initializeFirestore as jest.Mock).mockImplementationOnce(() => {
      throw new Error('already initialised');
    });
    expect(getDb()).toBeDefined();
    expect(getFirestore).toHaveBeenCalled();
  });
});

describe('auth helpers', () => {
  it('reports the current user and subscribes to changes', () => {
    expect(currentUser()).toBeNull();

    const seen: unknown[] = [];
    const unsubscribe = watchAuth((user) => seen.push(user));
    authMock().setUser({ uid: 'u1' });

    expect(onAuthStateChanged).toHaveBeenCalled();
    expect(seen).toEqual([null, { uid: 'u1' }]);
    unsubscribe();
  });

  it('mints an ID token from the signed-in user', async () => {
    const getIdTokenSpy = jest.fn(async () => 'fresh-token');
    authMock().setUser({ uid: 'u1', getIdToken: getIdTokenSpy });

    await expect(getIdToken()).resolves.toBe('fresh-token');
    expect(getIdTokenSpy).toHaveBeenCalledWith(false);

    await getIdToken(true);
    expect(getIdTokenSpy).toHaveBeenLastCalledWith(true);
  });

  it('refuses to mint a token when signed out', async () => {
    await expect(getIdToken()).rejects.toThrow('not signed in');
  });

  it('signs out', async () => {
    authMock().setUser({ uid: 'u1' });
    await signOut();
    expect(currentUser()).toBeNull();
  });
});

describe('idempotency keys', () => {
  it('mints a prefixed UUID v4 inside the backend length bounds', () => {
    const key = newIdempotencyKey();
    expect(isIdempotencyKey(key)).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it('rejects anything that is not one of ours', () => {
    expect(isIdempotencyKey('11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(isIdempotencyKey('pm-not-a-uuid')).toBe(false);
  });
});
