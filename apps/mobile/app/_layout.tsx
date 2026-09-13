/**
 * Root layout: providers, the auth gate, deep-link routing and the global
 * banner strip (docs/06 §6.1, §6.5, §6.6).
 *
 * The banners live *above* the navigator rather than inside each screen so
 * "kill switch on", "backend unreachable" and "no broker session" cannot be on
 * screen without being seen.
 */
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useURL } from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../src/AppContext';
import { GlobalBanners } from '../src/components/GlobalBanners';
import { ROUTES, routeForDeepLink } from '../src/lib/deeplink';
import { attachPushHandlers, registerForPush } from '../src/lib/notifications';
import { colors, space } from '../src/theme';

function AuthGate() {
  const { authReady, uid } = useApp();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (!authReady) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (uid === undefined && !inAuthGroup) router.replace(ROUTES.login);
    else if (uid !== undefined && inAuthGroup) router.replace(ROUTES.dashboard);
  }, [authReady, uid, segments, router]);

  return null;
}

/** FCM registration + tap routing, and cold-start / warm deep links. */
function DeepLinks() {
  const { uid } = useApp();
  const router = useRouter();
  const url = useURL();

  useEffect(() => {
    if (uid === undefined) return;
    void registerForPush(uid);
    return attachPushHandlers({
      onForeground: () => undefined,
      onOpened: (route) => router.push(route),
    });
  }, [uid, router]);

  useEffect(() => {
    if (uid === undefined || url === null) return;
    const route = routeForDeepLink(url);
    if (route !== undefined) router.push(route);
  }, [uid, url, router]);

  return null;
}

function Shell() {
  return (
    <SafeAreaView style={styles.shell} edges={['top']}>
      <AuthGate />
      <DeepLinks />
      <GlobalBanners />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)/login" options={{ headerShown: false }} />
      </Stack>
    </SafeAreaView>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg, paddingBottom: space.xs },
});
