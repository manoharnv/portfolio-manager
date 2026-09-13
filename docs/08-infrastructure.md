# 08 · Infrastructure

Minimal, cheap, and shaped by one hard requirement: **the thing that places orders
must have a stable static IP** that we whitelist with the broker.

## 8.1 GCP project

- **Dedicated project** (e.g. `portfolio-mgr-prod`), separate from your other apps, for
  blast-radius isolation — anything that can touch money is walled off.
- Region: **`asia-south1` (Mumbai)** — lowest latency to Indian broker endpoints.
- Services: Compute Engine, Firestore (native), Firebase Auth, Cloud Messaging, Cloud
  Functions, Secret Manager, Cloud Logging/Monitoring.

## 8.2 The VM

| Attribute | Value |
|---|---|
| Type | `e2-micro` (upgrade to `e2-small` if strategy load grows) |
| Region/zone | `asia-south1-a` |
| OS | Debian 12 / Ubuntu 22.04 LTS |
| External IP | **reserved static** (free while attached to a running instance) |
| Disk | 20–30 GB standard PD |
| Cost | ~$7–8/month |

Runs two units (both TypeScript/Node, isolated as separate systemd services / users):

```
┌───────────────────────── e2-micro (STATIC IP) ─────────────────────────┐
│  systemd: pm-backend      → execution backend REST (HTTPS)  [order creds] │
│  systemd: pm-strategy      → strategy scheduler + Claude routines [read]  │
│  reverse proxy (caddy)     → TLS termination, HSTS, :443 → backend        │
│  egress firewall           → strategy unit: allowlist read+Firestore only │
└──────────────────────────────────────────────────────────────────────────┘
```

Isolation on the box:
- Backend and strategy run as **separate OS users** with separate service-account
  keys and separate Secret Manager grants (backend: order secrets; strategy:
  read-only).
- **Egress firewall** (nftables / VPC egress rules) restricts the strategy user to
  broker *read* hosts + Firestore + Secret Manager. It cannot reach order endpoints.
- Backend listens only on the proxy; no direct public port besides 443.

## 8.3 Static IP & broker whitelisting

1. Reserve a static external IP in `asia-south1`, attach to the VM.
2. Register that IP with the broker:
   - **Dhan**: developer portal → app → *Whitelisted IPs* (supports multiple), or via
     Dhan's *Setup Static IP* API. Required for order APIs (place/modify/cancel).
   - **Kite**: developer console → app → whitelist (one IP per app).
3. Store the IP in config for the audit trail (`orders.ipUsed`). Alert if the VM's
   observed egress IP ever differs.

> Because Dhan allows multiple IPs, you can whitelist a **staging VM** IP too for safe
> testing without disturbing prod. Kite's single-IP limit means Kite testing shares or
> swaps the IP.

## 8.4 Firebase (managed, no static IP needed)

These never call broker order APIs, so their dynamic IPs are fine:
- **Firestore** (native mode): data + proposals + audit. TTL policies + composite
  indexes per [03](03-data-model.md).
- **Firebase Auth**: app login (Google/Apple).
- **Cloud Messaging**: push.
- **Cloud Functions** (2nd gen): `onProposalCreate → send FCM`; scheduled
  `expireProposals`; scheduled `reconcileOrders` (or run these on the VM). Functions
  must **never** be given broker order creds.

## 8.5 Secret Manager

| Secret id | Contents | Accessor |
|---|---|---|
| `dhan-api-key`, `dhan-api-secret` | Dhan credentials | backend SA |
| `dhan-access-token` | daily token (rewritten daily, TTL) | backend SA |
| `kite-api-key`, `kite-api-secret` | Kite credentials | backend SA |
| `kite-access-token` | daily token | backend SA |
| `fb-admin-backend` | Admin SA (full Firestore) | backend SA |
| `fb-admin-strategy` | Admin SA (proposals-only) | strategy SA |

## 8.6 Deploy & CI/CD

- **Monorepo** (pnpm + turbo). `packages/core` builds once; apps consume it.
- **Backend/strategy**: build → Docker image → push to Artifact Registry → VM pulls &
  `systemctl restart` (or a simple `git pull && pnpm build && restart` for v1).
- **Functions**: `firebase deploy --only functions`.
- **Firestore rules/indexes**: `firebase deploy --only firestore`.
- **Mobile**: EAS Build (Expo) → TestFlight / internal track.
- **CI** (GitHub Actions): typecheck, lint, unit tests (guardrails + adapters with
  mocked broker), zod-schema contract tests, then deploy on tag.
- **IaC**: Terraform in `infra/` for project, VM, static IP, firewall, Secret Manager,
  service accounts, Firestore config (add once shape stabilises; Phase 0 can be
  gcloud/console).

## 8.7 Environments & separation

| Env | Where | Broker | Static IP |
|---|---|---|---|
| dev / dry-run | laptop or VM | none (simulated) | n/a |
| paper | staging VM | sandbox (if any) | staging IP (Dhan multi-IP) |
| prod | prod VM | Dhan → Kite | prod reserved IP |

## 8.8 Monitoring & backup

- **Uptime check** on `/v1/health`; alert on failure (fail-closed means no orders if
  down — you want to know).
- **Metrics**: order latency, guardrail-block rate, token-expiry countdown, daily
  notional used vs cap.
- **Log-based alerts**: `IP_NOT_WHITELISTED`, `AUTH_EXPIRED` bursts, place failures.
- **Firestore backups**: scheduled daily export to a GCS bucket.
- **VM**: enable auto-restart; snapshot disk weekly.

## 8.9 Cost summary

| Item | Monthly |
|---|---|
| e2-micro (asia-south1) | ~$7–8 |
| Static IP (attached) | $0 |
| Firestore/Auth/FCM/Functions (single user) | ~$0 (free tier) |
| Secret Manager | ~$0 (few secrets) |
| GCS backups | negligible |
| Dhan orders | free |
| Dhan data | ₹0 (25+ trades/mo) or ₹499 |
| **Total** | **~₹600–₹1,300/month** |
