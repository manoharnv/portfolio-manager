# `@pm/mobile` — the human in "human-in-the-loop"

The Expo app from [docs/06](../../docs/06-mobile-app.md). It is where you see
proposals, read the "why", and take the one irreversible action in the whole
system: **approve an order**.

Nothing here places an order by itself. Every approval is
`gate → biometric → confirm slide → POST /v1/proposals/:id/execute`, and the
backend re-checks every guardrail on live numbers regardless of what this app
decided (docs/04 §4.4).

---

## 1. Stack

| Concern | Choice |
|---|---|
| Framework | Expo SDK **57.0.22**, React Native **0.86.3**, React **19.2.3** |
| Router | **expo-router 57.0.21** (file-based, `app/`) |
| Auth + data | **Firebase JS SDK 12.19** (`firebase/auth`, `firebase/firestore`) |
| Push | **`@react-native-firebase/app` + `/messaging` 26.4** (native only) |
| Sign-in | `@react-native-google-signin/google-signin` 16.1 + `expo-apple-authentication` |
| Biometric | `expo-local-authentication` |
| Shared types | `@pm/core` (`workspace:*`) — the same zod schemas the backend writes |
| Tests | **jest 29.7 + `jest-expo` 57 + `@testing-library/react-native` 14** |
| Lint / format | eslint 10 (shared flat config) + prettier 3 (repo root) |
| TypeScript | **5.9.3, pinned** (docs/00 §0.1) |

### Firebase split ("LIGHT stack")

Two Firebase runtimes coexist deliberately (the house RNFB rule):

- **JS SDK** for Auth and Firestore. It reads `EXPO_PUBLIC_FIREBASE_*` and shares
  the exact document shapes `@pm/core` defines.
- **`@react-native-firebase/*` for FCM only**, because push needs native code.
  RNFB reads the native service files (`GoogleService-Info.plist` /
  `google-services.json`), not the env.

`app.config.ts` lists **only `@react-native-firebase/app`** in `plugins`.
RNFB 26 does ship `@react-native-firebase/messaging/app.plugin.js`, but it only
toggles APNs / auto-init flags, and messaging works without it. Leave the list
alone unless you need one of those knobs.

`src/lib/notifications.ts` uses RNFB v26's **modular** API
(`getMessaging()` + free functions). The `messaging()` namespace form is
deprecated and is no longer in the typings.

---

## 2. Setup

```bash
pnpm install                      # from the repo root
pnpm --filter @pm/core build      # apps/mobile imports @pm/core's dist/
cp apps/mobile/.env.example apps/mobile/.env   # then fill it in
```

`.env` is gitignored. Every value in it is a **public identifier** — a Firebase
web config identifies a project, it does not authorise anything. Access control
is `firestore.rules` plus the backend's `ALLOWED_UIDS`. **No broker key, no
service account, no token belongs in this app** (docs/00 §0.7.7, docs/06 §6.7).

### Google service files (operator supplies)

These are gitignored and are **not** in the repo. Download them from the
Firebase console and drop them at:

```
apps/mobile/GoogleService-Info.plist   # iOS   → app.config.ts ios.googleServicesFile
apps/mobile/google-services.json       # Android → app.config.ts android.googleServicesFile
```

`expo export` prints `Could not parse Expo config: ios.googleServicesFile …`
when they are absent. That is expected on a machine without them; the JS bundle
still builds. FCM will not work on a device until they are in place.

### Running

```bash
pnpm --filter @pm/mobile start      # Metro (a dev build, not Expo Go — RNFB is native)
pnpm --filter @pm/mobile ios
pnpm --filter @pm/mobile android
pnpm --filter @pm/mobile typecheck  # tsc --noEmit, tests included
pnpm --filter @pm/mobile test       # jest --coverage, thresholds enforced
pnpm --filter @pm/mobile lint
pnpm --filter @pm/mobile build      # expo export → dist/ (proves the bundle compiles)
pnpm --filter @pm/mobile clean
```

**Expo Go will not work.** `@react-native-firebase/messaging` and
`@react-native-google-signin` are native modules; use a development build.

