/**
 * firestore.tf — Firestore Native database + backups (docs/08 §8.1/§8.4/§8.8,
 * docs/03 data model).
 *
 * Firestore *rules*, *indexes*, and the two TTL field policies are NOT
 * managed here — they're deployed with the Firebase CLI
 * (`infra/scripts/firebase-deploy.sh`, mirroring `functions/README.md`)
 * because `firebase deploy` is the tool that understands `firestore.rules`
 * and `firestore.indexes.json`. Terraform only owns the database resource
 * itself, its delete-protection, and the backup schedule.
 *
 * Schema confirmed with `tofu validate` against `hashicorp/google` 6.50.0
 * (resolved from this file's own `~> 6.0` constraint) — both
 * `delete_protection_state` and `google_firestore_backup_schedule` (with a
 * `daily_recurrence {}` block and a protobuf-Duration-style `retention`
 * string) are accepted by that provider version's schema. VERIFY-LIVE
 * still applies to anything schema validation can't see: real IAM
 * permissions, and whether `retention = "604800s"` is accepted at apply
 * time exactly as typed (schema validation checks the field is a string,
 * not that the API accepts its contents).
 */

resource "google_firestore_database" "this" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Never let a stray `terraform destroy` (or a mistaken -target apply)
  # delete the single source of truth for proposals/orders/audit log.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "DELETE" # Terraform-side guard; see README for the two-step teardown this forces.

  depends_on = [google_project_service.this]
}

# GCS bucket the daily Firestore export lands in (docs/08 §8.8: "Firestore
# backups: scheduled daily export to a GCS bucket").
resource "google_storage_bucket" "firestore_backups" {
  project                     = var.project_id
  name                        = "${var.project_id}-firestore-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false

  lifecycle_rule {
    condition {
      age = 30 # days — matches the task's "lifecycle 30d"
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    app = "portfolio-manager"
  }
}

# Managed daily backup schedule (distinct from — and simpler than — a
# `gcloud firestore export` Cloud Scheduler job: this is Firestore's native
# backup feature, point-in-time restorable via `gcloud firestore backups`).
# 7-day retention per the task brief.
resource "google_firestore_backup_schedule" "daily" {
  project   = var.project_id
  database  = google_firestore_database.this.name
  retention = "604800s" # 7 days, in seconds (the API's duration format)

  daily_recurrence {}
}
