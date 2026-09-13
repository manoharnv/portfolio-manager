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
| 1 | **Exchange holiday list is empty by default.** `PM_HOLIDAYS` (engine) and the backend's `marketHolidays` must be populated with the NSE calendar, else holidays are treated as trading days (ticks fire; proposals expire unusable). | `index.ts`, `schedule.ts` | 🟠 Noise + wasted proposals on holidays. |
| 2 | Composite indexes for the engine's queries — `auditLog (uid, type, ts)` and `proposals (uid, status)` — are now in `firestore.indexes.json`; confirm they deploy and the queries use them. | `adapters/firestore/repos.ts` | 🟠 Ticks fail on FAILED_PRECONDITION. |
| 3 | **Service-account scoping is not enforceable by Firestore IAM** (no per-collection conditions). The engine's "proposals + auditLog only" write set is enforced by code, lint and `policy.test.ts`, not by IAM. Infra must still give the engine SA the least role (`roles/datastore.user`) and **no** Secret Manager access to order/token secrets. | infra | 🟡 Defence-in-depth relies on the code layers. |
| 4 | `FirestoreLike` is a structural slice of `firebase-admin@13`'s `Firestore`; re-verify on SDK upgrades. | `adapters/firestore/types.ts` | 🟡 Compile break on upgrade. |
| 5 | Required env: `PM_UID`, `PM_BROKER_SECRET` (Secret Manager name of the READ creds JSON), `PM_INSTRUMENTS_URL`; `main()` throws without them (fail closed). | `index.ts` | 🟡 Engine won't start. |
| 6 | **Tick placement deviates from docs/05 §5.5 on purpose:** price-taking strategies (DCA, rebalance) run on `intraday` ticks, not pre-open/eod, because a proposal drafted at 09:00 or 15:45 IST can never pass the `marketHours` guardrail and would expire unusable. `StrategyDef.ticks` lets an operator override. | `strategies/*` | — (design note) |
| 7 | Risk limits are derived defaults (portfolio daily-loss stop = Σ book stops; gross exposure = capital × (100 − reserve)%; concentration 25%) overridable via `HarnessDeps.riskLimits` — `Config` has no `RiskLimits` block yet; promote into core `Config` in a later pass. | `harness.ts` | 🟡 Limits not operator-editable from the app. |

## 11.5 Execution backend — `apps/backend`

| # | Assumption to verify | Where | Risk if wrong |
|---|---|---|---|
| 1 | **Firestore transaction semantics.** The idempotency lock and the proposal compare-and-set are read-then-write inside `runTransaction`, relying on Firestore re-running the transaction when a read document changed. The in-memory fake does not model contention. Confirm on the real Admin SDK / emulator with two concurrent executes of the same key. | `adapters/firestore/repos.ts` | 🔴 Double placement under a race. |
| 2 | `adaptFirestore()` is the one place Admin SDK types are cast onto the narrow `FsDb`; exercise every repo once against a real project or the emulator. | `index.ts` | 🔴 Runtime shape mismatch in prod only. |
| 3 | Daily token expiry is stored as an `expires-at` **label** on the Secret Manager secret (payload stays opaque). Confirm label charset/length limits; the VM role needs `secretmanager.secrets.get` (labels) + `secretAccessor`, and `set` needs `secretVersionAdder`. | `adapters/secret-manager.ts` | 🟠 Session shows disconnected / token write fails. |
| 4 | Dhan consent flow: `/v1/auth/dhan/callback` accepts `{ accessToken, expiresAt }` (both required — fail closed) and the login URL comes from `DHAN_CONSENT_URL_TEMPLATE`. Confirm the real consent response fields and URL. | `services/session.ts` | 🟠 Daily Dhan login cannot complete. |
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

## 11.6 How to run the verification (Phase 1)

1. Use a **read-only day**: no order APIs are exercised until §11.1 items 1–9 are green.
2. Load the live scrip master → assert a handful of known instruments (RELIANCE NSE_EQ,
   a BSE-only scrip, one NFO contract) resolve with the expected lot/tick.
3. Call each read endpoint once with a valid session; diff the raw JSON against the test
   fixtures in `test-utils.ts`; update fixtures + parsers where they differ.
4. Only then, in **dry-run** mode, exercise the order path against the simulator; the
   first *real* order is a single tiny CNC LIMIT well inside the collar.