---

## 3. Native builds (CNG)

`ios/` and `android/` are **generated** and gitignored. Generate them with
`npx expo prebuild` on the operator machine.

> **Never run `expo prebuild --clean`** on a tree that already has hand-managed
> native files — it wipes signing config and the Google service files.

### SPM is disabled on purpose

RNFB ≥ 26 resolves `firebase-ios-sdk` through **Swift Package Manager** by default,
and SPM only works with `use_frameworks! :linkage => :dynamic`; with CocoaPods'
default static libraries `pod install` stops with
"SPM + static linkage is not supported". `app.config.ts` therefore passes
`{ ios: { disableSPM: true } }` to the `@react-native-firebase/app` plugin, which
writes `$RNFirebaseDisableSPM = true` above the target block so Firebase comes
from CocoaPods again. That is the path the modular-header recipe below is for.
(Dynamic frameworks would be the alternative, but they are the less-exercised
path for Expo modules and would invalidate the house recipe.)

### The iOS Podfile: three modular-header lines (applied automatically)

The config plugin `plugins/with-firebase-modular-headers.js` (registered in
`app.config.ts`) inserts these three lines immediately after `use_expo_modules!`
on **every** prebuild, idempotently — so a regenerated `ios/` never loses them.
The result looks like:

```ruby
target 'PortfolioManager' do
  use_expo_modules!
  # @pm/mobile: RNFB LIGHT-stack modular headers (with-firebase-modular-headers.js)
  pod 'GoogleUtilities', :modular_headers => true
  pod 'FirebaseCore', :modular_headers => true
  pod 'FirebaseCoreInternal', :modular_headers => true

  # ... rest of target
end
```

`npx expo run:ios` runs `pod install` itself. If you prebuild separately, run
`cd ios && LANG=en_US.UTF-8 pod install` afterwards. The plugin's Podfile edit is
unit-tested against the SDK 57 template (`__tests__/with-firebase-modular-headers.test.ts`)
and throws if a future Expo template loses the `use_expo_modules!` anchor.

This is the **LIGHT stack** recipe and it is correct for this app, which pulls in
only Firebase messaging (no `FirebaseAuth` pod — auth is the JS SDK). If
`@react-native-firebase/auth`, `/firestore`, `/functions` or `/storage` is ever
added, these three lines stop working and the build needs the static-framework
approach instead (`$RNFirebaseAsStaticFramework = true`,
`ios.useFrameworks: "static"` in `ios/Podfile.properties.json`, plus the
`post_install` fixes). The `pod install` step is **not** run in this repo — no
native build was performed here.

---

## 4. Layout

```
app/                       # expo-router: every .tsx here is a route
  _layout.tsx              # providers, auth gate, deep links, global banners
  (auth)/login.tsx         # Google + Apple
  (tabs)/_layout.tsx       # 6 tabs; Proposals carries the pending badge
  (tabs)/index.tsx         # Dashboard: value, P&L, books, broker chip, kill switch
  (tabs)/proposals/        # inbox + [id] = THE APPROVAL SCREEN
  (tabs)/orders/           # list + [id] with cancel
  (tabs)/broker.tsx        # daily broker login, static-IP health
  (tabs)/settings/         # settings + guardrails
  (tabs)/audit.tsx         # read-only auditLog feed
src/
  AppContext.tsx           # one shared subscription set for all seven screens
  lib/                     # api, firebase, auth, notifications, biometric,
                           # brokerLogin, proposals (the gate), guardrailEdit,
                           # deeplink, env, format, idempotency, log
  hooks/                   # Firestore listeners + useLiveQuote / useCountdown
  components/              # ConfirmSlider, GuardrailChecklist, Banner, …
__tests__/                 # screen tests (see "Divergences")
types/test-globals.d.ts    # typings for the jest.setup.js doubles
```

### The approval path, in order

