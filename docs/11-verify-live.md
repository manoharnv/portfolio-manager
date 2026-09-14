# 11 · VERIFY-LIVE Checklist

The broker adapters were written against **documented** API shapes, with zero network
access in their unit tests ([00](00-dev-conventions.md) §0.5). Every wire-level
assumption that could only be confirmed against the *live* API is marked in code with
`// VERIFY-LIVE: …` and collected here.

**This is the Phase 1 integration-test plan** ([09](09-roadmap.md)): before the first
real read (and long before the first real order), each item is confirmed against the
live API using a throwaway session, and the corresponding comment is removed or the
code corrected. Items are ordered roughly by blast radius.

Run `grep -rn "VERIFY-LIVE" packages/` to find the exact lines.

---

## 11.1 Dhan (DhanHQ v2) — `packages/broker-dhan`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | **Tick-size units** in the scrip master — `SEM_TICK_SIZE` in paise vs rupees. `loadFromCsv(…, { tickSizeDivisor })` exists to correct it. | `instruments.ts` | 🔴 **Highest.** Wrong divisor rejects or mis-prices *every* limit order. |
| 2 | Client-id header name — docs/02 says `dhanClientId`; Dhan's marketfeed docs say `client-id`. May need to split the header builder per endpoint family. | `wire.ts` (`DHAN_CLIENT_ID_HEADER`) | 🔴 Every request 4xx. |
| 3 | Scrip-master URL/file (compact vs `-detailed`) and **exact CSV header names**. | `instruments.ts` | 🔴 Instrument master fails to load → no orders possible (fail-closed). |
| 4 | `correlationId` max length — assumed 25; over-long idempotency keys are refused, not hashed. | `adapter.ts` | 🟠 Order rejected at broker. |
| 5 | Order ack shape — bare `{orderId, orderStatus}` vs `{data:{…}}`; both currently accepted. | `wire.ts` | 🟠 Ack mis-parsed → order state unknown. |
| 6 | Full order-state list, esp. `TRANSIT` vs `PENDING`, `CONFIRM`, `PART_TRADED`. | `wire.ts` | 🟠 Status mapping → wrong `OrderStatusCode`. |
| 7 | `GET /orders/{id}` — object vs single-element array; both accepted. | `wire.ts` | 🟠 Reconciliation. |
| 8 | Which endpoints use a `status:"failed"` body inside an HTTP 200 envelope. | `wire.ts` | 🟠 Failure treated as success. |
| 9 | `fundlimit` field spelling — `availabelBalance` (sic) vs `availableBalance`; is `withdrawableBalance` always present? | `wire.ts` | 🟠 Funds guardrail fails closed (safe) or reads ₹0. |
| 10 | Holdings/positions `lastTradedPrice` — assumed **absent**; adapter enriches via `/marketfeed/quote` (`enrichPortfolioPrices`). If present, the extra call disappears. | `adapter.ts` | 🟡 Extra request per read. |
| 11 | Holdings `exchange` field — assumed `ALL`/absent ⇒ `NSE_EQ`. Check before trading BSE-only scrips. | `wire.ts` | 🟡 BSE holdings mis-attributed. |
| 12 | `/marketfeed/quote` request body — security ids as numbers; per-request cap. | `wire.ts` | 🟡 Quote calls fail. |
| 13 | Timestamp formats (`createTime`/`updateTime`/`exchangeTime`/`last_trade_time`) — assumed IST wall-clock, offset attached. | `wire.ts` | 🟡 Audit timestamps off by 5:30. |
| 14 | Chart epoch base — assumed UNIX/UTC seconds. A different base silently shifts every backtest. | `wire.ts` | 🟡 Backtests wrong. |
| 15 | Intraday chart `fromDate`/`toDate` format — assumed `YYYY-MM-DD HH:mm:ss` IST. | `adapter.ts` | 🟡 Historical calls fail. |
| 16 | `POST /v2/RenewToken` — request body (none sent), response field names, whether an expiry is returned at all. | `auth.ts` | 🟡 Daily renewal fails → fail-closed, re-login. |
| 17 | `DH-9xx` error-code list; whether order APIs always nest the code under `remarks`. | `errors.ts` | 🟡 Error kind mis-mapped (e.g. IP rejection seen as UNKNOWN). |
| 18 | **Consent flow** (`consent.ts`, transcribed from the v2 docs): `POST https://auth.dhan.co/app/generate-consent?client_id=…` → `consentAppId`; browser `GET /login/consentApp-login?consentAppId=…` → redirect `?tokenId=…`; `GET /app/consumeApp-consent?tokenId=…` → `accessToken`, `expiryTime` (assumed IST wall-clock `YYYY-MM-DD HH:mm:ss`), `dhanClientId`. Headers `app_id`/`app_secret` on both calls. Also: the API key form's "Static IP" must hold the VM's IP for order endpoints, and there is a 25 consents/day cap. | `consent.ts` | 🟠 Daily login fails closed (no session) — nothing trades. |

