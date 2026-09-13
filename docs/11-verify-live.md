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

## 11.4 How to run the verification (Phase 1)

1. Use a **read-only day**: no order APIs are exercised until §11.1 items 1–9 are green.
2. Load the live scrip master → assert a handful of known instruments (RELIANCE NSE_EQ,
   a BSE-only scrip, one NFO contract) resolve with the expected lot/tick.
3. Call each read endpoint once with a valid session; diff the raw JSON against the test
   fixtures in `test-utils.ts`; update fixtures + parsers where they differ.
4. Only then, in **dry-run** mode, exercise the order path against the simulator; the
   first *real* order is a single tiny CNC LIMIT well inside the collar.