1. `approvalGate()` (`src/lib/proposals.ts`) — a client-side mirror of the
   backend's refusal ladder. Fails closed on: no config, not pending, TTL
   elapsed, kill switch, trading disabled, no broker session, backend
   unreachable, **no fresh quote** (`GET /v1/quotes`, polled every 5 s while the
   screen is focused; older than 30 s ⇒ no price), price outside the collar,
   failed precheck.
   Every failing reason renders; approve is disabled until all are clear.
2. `runBiometricGate()` — `config.guardrails.requireBiometric` drives it, and a
   device with no sensor/enrolment is a **refusal**, not a skip.
3. `ConfirmSlider` — the deliberate gesture. VoiceOver users get an equivalent
   `activate` accessibility action.
4. `POST /v1/proposals/:id/execute` with a **fresh** `pm-<uuid v4>` idempotency
   key and `clientSeenLtp` = *the number on the screen*.
5. Every `ExecuteResult` reason renders with its own title and the backend's own
   detail. `PRICE_MOVED` offers refresh-and-retry; `GUARDRAIL_BLOCKED` renders
   `failedChecks`; **`IDEMPOTENT_REPLAY` is treated as success** and the approve
   control is removed so the order cannot be placed twice.

### What the app writes to Firestore

Only what `firestore.rules` allows, and nothing else:

| Write | Where | Rule |
|---|---|---|
| Reject a proposal | `proposals/{id}` | `{status:'rejected', decidedBy, decidedAt}` on a `pending` proposal |
| Guardrails / capital / trading toggle | `config/{uid}` | never `environment`, `activeBroker` or `uid` |
| Push token | `users/{uid}.fcmTokens` | `arrayUnion` |
| Notification prefs | `users/{uid}.prefs` | — |

Three things the app changes are backend-only, never a Firestore write:
`POST /v1/config/killswitch`, `POST /v1/config/active-broker` (the Broker
screen's "Make active"; a 409 `SESSION_INVALID` means the target broker has no
session today, and the banner then offers to run its daily login), and
`PATCH /v1/strategies/:id` (Settings → Strategies: an optimistic `enabled`
toggle that rolls back on error, plus a params editor that only sends a plain
JSON object of at most 8 KB).

Reject uses the Firestore path rather than `POST /v1/proposals/:id/reject` so
that saying "no" still works when the backend is unreachable (docs/06 §6.6). The
backend route remains the server-side equivalent.

---

## 5. Divergences from `docs/00-dev-conventions.md`

All forced by Expo / Metro / Jest, and all deliberate.

| docs/00 | Here | Why |
|---|---|---|
| §0.5 vitest | **jest + `jest-expo`** | Only `jest-expo` understands Metro's resolver, the Expo module registry and the RN transform pipeline. Thresholds still enforced (`jest.config.js`): lines/statements/functions ≥ 80, branches ≥ 75. |
| §0.3 `"type": "module"` | **CommonJS package** | `metro.config.js`, `babel.config.js` and `jest.config.js` are loaded with `require`. `eslint.config.mjs` carries the `.mjs` extension so it can still be ESM. |
| §0.4 `.js` extension on relative imports | **no extension** | `moduleResolution: "bundler"` (from `expo/tsconfig.base`); Metro resolves extensionless paths. NodeNext is not usable here. |
| §0.5 tests colocated in `src/` | **`__tests__/` for screen tests** | expo-router's route glob (`expo-router/_ctx.ios.js`) has no test exclusion, so `app/**/[id].test.tsx` would *ship as a route*. Everything under `src/` is still colocated. |
| §0.7.5 `no-console` | `no-console` with `warn`/`error` allowed | The app has no pino. `src/lib/log.ts` is the only wrapper, it redacts credential-shaped values, and `log.info` is a no-op outside `__DEV__`. |
| §0.1 vitest coverage config | `coverageThreshold` in `jest.config.js` | same thresholds, different runner |

Also worth knowing:

- **pnpm linker stayed `isolated`** (the workspace default). `metro.config.js`
  only adds `watchFolders` + `nodeModulesPaths`; hierarchical lookup is left
  **on**, because pnpm's isolated layout gives every package its own nested
  `node_modules` and turning the walk-up off would make `zod` unresolvable from
  inside `@pm/core`. No `.npmrc` change, no `node-linker=hoisted`.
