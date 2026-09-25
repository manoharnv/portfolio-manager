/**
 * outputs.tf — values the operator needs for Phase 0 steps this module
 * doesn't itself perform (broker whitelisting, DNS, manual secret values).
 */

output "static_ip" {
  description = "Reserved prod IP — whitelist this with Dhan/Kite and point the DNS A record at it (infra/README.md Phase 0)."
  value       = google_compute_address.pm_static_ip.address
}

output "staging_static_ip" {
  description = "Reserved staging IP (only present when enable_staging_vm=true)."
  value       = var.enable_staging_vm ? google_compute_address.pm_staging_static_ip[0].address : null
}

output "vm_name" {
  description = "Prod VM instance name, for `gcloud compute ssh --tunnel-through-iap` and `gcloud compute instances ...`."
  value       = google_compute_instance.pm_backend.name
}

output "staging_vm_name" {
  description = "Staging VM instance name (only present when enable_staging_vm=true)."
  value       = var.enable_staging_vm ? google_compute_instance.pm_staging[0].name : null
}

output "pm_backend_service_account_email" {
  description = "Order-capable service account email — also the VM's single attached identity (see iam.tf caveat)."
  value       = google_service_account.pm_backend.email
}

output "pm_strategy_service_account_email" {
  description = "Read-only/proposals-only service account email — see iam.tf for why this isn't yet the VM's live runtime identity."
  value       = google_service_account.pm_strategy.email
}

output "secret_ids" {
  description = "Secret Manager secret ids created (values NOT set by Terraform — add them per infra/README.md Phase 0)."
  value       = [for s in google_secret_manager_secret.this : s.secret_id]
}

output "firestore_backups_bucket" {
  description = "GCS bucket provisioned for ad-hoc/manual `gcloud firestore export` output (docs/08 §8.8)."
  value       = google_storage_bucket.firestore_backups.name
}

output "notification_channel_id" {
  description = "Cloud Monitoring email notification channel resource name."
  value       = google_monitoring_notification_channel.email.id
}
