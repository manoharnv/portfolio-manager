/**
 * Typed Expo config — docs/06 §6.2/§6.7.
 *
 * Everything environment-specific arrives through `EXPO_PUBLIC_*` variables and
 * is surfaced on `expo.extra`, so `src/lib/env.ts` has exactly one place to read
 * from and the repo never carries a value (docs/00 §0.7.7 "no secrets in this
 * repo"). A Firebase *web* config is public by design — it identifies the
 * project, it does not authorise anything; access control is Firestore rules +
 * the backend's `ALLOWED_UIDS`. Nothing here is a credential.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** `undefined` for an unset/blank variable so `env.ts` can fail closed on it. */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

const IOS_BUNDLE_ID = env('EXPO_PUBLIC_IOS_BUNDLE_ID') ?? 'com.example.portfoliomanager';
const ANDROID_PACKAGE = env('EXPO_PUBLIC_ANDROID_PACKAGE') ?? 'com.example.portfoliomanager';

/**
 * The reverse-DNS iOS OAuth client id (`com.googleusercontent.apps.<suffix>`).
 * The google-signin config plugin refuses to run without one, so a placeholder
 * keeps `expo export` working on a machine with no `.env` — it is a public
 * identifier, not a secret. **Set the real value before any device build**:
 * Google sign-in silently fails to return to the app otherwise (README).
 */
const GOOGLE_IOS_URL_SCHEME =
  env('EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME') ?? 'com.googleusercontent.apps.000000000000-placeholder';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Portfolio Manager',
  slug: 'pm-mobile',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  // High-contrast light UI (docs/06 §6.1 "glanceable"); no dark variant yet.
  userInterfaceStyle: 'light',
  // Deep links from the FCM catalogue: pm://proposals/<id>, pm://orders/<id>,
  // pm://broker-connect, pm://audit, pm://dashboard (functions/src/catalogue.ts).
  scheme: 'pm',
  assetBundlePatterns: ['**/*'],
  ios: {
    supportsTablet: false,
    bundleIdentifier: IOS_BUNDLE_ID,
    // Lets `expo run:ios --device …` sign without an Xcode round-trip.
    ...(env('EXPO_PUBLIC_APPLE_TEAM_ID') ? { appleTeamId: env('EXPO_PUBLIC_APPLE_TEAM_ID') } : {}),
    usesAppleSignIn: true,
    // The operator drops the file here; it is gitignored (see README).
    googleServicesFile: './GoogleService-Info.plist',
    infoPlist: {
      NSFaceIDUsageDescription:
        'Face ID confirms that it is you approving an order before any money moves.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: ANDROID_PACKAGE,
    googleServicesFile: './google-services.json',
    adaptiveIcon: {
      backgroundColor: '#0B1220',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  // This list is the whole list — there is no `app.json` to merge with.
  plugins: [
    'expo-router',
    // Per the house RNFB rule: ONLY `@react-native-firebase/app` is listed.
    // RNFB 26 *does* ship `@react-native-firebase/messaging/app.plugin.js`, but
    // it only toggles APNs/auto-init flags and messaging works without it; see
    // README "Firebase split" before adding it.
    '@react-native-firebase/app',
    // Applies the RNFB LIGHT-stack Podfile lines on every prebuild (README §3).
    './plugins/with-firebase-modular-headers',
    'expo-local-authentication',
    'expo-secure-store',
    'expo-apple-authentication',
    'expo-web-browser',
    'expo-status-bar',
    ['@react-native-google-signin/google-signin', { iosUrlScheme: GOOGLE_IOS_URL_SCHEME }],
  ],
  experiments: { typedRoutes: false },
  extra: {
    backendBaseUrl: env('EXPO_PUBLIC_BACKEND_BASE_URL'),
    firebase: {
      apiKey: env('EXPO_PUBLIC_FIREBASE_API_KEY'),
      authDomain: env('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN'),
      projectId: env('EXPO_PUBLIC_FIREBASE_PROJECT_ID'),
      storageBucket: env('EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: env('EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'),
      appId: env('EXPO_PUBLIC_FIREBASE_APP_ID'),
    },
    google: {
      webClientId: env('EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'),
      iosClientId: env('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID'),
    },
    /**
     * Fallbacks only. The live URL comes from `POST /v1/auth/:broker/login-url`
     * (apps/backend/src/services/session.ts) because only the backend holds the
     * broker api key. `{apiKey}` is substituted by the backend, never here.
     */
    brokerLoginUrlTemplates: {
      kite: env('EXPO_PUBLIC_BROKER_LOGIN_URL_KITE'),
      dhan: env('EXPO_PUBLIC_BROKER_LOGIN_URL_DHAN'),
    },
    /** Where the broker bounces back to; must be registered with the broker. */
    brokerRedirectUrl: env('EXPO_PUBLIC_BROKER_REDIRECT_URL') ?? 'pm://broker-callback',
  },
});