- `expo.install.exclude` in `package.json` pins `typescript` (5.9.3 per docs/00
  §0.1), `jest` and `@types/jest` (29.x, which is what `jest-expo` 57 actually
  depends on) against `expo install --check`. `npx expo-doctor` passes 21/21.
- **Firestore offline is in-memory only.** The JS SDK has no durable offline
  store on React Native (IndexedDB is web-only), so `memoryLocalCache()` is used.
  Listeners serve from cache *within a session* — enough for docs/06 §6.6 — but
  a cold start with no network shows nothing.

---

## 6. VERIFY-LIVE / manual items

Nothing below can be checked from this repo.

1. **Podfile** — the three `:modular_headers => true` lines are now applied by
   the config plugin on every prebuild; what remains manual is confirming that
   `pod install` succeeds on the operator machine (no `pod install` was run here).
2. **Service files** — `GoogleService-Info.plist` and `google-services.json`
   (§2). Absent by design.
3. **Google sign-in console setup** — iOS + Web OAuth client ids, and the
   **Android SHA-1 for both debug and release** in the Firebase console. Without
   the SHA-1, Android Google sign-in fails silently.
   `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` currently defaults to a **placeholder**
   so `expo export` works without a `.env`; set the real reverse-DNS client id
   before any device build or the iOS flow will not return to the app.
4. **Apple sign-in** — enable the Sign in with Apple capability and the Apple
   provider in Firebase Auth. First-sign-in name capture and the hashed-vs-raw
   nonce are only testable on a real Apple ID.
5. **FCM APNs key** — upload the `.p8` APNs auth key to the Firebase console and
   enable Push Notifications + Background Modes on the iOS target. Until then
   `getToken()` throws on a device and `registerForPush` reports
   `registered: false`.
6. **Deep links** — `pm://proposals/<id>`, `pm://orders/<id>`,
   `pm://broker-connect`, `pm://audit`, `pm://dashboard`. Routing is unit-tested
   against `functions/src/catalogue.ts`, but the OS-level association (the
   `pm` scheme resolving to the installed build) is device-only.
7. **Broker login** — only the **Kite** flow is implemented end-to-end
   (`request_token` → `POST /v1/auth/kite/callback`). **Dhan stops at
   `VERIFY_LIVE`**: its consent flow mints a long-lived *access token* outside
   the app (see `DHAN_CONSENT_URL_TEMPLATE` and `verifyLive: true` in
   `apps/backend/src/services/session.ts`), and forwarding that through the app
   would put a broker secret in the app, which docs/06 §6.7 forbids. Confirm the
   real Dhan redirect shape before enabling it.
8. **Quote route load** — `GET /v1/quotes` is polled once per 5 s per open
   proposal screen. Confirm that fits the broker's quote rate limit before
   leaving a proposal open for long stretches.
9. **Biometric + the confirm slide** — the PanResponder path is simulator/device
   only; the tests drive the equivalent accessibility action.

---

## 7. Known gaps / deviations from docs/06

1. **Strategy definitions have no shared schema.** `@pm/core` does not model
   `strategies/{uid}/defs/{id}`, so `src/hooks/useStrategies.ts` declares a
   deliberately forgiving local zod schema (`id`, `label?`, `enabled`, `params`)
   and ignores any other field the engine writes. Move it into `@pm/core` when
   the engine's shape settles.
2. **The params editor is raw JSON.** It validates that the text is a plain
   object within 8 KB and nothing more — there is no per-strategy schema to
   validate against, so a typo in a key reaches the backend.
3. **No mandates UI and no scalp book** — deferred by decision (docs/10 §10.7).
   `VISIBLE_BOOKS` excludes `scalp`.
4. **No jailbreak/root check and no certificate pinning** (docs/06 §6.7) — both
   are marked Phase 3+ / best-effort in the spec and are not implemented.
5. **Charges are shown, not computed.** `marketContext.estimatedCharges` comes
   from the strategy engine; the app adds it to (BUY) or subtracts it from
   (SELL) the estimated value and shows the net.
