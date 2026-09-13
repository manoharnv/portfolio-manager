# `@pm/functions` — Firebase Cloud Functions

2nd-gen Cloud Functions (region `asia-south1`) that turn Firestore writes into
push notifications, and two scheduled sweeps. See
[docs/08-infrastructure.md §8.4](../docs/08-infrastructure.md#84-firebase-managed-no-static-ip-needed):
these functions are Firebase-managed (no static IP) and **never** hold broker
order credentials or import `@pm/broker-*` — they only read/write Firestore
and send FCM pushes.

## What's here

| File | Purpose |
|---|---|
| `src/ports.ts` | `Db` / `Messaging` / `Clock` interfaces — the only thing handlers depend on. |
| `src/notify.ts` | Shared `sendToUser()`: token lookup, multicast send, dead-token pruning. Never throws. |
| `src/catalogue.ts` | docs/06 §6.5 notification texts + deep links, as pure functions. |
| `src/handlers/*.ts` | One pure `(deps, event) => Promise<Result>` function per trigger. |
| `src/adapters/admin.ts` | Thin, **untested** Firebase Admin SDK implementation of the ports. |
| `src/test-utils/fakes.ts` | In-memory `Db`/`Messaging`/`Clock` used by every handler test. |
| `src/index.ts` | Composition root — binds handlers to triggers, validates Firestore payloads against `@pm/core` zod schemas before handing them to a handler. |

Every file under `handlers/`, plus `notify.ts` and `catalogue.ts`, is a pure
function with no SDK import, tested with `test-utils/fakes.ts` (docs/00 §0.5:
no network in unit tests). `adapters/admin.ts` and `index.ts` are the only two
files that import `firebase-admin` / `firebase-functions`, and both are
excluded from the coverage thresholds (`vitest.config.ts`) — there is nothing
to unit-test there that isn't already covered by the pure-function tests.

## Build

```bash
pnpm --filter @pm/functions run build
```

This runs `esbuild` over `src/index.ts` and writes a single bundle to
`dist/index.js`. **The bundle inlines `@pm/core`** (and, transitively, `zod`,
`@pm/core`'s only runtime dependency) — Cloud Functions' deploy pipeline only
installs what's in `functions/package.json`'s `dependencies`, and a pnpm
workspace package like `@pm/core` cannot be installed from there (it isn't
published to a registry). `firebase-admin` and `firebase-functions` are left
`--external` instead: they're real, registry-published dependencies declared
in `functions/package.json`, so Cloud Functions installs them normally and
the bundle just imports them at runtime.

`packages/core` must be built (`pnpm --filter @pm/core build`) before this
bundle step, since esbuild resolves `@pm/core` to its `dist/` output — same as
any other consumer of the package.

## Deploy

```bash
firebase deploy --only functions          # this package (predeploy runs the build above)
firebase deploy --only firestore          # firestore.rules + firestore.indexes.json
```

`.firebaserc`'s `"default": "portfolio-mgr-prod"` is a **placeholder project
id** — replace it with the real GCP/Firebase project id before deploying
anywhere (`firebase use --add` will rewrite this file for you).

## Firestore TTL policy (not deployed by `firebase deploy`)

docs/03 §3.10 calls for TTL policies on two fields so Firestore auto-deletes
old documents after the scheduled sweeps have already acted on them. TTL
policies are **not** part of `firestore.indexes.json` and are not created by
`firebase deploy` — they're a separate one-time `gcloud` call per field:

```bash
gcloud firestore fields ttls update ttlExpiresAt \
  --collection-group=proposals \
  --enable-ttl \
  --project=<your-project-id>

gcloud firestore fields ttls update createdAt \
  --collection-group=idempotency \
  --enable-ttl \
  --project=<your-project-id>
```

Firestore's TTL sweep itself runs on its own schedule (typically within 24h of
expiry, not exactly 7 days) — set each document's TTL field far enough in the
future (7 days, per docs/03 §3.10) that this is a pure disk-cleanup step. The
`expireProposals` scheduled function (`src/handlers/expireProposals.ts`) is
what actually flips `pending → expired` a minute after `ttlExpiresAt`, so the
app reflects expiry immediately; the TTL policy only deletes the now-inert
document later.

## `firestore.indexes.json` — one deliberate naming correction

The ledger composite index is defined as a **collection-group index on
`entries`**, not `ledger`. Per
[docs/03 §3.1](../docs/03-data-model.md#31-collection-map) the actual
documents with `bookId`/`symbolKey` fields live at
`ledger/{uid}/entries/{entryId}` — the leaf collection's id is `entries`
(`ledger` is only the top-level collection of per-uid parent documents, which
don't themselves carry those fields). A Firestore collection-group index is
keyed by collection id, so it must name `entries` to actually match query
`Query.collectionGroup('entries').where('bookId', '==', ...).where('symbolKey', '==', ...)`
across every user. **VERIFY-LIVE**: double check this against whichever agent
implements the reconciliation job that reads the ledger collection group.

## Verifying `firestore.rules` against the emulator (manual — not automated here)

There is no automated rules test in this package. `@firebase/rules-unit-testing`
is **not installed** (adding it is out of scope for this change — flagged as a
follow-up, not installed per the task's hard rules) and no live Firestore
emulator is available in this environment (docs/00 §0.5: no network in tests).
Once that dependency is added, the standard approach is:

```bash
firebase emulators:exec --only firestore "vitest run rules.spec.ts"
```

using `@firebase/rules-unit-testing`'s `initializeTestEnvironment()` to assert
things like "an unauthenticated read is denied" or "a client can flip a
pending proposal to rejected but not mutate its order." Until that lands,
verify manually with the Firestore emulator UI / `firebase emulators:start`
and the checklist below (all as a signed-in, non-owner-and-owner user via the
Auth emulator):

- [ ] Owner can read `config/{ownUid}`, `proposals` where `uid == ownUid`, `orders`, `portfolio/{ownUid}/**`, `brokerSessions/{ownUid}/**`, `auditLog`, `strategies/{ownUid}/defs/**`, `users/{ownUid}`, `books/{ownUid}/books/**`, `ledger/{ownUid}/entries/**`, `mandates/{ownUid}/mandates/**`.
- [ ] A different signed-in user (not the owner) is denied read on all of the above for someone else's `uid`.
- [ ] An unauthenticated client is denied read and write everywhere.
- [ ] Owner can update `config/{ownUid}` changing `guardrails`, but a write that also changes `environment` is denied.
- [ ] Owner cannot create or delete a `config` doc.
- [ ] Owner cannot create a `proposals` doc (strategy engine / Admin SDK only).
- [ ] Owner can update a `pending` proposal's `status` to `rejected` with the `order` field unchanged.
- [ ] The same update is denied if `order` is also changed, or if the proposal's current `status` isn't `pending`, or if the target `status` isn't `rejected`.
- [ ] Owner cannot write `orders`, `portfolio/**`, `brokerSessions/**`, `auditLog` (create/update/delete all denied), `idempotency/**`, `strategies/**`, `books/**`, `ledger/**`, `mandates/**`.
- [ ] Owner can update `users/{ownUid}` changing only `fcmTokens` and/or `prefs`.
- [ ] The same update is denied if any other field is included in the write.
- [ ] Owner cannot create or delete `users/{ownUid}`.
- [ ] A read/write against an arbitrary unmatched top-level collection (e.g. `scratch/x`) is denied (the default-deny catch-all).

## Environment / dependencies

Nothing new is required beyond what's already declared in
`functions/package.json` (`@pm/core`, `firebase-admin`, `firebase-functions`;
dev: `@types/node`, `vitest`, `@vitest/coverage-v8`, `eslint`, `typescript`,
`esbuild`, `firebase-functions-test`) — no `pnpm install` / `pnpm add` was run
or is needed for this change. The one deliberately-not-installed dependency is
`@firebase/rules-unit-testing`, called out above.
