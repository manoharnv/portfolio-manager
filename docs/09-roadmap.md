# 09 · Roadmap

Phased so that **money-touching capability arrives last and only after the safe path is
proven**. Every phase is independently useful.

## Phase 0 — Infra bootstrap
*Goal: the ground to stand on.*
- Dedicated GCP project, `asia-south1`.
- Firebase: Firestore (native), Auth, FCM enabled.
- e2-micro VM + reserved static IP; caddy TLS; two systemd users (backend/strategy).
- Secret Manager set up (empty slots).
- Monorepo scaffolded (`packages/core`, `apps/*`, `functions/`, `infra/`).
- **Exit:** VM reachable at `https://.../v1/health`; empty app builds & logs in.

## Phase 1 — Read-only foundation
*Goal: see your real portfolio, prove the broker abstraction, no writes.*
- `BrokerReadAdapter` + **Dhan** adapter (holdings/positions/funds/quotes/instruments).
- Daily broker login flow (app → backend callback → token in Secret Manager).
- Backend read endpoints + cached `portfolio/*` read model.
- **Books + ledger foundations** (read-side): capital sleeves + position attribution
  ([10-multi-strategy.md](10-multi-strategy.md) §10.3–10.4).
- **Seed the operator-owned documents** (`config`, `users`, `books`, `strategies/defs`,
  `brokerSessions`) with `apps/strategy/scripts/seed-user.ts` — schema-validated,
  create-only, inert defaults (dry-run, trading off, strategies off).
- App: Firebase Auth, Dashboard (holdings, P&L, session status, per-book view), Broker
  Connect.
- **Exit:** you log in, connect Dhan, see live holdings attributed to books. Zero order
  capability yet.

## Phase 2 — Proposals (still no execution)
*Goal: multiple strategies push proposals through the coordinator; you can reject them.*
- Firestore proposal model + rules + indexes + TTL/expiry function.
- Strategy engine harness + guardrail **pre-filter** + **coordinator** + **portfolio
  risk manager** pre-checks ([10](10-multi-strategy.md) §10.5–10.6).
- First two horizons (both clean HITL): **long-term** (SIP/DCA, rebalance) and **swing**
  (entries + SL/target monitors), each in its own book.
- `onProposalCreate → FCM`; app Proposals inbox + detail (read-only) + Reject; proposals
  tagged by book/horizon.
- **Exit:** long-term & swing strategies write real proposals, the coordinator nets
  conflicts, you get a push, review the rationale, and reject. Nothing can place an order.

## Phase 3 — Execution (the careful one) 🔒
*Goal: approve → place, in **dry-run first**, then prod; add day-trading.*
- Execution backend `POST /proposals/:id/execute`: idempotency, full guardrail suite,
  live-LTP + collar re-check, code-level ceilings, per-book budget + ledger write.
- **dry-run simulator** wired end-to-end; app approval UX (biometric + confirm slider);
  `orders` records; audit ledger; order-status reconciliation.
- Add **day-trade** book (MIS, intraday, EOD square-off guard) through the same approve
  path.
- Whitelist prod static IP with Dhan; **paper/small-size prod** cutover with tight caps.
- **Exit:** in dry-run, approve→simulated fill works repeatedly across long-term/swing/
  day-trade; then a single tiny real order places correctly from the static IP with full
  audit + correct book attribution.

## Phase 4 — Kite adapter + broker switching
*Goal: broker-agnostic in practice.*
- Kite adapter (auth exchange, order/portfolio/data endpoints, enum mapping).
- Broker switcher in app + `config.activeBroker`; Kite IP whitelist.
- Contract tests proving both adapters satisfy identical behaviour.
- **Exit:** switch Dhan ↔ Kite; same proposal→approve→execute flow works on both.

