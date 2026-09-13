/**
 * Google + Apple sign-in on the Firebase JS SDK, following the house
 * `rn-firebase-auth-drive` pattern (docs/06 §6.2).
 *
 * Two deliberate departures from that skill, both because this is a money app:
 *   - **No anonymous fallback.** `firestore.rules` grants on `isOwner(uid)` and
 *     the backend enforces `ALLOWED_UIDS`; an anonymous session could read
 *     nothing and execute nothing, so offering it would only invent a
 *     half-signed-in state to get wrong.
 *   - **No Drive scopes.** The app stores nothing of its own.
 */
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import {
  GoogleAuthProvider,
  OAuthProvider,
  signInWithCredential,
  updateProfile,
} from 'firebase/auth';
import { googleClientIds } from './env';
import { getFirebaseAuth, signOut as firebaseSignOut } from './firebase';

export interface SignedInUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

let googleConfigured = false;

export function configureGoogleSignIn(): void {
  if (googleConfigured) return;
  const { webClientId, iosClientId } = googleClientIds();
  GoogleSignin.configure({
    ...(webClientId === undefined ? {} : { webClientId }),
    ...(iosClientId === undefined ? {} : { iosClientId }),
    offlineAccess: false,
  });
  googleConfigured = true;
}

function toSignedIn(): SignedInUser {
  const user = getFirebaseAuth().currentUser;
  if (user === null) throw new Error('sign-in completed but there is no current user');
  return { uid: user.uid, email: user.email, displayName: user.displayName };
}

export async function googleSignIn(): Promise<SignedInUser> {
  configureGoogleSignIn();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const response = await GoogleSignin.signIn();
  const idToken = response.data?.idToken;
  if (idToken === undefined || idToken === null) {
    throw new Error('Google sign-in returned no ID token');
  }
  await signInWithCredential(getFirebaseAuth(), GoogleAuthProvider.credential(idToken));
  return toSignedIn();
}

const NONCE_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._';

export function nonceFromBytes(bytes: Uint8Array): string {
  let nonce = '';
  for (const byte of bytes) {
    nonce += NONCE_CHARSET[byte % NONCE_CHARSET.length] ?? 'a';
  }
  return nonce;
}

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Apple gets the SHA-256 of the nonce; Firebase gets the raw value. Mixing the
 * two is the classic silent `auth/invalid-credential`.
 */
export async function appleSignIn(): Promise<SignedInUser> {
  if (Platform.OS !== 'ios') throw new Error('Apple sign-in is iOS only');

  const rawNonce = nonceFromBytes(Crypto.getRandomBytes(32));
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });
  if (credential.identityToken === null) {
    throw new Error('Apple sign-in returned no identity token');
  }

  const provider = new OAuthProvider('apple.com');
  await signInWithCredential(
    getFirebaseAuth(),
    provider.credential({ idToken: credential.identityToken, rawNonce }),
  );

  // Apple only ever returns the name on the very first sign-in — capture it now.
  const appleName = [credential.fullName?.givenName, credential.fullName?.familyName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
  const user = getFirebaseAuth().currentUser;
  if (user !== null && appleName !== '' && appleName !== user.displayName) {
    await updateProfile(user, { displayName: appleName }).catch(() => undefined);
  }
  return toSignedIn();
}

export async function signOut(): Promise<void> {
  await GoogleSignin.signOut().catch(() => undefined);
  await firebaseSignOut();
}

/** Turns any sign-in throw into something a human can act on. */
export function signInErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === statusCodes.SIGN_IN_CANCELLED) return 'Sign-in cancelled.';
    if (code === statusCodes.IN_PROGRESS) return 'A sign-in is already in progress.';
    if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      return 'Google Play Services is unavailable or out of date.';
    }
    if (code === 'ERR_REQUEST_CANCELED') return 'Sign-in cancelled.';
  }
  return error instanceof Error ? error.message : 'Sign-in failed. Please try again.';
}

/** Test seam — forgets that `GoogleSignin.configure` already ran. */
export function resetGoogleConfigForTests(): void {
  googleConfigured = false;
}