**Deliberate adapter behaviours to keep in mind during verification**
- No retry loop inside the adapter; `isRetryableError` is exported for the backend's policy and is `false` for `AUTH_EXPIRED` / `IP_NOT_WHITELISTED`.
- A price-less holding row **throws** (with enrichment disabled) rather than reporting a ₹0 valuation.
- WebSocket live feed not implemented (out of scope for v1).

## 11.2 Kite (Kite Connect v3) — `packages/broker-kite`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | Order-status string mapping — full enumeration, esp. `TRIGGER PENDING` → OPEN/PARTIAL and whether `EXPIRED` is ever emitted for regular orders. | `wire.ts` | 🟠 Wrong `OrderStatusCode` → reconciliation drift. |
| 2 | Funds — `equity.available.cash` vs `live_balance` as "available", and `equity.utilised.debits` vs a summed figure as "used". | `wire.ts` | 🟠 Funds guardrail reads the wrong number. |
| 3 | Holdings — whether `t1_quantity` should fold into `Holding.quantity`. | `wire.ts` | 🟡 Owned qty under-reported on T+1 day. |
| 4 | Order `status_message` field name (vs `status_message_raw`). | `wire.ts` | 🟡 Rejection reason missing from audit. |
| 5 | Timestamp formats — `YYYY-MM-DD HH:mm:ss` (quote) and `+HHMM` no-colon (historical candles) inferred from public docs. | `wire.ts` | 🟡 Candle/quote timestamps mis-parsed. |
| 6 | Historical — exact accepted `from`/`to` format (bare date vs date+time). | `wire.ts` | 🟡 Historical calls fail. |
| 7 | `GET /instruments` — whether it needs the `Authorization` header; its error-body shape. | `instruments.ts` | 🟡 Instrument master fails to load (fail-closed). |
| 8 | **Login redirect** (`services/session.ts`): the Kite Connect app's Redirect URL is `https://portfolio.swasthionline.com/v1/auth/kite/redirect`; the login URL carries `redirect_params=state%3D…` and the docs say it is echoed back verbatim — the backend refuses a redirect whose `state` differs (STATE_MISMATCH). `POST /session/token` → `data.user_id` is compared with `KITE_USER_ID` (blank ⇒ accepted with a warning). Also: order placement via the API needs a static IP registered with Zerodha (35.244.14.140) since 1 Apr 2025, and the free Personal plan has **no market-data endpoints** (quotes/historical) — the engine's Kite market data needs the ₹500/month Connect plan. | `auth.ts` (`loginUrl`), backend `services/session.ts` | 🟠 Daily Kite login fails closed; or the engine gets no Kite quotes. |

**Deliberate adapter behaviours**
- `tag` = deterministic ≤20-char SHA-256-derived hash of the idempotency key; the full
  key lives in Firestore (`orders.idempotencyKey`).
