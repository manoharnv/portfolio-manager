/**
 * secrets.tf — Secret Manager secret *shells* (docs/08 §8.5, docs/07 §7.4).
 *
 * Terraform creates the secret resources and their replication policy only.
 * It NEVER creates a `google_secret_manager_secret_version` — values are
 * added manually, once, per infra/README.md Phase 0
 * (`gcloud secrets versions add <name> --data-file=-`). This is the task's
 * hard rule ("no secrets, no real project ids... placeholders only") applied
 * to Terraform state too: a secret value in a `.tf`/`.tfvars` file would sit
 * in plaintext in the Terraform state file forever.
 *
 * Secret ids below are the literal defaults `apps/backend/src/config.ts`
 * resolves against Secret Manager (`DHAN_API_KEY_SECRET` etc.) — see the
 * cross-check table in infra/README.md. If you rename a secret_id here, you
 * MUST override the matching `*_SECRET` env var in backend.env to match, or
 * the backend will look up a name Secret Manager has never heard of and
 * fail closed (SessionUnavailableError).
 */

locals {
  # apps/backend/src/config.ts `RawConfigSchema` defaults, in the order they
  # appear there.
  backend_secret_ids = [
    "dhan-api-key",      # DHAN_API_KEY_SECRET
    "dhan-api-secret",   # DHAN_API_SECRET_SECRET
    "dhan-access-token", # DHAN_ACCESS_TOKEN_SECRET (backend rewrites daily)
    "dhan-client-id",    # DHAN_CLIENT_ID_SECRET
    "kite-api-key",      # KITE_API_KEY_SECRET
    "kite-api-secret",   # KITE_API_SECRET_SECRET
    "kite-access-token", # KITE_ACCESS_TOKEN_SECRET (backend rewrites daily)
  ]

  # The subset the backend calls `secrets.set(...)` on at runtime, after the
  # daily broker login exchange — apps/backend/src/services/session.ts line
  # ~188 (`deps.secrets.set(secretNames.accessToken, ...)`). Grep confirms
  # this is the ONLY `secrets.set` call site in apps/backend/src; apiKey,
  # apiSecret and clientId are operator-entered and never rewritten by code.
  backend_writable_secret_ids = [
    "dhan-access-token",
    "kite-access-token",
  ]

  # apps/strategy/src/index.ts `PM_BROKER_SECRET` env var holds this secret's
  # full Secret Manager resource name (not just the id — see env/strategy.env.example).
  # Payload shape is `@pm/core`'s `BrokerCreds` (packages/core/src/broker.ts),
  # the task's own read-creds JSON shape:
  #   {"broker":"dhan","dhan":{"clientId":"...","accessToken":"...","expiresAt":"..."}}
  #   {"broker":"kite","kite":{"apiKey":"...","accessToken":"...","expiresAt":"..."}}
  # This is intentionally a SEPARATE secret from dhan-access-token /
  # kite-access-token — those two feed the order-capable backend; this one
  # feeds the read-only strategy engine and never carries order privileges
  # even though the token string itself may be broker-side identical.
  strategy_secret_ids = [
    "pm-strategy-read-creds",
  ]

  all_secret_ids = concat(local.backend_secret_ids, local.strategy_secret_ids)
}

resource "google_secret_manager_secret" "this" {
  for_each = toset(local.all_secret_ids)

  project   = var.project_id
  secret_id = each.value

  labels = {
    app     = "portfolio-manager"
    managed = "terraform"
  }

  # Regional user-managed replication in `var.region` (asia-south1) rather
  # than `automatic` — keeps the secret payload resident in-region, matching
  # docs/08 §8.1's "everything in asia-south1" posture. See docs/11 items
  # this module doesn't otherwise touch: replication has no effect on IAM.
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.this]
}
