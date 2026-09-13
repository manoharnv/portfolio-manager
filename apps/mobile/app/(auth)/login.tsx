/**
 * Sign-in (docs/06 §6.2) — Google and Apple, nothing else.
 *
 * No anonymous path: `firestore.rules` grants on `isOwner(uid)` and the backend
 * enforces an explicit uid allowlist, so an anonymous session could neither
 * read a proposal nor place an order. Offering it would only invent a
 * half-signed-in state.
 */
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  appleSignIn,
  googleSignIn,
  isAppleSignInAvailable,
  signInErrorMessage,
} from '../../src/lib/auth';
import { Banner } from '../../src/components/Banner';
import { colors, font, radius, space } from '../../src/theme';

export default function LoginScreen() {
  const [busy, setBusy] = useState<'google' | 'apple' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isAppleSignInAvailable().then((available) => {
      if (!cancelled) setAppleAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (which: 'google' | 'apple') => {
    setError(undefined);
    setBusy(which);
    try {
      if (which === 'google') await googleSignIn();
      else await appleSignIn();
      // The auth listener in AppProvider drives navigation; nothing to do here.
    } catch (caught) {
      setError(signInErrorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }, []);

  return (
    <View style={styles.screen} testID="login-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Portfolio Manager</Text>
        <Text style={styles.subtitle}>
          You are the human in the loop. Every order waits for you.
        </Text>
      </View>

      {error === undefined ? null : (
        <Banner tone="danger" title="Sign-in failed" message={error} testID="login-error" />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy !== undefined }}
        disabled={busy !== undefined}
        onPress={() => void run('google')}
        style={[styles.button, styles.google, busy !== undefined && styles.buttonBusy]}
        testID="sign-in-google"
      >
        <Text style={styles.googleText}>
          {busy === 'google' ? 'Signing in…' : 'Continue with Google'}
        </Text>
      </Pressable>

      {Platform.OS === 'ios' && appleAvailable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== undefined }}
          disabled={busy !== undefined}
          onPress={() => void run('apple')}
          style={[styles.button, styles.apple, busy !== undefined && styles.buttonBusy]}
          testID="sign-in-apple"
        >
          <Text style={styles.appleText}>
            {busy === 'apple' ? 'Signing in…' : 'Continue with Apple'}
          </Text>
        </Pressable>
      ) : null}

      <Text style={styles.footnote}>
        This app never holds broker credentials. It carries a Firebase ID token to the backend, and
        briefly a request token during the daily broker login.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: space.lg, justifyContent: 'center' },
  header: { marginBottom: space.xxl },
  title: { color: colors.text, fontSize: font.h1, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: font.body, marginTop: space.sm, lineHeight: 22 },
  button: {
    minHeight: 56,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  buttonBusy: { opacity: 0.6 },
  google: { backgroundColor: colors.text },
  googleText: { color: colors.bg, fontSize: font.body, fontWeight: '700' },
  apple: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  appleText: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  footnote: {
    color: colors.textMuted,
    fontSize: font.small,
    marginTop: space.xl,
    lineHeight: 18,
  },
});