- Every method is `async` so validation failures surface as rejections, never sync throws.
- WebSocket ticker not implemented (out of scope for v1).

---

## 11.3 Cloud Functions — `functions/`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | `firestore.rules` are verified only by the manual emulator checklist in `functions/README.md` (`@firebase/rules-unit-testing` deliberately not installed). Run that checklist before the app ships. | `firestore.rules` | 🔴 A wrong rule is a client-side privilege hole. |
| 2 | Audit `detail` field names the push handler reads (`reason`, `killSwitch`, `broker`, `ip`) must match what `apps/backend` actually writes — `AuditEvent.detail` is an untyped record in core. | `handlers/onAuditEvent.ts` | 🟠 Pushes with empty/wrong text. |
| 3 | FCM dead-token codes used for pruning (`messaging/registration-token-not-registered`, `messaging/invalid-registration-token`) taken from firebase-admin 13.10's error source, not a live send. | `notify.ts` | 🟡 Dead tokens never pruned (noise) or live ones pruned (missed pushes). |
| 4 | Scheduler syntax + timezone (`every 1 minutes`; `45 8 * * 1-5` in `Asia/Kolkata`) and Cloud Scheduler support in `asia-south1`. | `index.ts` | 🟡 Expiry sweep / morning reminder never fire. |
| 5 | 2nd-gen trigger payload shapes (`FirestoreEvent`, `Change<QueryDocumentSnapshot>`) confirmed from `firebase-functions@6` typings, not an emulator run. | `index.ts` | 🟡 Handlers receive unexpected shapes. |
| 6 | TTL policies are **not** deployable from `firestore.indexes.json` — set via `gcloud firestore fields ttls update` for `proposals.ttlExpiresAt` and `idempotency.createdAt` (see `functions/README.md`). | infra | 🟡 Expired docs accumulate (functional impact nil: the sweep flips status first). |