## Phase 5 — Intelligence, scalping & scale
*Goal: better proposals, the fourth horizon, safely.*
- More strategies within existing books (rebalance drift, cash deployment, etc.).
- Backtesting harness over historical candles (validate before a strategy goes live).
- **Scalp book** — as **Option A** (fast intraday momentum, still HITL) by default; the
  **Option B mandate** (bounded, human-activated, deterministic-only auto-exec) *only*
  on explicit opt-in with a proven backtested edge, and with its own hardening + sign-off
  ([10](10-multi-strategy.md) §10.7).
- **Claude-reasoned routine** with restricted `writeProposal`-only toolset (proposals
  only — never in any auto-exec path).
- Richer analytics (XIRR, drawdown, per-book P&L, allocation, dividends), reports,
  kill-switch drills.
- **Exit:** all four horizons coexisting under books + coordinator + risk manager, all
  human-gated (or bounded-mandate), all guardrailed.

## Milestone properties (invariant across all phases)
- No phase introduces an auto-execute path.
- Guardrails + audit exist before the first real order (Phase 3).
- Every phase leaves the system in a safe, shippable state.

---

## Effort sketch

| Phase | Rough effort |
|---|---|
| 0 Infra | ~0.5–1 day |
| 1 Read-only + Dhan | ~1.5–2 days |
| 2 Proposals | ~1.5–2 days |
| 3 Execution (dry-run→prod) | ~2–3 days + careful testing |
| 4 Kite + switching | ~1–1.5 days |
| 5 Intelligence | open-ended |

A safe end-to-end (dry-run) system through Phase 3 is roughly **1–1.5 weeks** of
focused work; real-money go-live gated on your testing comfort.

---

## Open questions

These need your input (a few before Phase 1):

1. **GCP project** — new dedicated project (recommended) or reuse an existing one?
2. **Daily Dhan token** — always require the human morning login (recommended; gives a
   daily "presence" guarantee), or automate token generation via Dhan's key+secret
   module where possible? Confirm what Dhan/SEBI allow for self-use.
3. **Segments** — the four horizons need both delivery (CNC) and intraday (MIS); do we
   also include **F&O** (needed for index scalping/futures)? Recommendation: **equity
   CNC + MIS** for v1, add F&O only when the scalp/day books are proven.
4. ~~**Scalping execution model**~~ — ✅ **DECIDED: C → A.** Defer scalping; ship
   long-term + swing + day-trade first (all human-approved). Add scalping later as
   **fast intraday momentum under human-in-the-loop** (Option A). The Option-B auto-exec
   mandate is **not planned** — revisit only on explicit opt-in with a proven,
   backtested deterministic edge ([10](10-multi-strategy.md) §10.7).
5. **Capital allocation** — starting split across books, e.g. long-term 50% / swing 30% /
   day-trade 15% / scalp 5% (+ reserve)? And total managed capital?
6. **Initial guardrail caps** — starting `maxOrderValueInr`, `maxDailyNotionalInr`,
   `maxOrdersPerDay`, `priceCollarPct`, `proposalTtlSeconds`, plus **per-book daily-loss
   stops** and a **portfolio daily-loss stop**? (Suggest small to start.)
7. **Family use** — single user only, or design multi-user (immediate family) from the
   start? (Cheaper to assume single-user now, generalise later.)
8. **Language for strategy engine** — TS across the board (recommended for shared
   types), or Python for quant libraries in the strategy layer?
9. **Backend framework** — Fastify (recommended) vs Express vs NestJS?
10. **Confirm at build time**: Dhan v2 exact order/token field names, static-IP
   registration mechanics, order postback availability, market-quote REST endpoint,
   and current SEBI OPS ceilings — verify against live broker docs when Phase 1 starts.

---

## Immediate next step

If this design looks right, the natural first move is **Phase 0 scaffold** (monorepo +
`packages/core` domain types, zod schemas, `BrokerReadAdapter` interface, guardrail lib)
— all of which is pure, testable, and touches nothing live. Say the word and I'll lay
it down, or we can resolve the open questions above first.
