/**
 * iam.tf — least-privilege service accounts (docs/08 §8.5, docs/07 §7.4,
 * docs/11 §11.4 #3).
 *
 * docs/11 §11.4 #3 is binding: "Service-account scoping is not enforceable
 * by Firestore IAM (no per-collection conditions)... Infra must still give
 * the engine SA the least role (roles/datastore.user) and no Secret Manager
 * access to order/token secrets." The bindings below implement exactly that
 * for `pm-strategy`.
 *
 * IMPORTANT CAVEAT — read this before trusting the isolation on paper:
 * A Compute Engine VM has exactly ONE attached service account, shared by
 * every process on it regardless of Linux user. vm.tf attaches `pm-backend`
 * to the VM (it's the process that must reach the most APIs). That means,
 * as deployed by this module, the `pm-strategy` OS user's Application
 * Default Credentials ALSO resolve to `pm-backend`'s identity via the
 * metadata server — the restrictive `pm-strategy` bindings below are not
 * yet the live enforcement boundary. We deliberately chose this over
 * issuing `pm-strategy` its own downloadable JSON key, per the task brief's
 * own preference: a long-lived key file is a real bearer secret that needs
 * rotation and tight file permissions, versus the metadata server's
 * automatically-rotated, non-exfiltratable-past-the-VM tokens. Today the
 * live enforcement for "strategy cannot touch order/token secrets" is:
 *   1. code + lint + policy.test.ts (docs/05 §5.1) — apps/strategy never
 *      imports an order-capable adapter factory, so no code path calls
 *      `secrets.get('dhan-access-token')` even though it network-could;
 *   2. `strategy.env` never contains the order/token secret *names* — only
 *      `PM_BROKER_SECRET` (the read-creds secret's own name);
 *   3. the OS-level egress allowlist (infra/vm/nftables-strategy-egress.conf).
 * The `pm_strategy` service account and its narrow grants below become the
 * REAL, IAM-enforced boundary the moment you take either follow-up step:
 *   (a) move the strategy unit to its own compute (a second small VM or a
 *       Cloud Run job) with `pm_strategy` as that resource's own identity, or
 *   (b) accept the key-management cost and issue `pm-strategy` a key
 *       (`gcloud iam service-accounts keys create`), installed at
 *       `/etc/pm/strategy-sa-key.json` (mode 0600, owned by the `pm-strategy`
 *       OS user) with `GOOGLE_APPLICATION_CREDENTIALS` set in strategy.env —
 *       NOT done by this module; do it by hand and rotate it like any other
 *       long-lived credential if you go this route.
 * We still create the SA and its bindings now (rather than leaving it to a
 * later change) because docs/11 §11.4 #3 asks for the least-privilege grant
 * to exist, and because it's the correct target state for (a)/(b) above.
 */

resource "google_service_account" "pm_backend" {
  project      = var.project_id
  account_id   = "pm-backend"
  display_name = "pm-backend — execution backend, order-capable (docs/04)"
}

resource "google_service_account" "pm_strategy" {
  project      = var.project_id
  account_id   = "pm-strategy"
  display_name = "pm-strategy — strategy engine, read-only + proposals-only (docs/05)"
}

# ---- project-level roles ---------------------------------------------------

resource "google_project_iam_member" "backend_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.pm_backend.email}"
}

resource "google_project_iam_member" "backend_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.pm_backend.email}"
}

resource "google_project_iam_member" "backend_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.pm_backend.email}"
}

# VERIFY-LIVE: `roles/firebaseauth.viewer` ("Firebase Authentication Viewer")
# is our best-confidence predefined role for what the Admin SDK needs to do
# `auth.verifyIdToken(idToken, /* checkRevoked */ true)`
# (apps/backend/src/adapters/firebase-auth.ts) — checkRevoked performs an
# account lookup against Identity Platform beyond plain local JWT
# verification. Confirm against a live token in Phase 1 (docs/11 §11.5): if
# it 403s, try `roles/identitytoolkit.viewer` next; only as a last resort
# fall back to `checkRevoked: false` (a code change outside this module).
resource "google_project_iam_member" "backend_firebaseauth_viewer" {
  project = var.project_id
  role    = "roles/firebaseauth.viewer"
  member  = "serviceAccount:${google_service_account.pm_backend.email}"
}

resource "google_project_iam_member" "strategy_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.pm_strategy.email}"
}

resource "google_project_iam_member" "strategy_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.pm_strategy.email}"
}

resource "google_project_iam_member" "strategy_metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.pm_strategy.email}"
}

# ---- per-secret roles -------------------------------------------------------
# Firestore IAM cannot scope by collection (docs/11 §11.4 #3), so Secret
# Manager per-secret bindings are the one place real least-privilege access
# control is achievable at all in this system — see the module-level caveat
# above about which identity is actually live on the VM today.

resource "google_secret_manager_secret_iam_member" "backend_accessor" {
  for_each = toset(local.backend_secret_ids)

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pm_backend.email}"
}

# Only the two daily-access-token secrets get versionAdder — "the backend
# writes the daily token" (task brief). apiKey/apiSecret/clientId are
# operator-entered and long-lived; nothing in apps/backend/src ever calls
# `secrets.set` on them (grep confirms the only `secrets.set` call site is
# `secretNames.accessToken` in services/session.ts).
# `secretVersionManager` (not just `secretVersionAdder`): the backend adds a
# fresh daily token version and then DESTROYS the previous ones
# (apps/backend/src/adapters/secret-manager.ts `retireOtherVersions`), because
# Secret Manager bills every non-destroyed version — without destroy rights the
# daily refresh would accumulate ~60 paid versions a month. The role also grants
# list/disable/enable on these same writable secrets only; still no access to
# anything outside `backend_writable_secret_ids`.
resource "google_secret_manager_secret_iam_member" "backend_version_adder" {
  for_each = toset(local.backend_writable_secret_ids)

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value].secret_id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${google_service_account.pm_backend.email}"
}

# Operating window (vm.tf `pm_backend_schedule`): Compute Engine's own service
# agent is what starts and stops the VM on the instance schedule, and it needs
# instanceAdmin.v1 on the project to do so — without this grant the schedule
# is accepted but silently never fires. This is Google's service agent, not
# one of our SAs; it gains nothing on Firestore/Secret Manager.
data "google_project" "current" {
  project_id = var.project_id
}

resource "google_project_iam_member" "compute_agent_instance_admin" {
  count = var.vm_schedule_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:service-${data.google_project.current.number}@compute-system.iam.gserviceaccount.com"
}

# Strategy: accessor on the READ-creds secret ONLY — no `for_each` over
# `backend_secret_ids` here, ever. This is the literal implementation of
# docs/11 §11.4 #3's "no Secret Manager access to order/token secrets."
resource "google_secret_manager_secret_iam_member" "strategy_accessor" {
  for_each = toset(local.strategy_secret_ids)

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.pm_strategy.email}"
}