## 11.4 Strategy engine — `apps/strategy`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | **Exchange holiday list must be populated** — `PM_HOLIDAYS` (engine) and `MARKET_HOLIDAYS` (backend) are empty in the templates; with them empty, holidays are treated as trading days (ticks fire; proposals expire unusable). The 2026 list is checked in at `infra/vm/env/nse-holidays-2026.txt` (16 weekday closures); refresh it every December and on special-closure circulars. | `index.ts`, `schedule.ts` | 🟠 Noise + wasted proposals on holidays. |
| 2 | Composite indexes for the engine's queries — `auditLog (uid, type, ts)` and `proposals (uid, status)` — are now in `firestore.indexes.json`; confirm they deploy and the queries use them. | `adapters/firestore/repos.ts` | 🟠 Ticks fail on FAILED_PRECONDITION. |
| 3 | **Service-account scoping is not enforceable by Firestore IAM** (no per-collection conditions). The engine's "proposals + auditLog only" write set is enforced by code, lint and `policy.test.ts`, not by IAM. Infra must still give the engine SA the least role (`roles/datastore.user`) and **no** Secret Manager access to order/token secrets. | infra | 🟡 Defence-in-depth relies on the code layers. |
| 4 | `FirestoreLike` is a structural slice of `firebase-admin@13`'s `Firestore`; re-verify on SDK upgrades. | `adapters/firestore/types.ts` | 🟡 Compile break on upgrade. |
| 5 | Required env: `PM_UID`, `PM_BROKER_SECRET` (Secret Manager name of the READ creds JSON), `PM_INSTRUMENTS_URL`; `main()` throws without them (fail closed). | `index.ts` | 🟡 Engine won't start. |
| 6 | **Tick placement deviates from docs/05 §5.5 on purpose:** price-taking strategies (DCA, rebalance) run on `intraday` ticks, not pre-open/eod, because a proposal drafted at 09:00 or 15:45 IST can never pass the `marketHours` guardrail and would expire unusable. `StrategyDef.ticks` lets an operator override. | `strategies/*` | — (design note) |
| 7 | Risk limits are derived defaults (portfolio daily-loss stop = Σ book stops; gross exposure = capital × (100 − reserve)%; concentration 25%) overridable via `HarnessDeps.riskLimits` — `Config` has no `RiskLimits` block yet; promote into core `Config` in a later pass. | `harness.ts` | 🟡 Limits not operator-editable from the app. |
| 9 | **Engine re-reads its read-creds secret before every due tick** (`refreshBroker`) and rebuilds the read adapter when the payload changed — that is how the morning Dhan login (backend rewrites `pm-strategy-read-creds`) reaches it without a restart. Verify in the journal: `broker credentials refreshed` after a login. With `PM_INSTRUMENTS_DIR` (the backend's cache directory) an active-broker **switch** loads the other broker's master on the next tick (`instrument master indexed for the new active broker`); with only `PM_INSTRUMENTS_URL` the switch is refused until restart. | `index.ts` | 🟡 A missed refresh or failed master load fails closed (session check). |
| 8 | **Instrument master comes from the backend's local cache, not a CDN.** Observed on the real VM: `images.dhan.co` is CloudFront, whose rotating A records the pm-strategy nftables allowlist (resolved IPs, refreshed every 10 min) only ever partially holds — the engine's start-up download failed or succeeded at random (14 crash-loops). Now the backend writes both masters to `INSTRUMENTS_CACHE_DIR` (`/var/lib/pm/instruments`, atomic, 0644) and `PM_INSTRUMENTS_URL` is `file:///var/lib/pm/instruments/dhan-scrip-master.csv`. Verify the cache files exist after a backend start and that the engine stays up across restarts. `images.dhan.co` can then be dropped from the egress allowlist. | `instruments-source.ts`, backend `instruments-cache.ts` | 🟠 Engine crash-loops at start-up if the cache is missing. |

## 11.5 Execution backend — `apps/backend`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | **Firestore transaction semantics.** The idempotency lock and the proposal compare-and-set are read-then-write inside `runTransaction`, relying on Firestore re-running the transaction when a read document changed. The in-memory fake does not model contention. Confirm on the real Admin SDK / emulator with two concurrent executes of the same key. | `adapters/firestore/repos.ts` | 🔴 Double placement under a race. |
| 2 | `adaptFirestore()` is the one place Admin SDK types are cast onto the narrow `FsDb`; exercise every repo once against a real project or the emulator. | `index.ts` | 🔴 Runtime shape mismatch in prod only. |
| 3 | Daily token expiry is stored as an `expires-at` **label** on the Secret Manager secret (payload stays opaque). Confirm label charset/length limits; the VM role needs `secretmanager.secrets.get` (labels) + `secretAccessor`, and `set` needs `secretVersionManager` — it adds the new daily token version and then **destroys** the previous ones (only DESTROYED versions stop being billed; the retirement is best-effort so a missing role never fails a login, but confirm on the VM that old versions actually reach DESTROYED). | `adapters/secret-manager.ts` | 🟠 Session shows disconnected / token write fails. |
| 4 | **Dhan consent flow is now server-side** (transcribed from DhanHQ v2 docs → Authentication → API Key & Secret): `POST /v1/auth/dhan/login-url` calls `POST https://auth.dhan.co/app/generate-consent?client_id=…` (headers `app_id`/`app_secret`) and returns `https://auth.dhan.co/login/consentApp-login?consentAppId=…`; Dhan's page redirects to the app's registered Redirect URL — `GET https://portfolio.swasthionline.com/v1/auth/dhan/redirect?tokenId=…` — which calls `GET https://auth.dhan.co/app/consumeApp-consent?tokenId=…`, checks `dhanClientId` against `dhan-client-id`, stores the token and 302s to `pm://broker-callback?broker=dhan&status=…`. Unverified live: the exact JSON field names (`consentAppId`, `accessToken`, `expiryTime` as IST wall-clock, `dhanClientId`), whether the redirect keeps the registered URL's path intact, and the 25-consents/day cap. `/v1/auth/dhan/callback` now always answers 400 NOT_SUPPORTED. **Kite** completes the same way on `/v1/auth/kite/redirect` (`request_token` + echoed `state`), see §11.2. | `services/session.ts`, `packages/broker-dhan/src/consent.ts` | 🟠 Daily Dhan login cannot complete until confirmed. |
| 5 | `/v1/admin/whitelist-ip` returns **501** — no adapter exposes an IP-whitelist call; Dhan's "Setup Static IP" API would first need a `BrokerAdapter` method. | `http/app.ts` | 🟡 Manual whitelisting only. |
| 6 | Kite instruments URL (`https://api.kite.trade/instruments`) is hard-coded in the composition root. | `index.ts` | 🟡 |
| 7 | Background loops (reconcile, portfolio refresh) iterate `ALLOWED_UIDS` — the single-user/family model of docs/04 §4.9, not a user index. | `index.ts` | 🟡 Multi-tenant would need a change. |
| 8 | Biometric assertion: presence is enforced when `config.guardrails.requireBiometric`; the assertion is **not** cryptographically verified server-side. | `services/execution.ts` | 🟡 Relies on app-side gating. |

**Design decisions recorded (deviations from the docs/04 flowchart, all fail-closed)**
- The human's approval is written (`pending → approved`, audited) *before* the guardrail suite runs, because the state machine only reaches `blocked` from `approved`. A refusal before that point (kill switch, market closed, session invalid) leaves the proposal `pending` and retryable with a fresh idempotency key.
- `clientSeenLtp` is **required** (400 without it); absence can never be a skip.
- A market-data / funds / instrument fetch failure returns `BROKER_ERROR` (or `SESSION_INVALID` on `AUTH_EXPIRED`), burns the idempotency key, audits `order.failed`, and leaves the proposal `pending` — nothing reached the broker.
- Order postbacks (`/v1/broker/:broker/postback`) are not implemented; status is reconciled by polling.
- **Ledger attribution happens on fill, not submission** (budget is *reserved* at submission and released exactly on reject/cancel) — see the reconcile service. This closes the path where an unfilled BUY could let the day-trade book's EOD square-off sell shares it never received.

## 11.6 Infrastructure — `infra/`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | **One service account per GCE VM.** The VM runs as `pm-backend`; the `pm-strategy` OS user's ADC therefore also resolves to `pm-backend` today, so the strategy SA's narrower Secret Manager grants are the *target* state, not the live boundary. Live enforcement = code/lint/`policy.test.ts` + the nftables egress allowlist + `strategy.env` never naming order/token secrets. Upgrade paths: run the strategy unit on its own compute, or issue `pm-strategy` a key (documented in `iam.tf`). | `terraform/iam.tf`, `vm.tf` | 🟠 IAM isolation weaker than the spec implies until one upgrade path is taken. |
| 2 | `roles/firebaseauth.viewer` is the best-guess role for `verifyIdToken(token, checkRevoked=true)`; fall back to `roles/identitytoolkit.viewer` if it 403s. | `terraform/iam.tf` | 🟠 All app calls 401/403. |
| 3 | The egress firewall enforces **hosts, not paths** — order and read endpoints share `api.dhan.co` / `api.kite.trade`. Its real guarantee is that `pm-strategy` cannot reach *any* unlisted host (no exfiltration, no alternate order host). Confirm the resolver timer populates the sets and that Firestore/Secret Manager/oauth2 still work under it. | `vm/nftables-strategy-egress.conf`, `egress-allowlist.sh` | 🟠 Strategy engine has no egress (fail-closed) if the resolver breaks. |
| 4 | Health check path is `/health` on `config.port` (default 8080) — docs/08 §8.8 originally said `/v1/health`; the code is authoritative and the spec is corrected. | `terraform/monitoring.tf` | 🟡 Uptime alert flaps. |
| 5 | Log-based alert metrics assume pino JSON reaches Cloud Logging as `textPayload` via the Ops Agent's journald receiver; verify the filters match real entries (`IP_NOT_WHITELISTED`, `AUTH_EXPIRED` bursts, `order.failed`). | `terraform/monitoring.tf` | 🟡 Silent alerts. |
| 6 | `google_firestore_backup_schedule` retention `604800s` and `delete_protection_state` accepted by the live API (schema-validated only). | `terraform/firestore.tf` | 🟡 |
| 7 | Not in Terraform (manual `gcloud` steps in `infra/README.md`): the CI Workload Identity Federation pool + deploy SA; scheduling Firestore exports into the provisioned bucket. | `README.md` | 🟡 |
| 8 | `.terraform.lock.hcl` is deliberately not committed: a lock generated by OpenTofu records `registry.opentofu.org` and breaks `terraform init`; run `terraform init` (or `tofu init`) yourself and commit the lock your tool produces. | `terraform/` | — |
| 9 | **Instance schedule actually fires.** Requires `roles/compute.instanceAdmin.v1` on the Compute Engine service agent (`service-<project-number>@compute-system.iam.gserviceaccount.com`, granted in `iam.tf`); a schedule without it is accepted but never starts/stops the VM. Confirm on day 1 that the VM is up by 07:17 IST and down by 16:17 IST (VM → details → "Instance schedule"). | `vm.tf`, `iam.tf` | 🔴 VM never starts → no trading day; or never stops → always-on billing. |
| 10 | In-window health ping: Cloud Scheduler's failure log shape (`resource.type="cloud_scheduler_job"`, `resource.labels.job_id`, `severity>=ERROR`) is assumed for the `pm-window-health-failed` metric; verify on the first real failure and tighten the filter. | `monitoring.tf` | 🟠 Silent when the backend is down in-window. |
| 11 | First-boot-only clone/build in `bootstrap.sh`: after a reboot, confirm `journalctl -u google-startup-scripts` shows "existing checkout … not touching it" and that boot-to-`/health` is ≤ 3 min. | `vm/bootstrap.sh` | 🟠 A slow or rebuilding boot could miss the 09:00 pre-open tick. |
| 12 | **`metadata_startup_script` is force-new** in the google provider (observed: a bootstrap.sh edit planned a VM replacement). Terraform now `ignore_changes` it; the script baked into the running VM is the first-boot-only version (unfiltered build, no swap). Script changes are applied by re-running `sudo bash /opt/pm/infra/vm/bootstrap.sh` from the checkout (idempotent) — `deploy.sh` does this. | `vm.tf`, `scripts/deploy.sh` | 🟠 Editing the attribute and applying would try to recreate the VM (deletion_protection blocks it). |
| 13 | The first boot ran the *unfiltered* `pnpm install && pnpm build` (incl. the mobile app's `expo export`) on 1 GB RAM — slow/OOM-prone. Verify `dist/` exists for backend + strategy (+ core/brokers) and that a swapfile is active; the checked-in script now filters to the server apps and creates a 2 GB swap. | `vm/bootstrap.sh` | 🔴 Units restart-loop against a missing `dist/`. |
| 14 | **Memory on the e2-micro.** Observed: with both units indexing the full Dhan scrip master (~200k rows, nearly all F&O) the backend reached 489 MB RSS and the engine ~300 MB on a 969 MB box → swap, 5+ min to bind, 502s and an uptime alert during every deploy. Now both index only `INSTRUMENT_SEGMENTS` / `PM_INSTRUMENT_SEGMENTS` (default `EQ`) through a streaming CSV reader. Verify after a restart: `ps -o rss -C node` well under 200 MB each and `Dhan scrip master indexed` logging a few thousand rows, not 200k. Enabling FNO later means growing the VM (e2-small). | `packages/core/src/csv.ts`, `infra/scripts/deploy.sh` | 🟠 Deploys/restarts thrash; backend unreachable for minutes. |

## 11.7 Mobile app — `apps/mobile`

Everything here is device- or console-side and cannot be unit-tested (see
`apps/mobile/README.md` for the step-by-step).

| # | Manual step / assumption | Where | Risk if skipped |
|---|---|---|---|
| 1 | **iOS Podfile** needs the three `:modular_headers => true` lines (GoogleUtilities, FirebaseCore, FirebaseCoreInternal) after `use_expo_modules!` — LIGHT RNFB stack (messaging only; Auth is the JS SDK). Not applied: no `expo prebuild` was run. | `apps/mobile/README.md` | 🔴 iOS build fails at pod install. |
| 2 | `GoogleService-Info.plist` / `google-services.json` into `apps/mobile/` (gitignored; operator supplies). `expo export` warns without them but bundles. | `app.config.ts` | 🔴 FCM never registers. |
| 3 | Google Sign-In console: iOS + Web client ids, Android **debug and release SHA-1**; `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` is a placeholder until set in `.env`. | `.env.example` | 🔴 Login fails on device. |
| 4 | Apple: Sign in with Apple capability + Firebase Apple provider; first-sign-in name capture and hashed-vs-raw nonce behaviour are device-only. | `src/lib/auth.ts` | 🟠 |
| 5 | FCM on iOS: APNs `.p8` key uploaded to Firebase; Push Notifications + Background Modes capabilities on the target. | Xcode / Firebase console | 🟠 No pushes on iOS. |
| 6 | `pm://` scheme association on device (routing is unit-tested against `functions/src/catalogue.ts`, the OS handoff is not). | `app.config.ts` | 🟡 Notification taps open the app at the wrong screen. |
| 7 | **Dhan daily login completes server-side**: the app opens the consent URL from `/v1/auth/dhan/login-url` in the system auth session and only ever sees the backend's verdict in the `pm://broker-callback?broker=dhan&status=ok\|error` bounce — no token, no callback POST (docs/06 §6.7 holds). Verify on a device that `ASWebAuthenticationSession`/Chrome Custom Tabs return the `pm://` redirect issued by the backend's 302 (a cross-site chain: auth.dhan.co → portfolio.swasthionline.com → pm://). Kite now takes the same route (kite.zerodha.com → backend → pm://); the in-app `request_token` path remains only as a fallback. | `src/lib/brokerLogin.ts` | 🟠 No Dhan trading day can start from the app until verified. |
| 8 | Biometric prompt and the confirm-slider `PanResponder` are device-only behaviours (mocked in Jest). | `src/lib/biometric.ts`, `ConfirmSlider` | 🟡 |
| 9 | Firestore offline cache is **in-memory only** on RN with the JS SDK — data survives within a session, not across cold starts. | `src/lib/firebase.ts` | 🟡 Cold start shows empty until online. |
| 10 | Not implemented (spec marks as Phase 3+): jailbreak/root check, certificate pinning. | — | 🟡 |
| 11 | Per-strategy toggles require the strategy defs to be **provisioned by the operator** in `strategies/{uid}/defs` (the app can only patch existing ones through the backend). | `docs/03` §3.1 | 🟡 Settings shows no strategies until seeded. |

## 11.8 How to run the verification (Phase 1)

1. Use a **read-only day**: no order APIs are exercised until §11.1 items 1–9 are green.
2. Load the live scrip master → assert a handful of known instruments (RELIANCE NSE_EQ,
   a BSE-only scrip, one NFO contract) resolve with the expected lot/tick.
3. Call each read endpoint once with a valid session; diff the raw JSON against the test
   fixtures in `test-utils.ts`; update fixtures + parsers where they differ.
4. Only then, in **dry-run** mode, exercise the order path against the simulator; the
   first *real* order is a single tiny CNC LIMIT well inside the collar.
