import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';
import { signInWithCredential, updateProfile } from 'firebase/auth';
import {
  appleSignIn,
  configureGoogleSignIn,
  googleSignIn,
  isAppleSignInAvailable,
  nonceFromBytes,
  resetGoogleConfigForTests,
  signInErrorMessage,
  signOut,
} from './auth';

const authMock = () => globalThis.__authMock;

beforeEach(() => {
  resetGoogleConfigForTests();
  authMock().setUser({ uid: 'u1', email: 'you@example.com', displayName: 'You' });
});

describe('Google sign-in', () => {
  it('configures once and exchanges the Google ID token for a Firebase credential', async () => {
    await expect(googleSignIn()).resolves.toEqual({
      uid: 'u1',
      email: 'you@example.com',
      displayName: 'You',
    });
    expect(GoogleSignin.configure).toHaveBeenCalledWith(
      expect.objectContaining({ webClientId: 'web.test', iosClientId: 'ios.test' }),
    );
    // No Drive/Calendar scopes — the app stores nothing of its own.
    expect(GoogleSignin.configure).not.toHaveBeenCalledWith(
      expect.objectContaining({ scopes: expect.anything() }),
    );
    expect(signInWithCredential).toHaveBeenCalled();
  });

  it('does not reconfigure on a second call', () => {
    configureGoogleSignIn();
    configureGoogleSignIn();
    expect(GoogleSignin.configure).toHaveBeenCalledTimes(1);
  });

  it('throws when Google returns no ID token', async () => {
    (GoogleSignin.signIn as jest.Mock).mockResolvedValueOnce({ data: {} });
    await expect(googleSignIn()).rejects.toThrow('no ID token');
  });

  it('throws when the Firebase user is somehow missing afterwards', async () => {
    authMock().setUser(null);
    await expect(googleSignIn()).rejects.toThrow('no current user');
  });
});

describe('Apple sign-in', () => {
  const original = Platform.OS;
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });

  it('sends Apple the hashed nonce and Firebase the raw one', async () => {
    await expect(appleSignIn()).resolves.toMatchObject({ uid: 'u1' });

    const appleArgs = (AppleAuthentication.signInAsync as jest.Mock).mock.calls[0]?.[0] as {
      nonce: string;
    };
    const credential = (signInWithCredential as jest.Mock).mock.calls.at(-1)?.[1] as {
      rawNonce: string;
    };
    expect(appleArgs.nonce).toBe(`sha256(${credential.rawNonce})`);
    expect(appleArgs.nonce).not.toBe(credential.rawNonce);
  });

  it('captures the first-sign-in full name, which Apple never sends again', async () => {
    await appleSignIn();
    expect(updateProfile).toHaveBeenCalledWith(expect.anything(), {
      displayName: 'Ada Lovelace',
    });
  });

  it('does not rewrite a displayName that already matches', async () => {
    authMock().setUser({ uid: 'u1', email: 'a@b.c', displayName: 'Ada Lovelace' });
    await appleSignIn();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('throws when Apple returns no identity token', async () => {
    (AppleAuthentication.signInAsync as jest.Mock).mockResolvedValueOnce({
      identityToken: null,
      fullName: null,
    });
    await expect(appleSignIn()).rejects.toThrow('no identity token');
  });

  it('is unavailable off iOS', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    await expect(isAppleSignInAvailable()).resolves.toBe(false);
    await expect(appleSignIn()).rejects.toThrow('iOS only');
  });

  it('treats a throwing availability probe as unavailable', async () => {
    (AppleAuthentication.isAvailableAsync as jest.Mock).mockRejectedValueOnce(new Error('x'));
    await expect(isAppleSignInAvailable()).resolves.toBe(false);
  });

  it('reports availability on iOS', async () => {
    await expect(isAppleSignInAvailable()).resolves.toBe(true);
  });
});

describe('nonceFromBytes', () => {
  it('maps bytes into the URL-safe charset deterministically', () => {
    const nonce = nonceFromBytes(new Uint8Array([0, 1, 2, 3]));
    expect(nonce).toBe('abcd');
    expect(nonceFromBytes(new Uint8Array(32).fill(7))).toHaveLength(32);
  });
});

describe('signOut', () => {
  it('clears the Google session and the Firebase one', async () => {
    await signOut();
    expect(GoogleSignin.signOut).toHaveBeenCalled();
    expect(authMock).toBeDefined();
  });

  it('signs out of Firebase even when Google sign-out fails', async () => {
    (GoogleSignin.signOut as jest.Mock).mockRejectedValueOnce(new Error('not signed in'));
    await expect(signOut()).resolves.toBeUndefined();
  });
});

describe('signInErrorMessage', () => {
  it('humanises the known status codes', () => {
    expect(signInErrorMessage({ code: statusCodes.SIGN_IN_CANCELLED })).toBe('Sign-in cancelled.');
    expect(signInErrorMessage({ code: statusCodes.IN_PROGRESS })).toContain('already in progress');
    expect(signInErrorMessage({ code: statusCodes.PLAY_SERVICES_NOT_AVAILABLE })).toContain(
      'Play Services',
    );
    expect(signInErrorMessage({ code: 'ERR_REQUEST_CANCELED' })).toBe('Sign-in cancelled.');
  });

  it('falls back to the error message, then to a generic line', () => {
    expect(signInErrorMessage(new Error('boom'))).toBe('boom');
    expect(signInErrorMessage('weird')).toContain('Sign-in failed');
  });
});
