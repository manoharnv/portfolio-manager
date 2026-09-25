/**
 * providers.tf — provider configuration.
 *
 * No credentials are configured here. The operator authenticates out-of-band
 * (`gcloud auth application-default login` for interactive `plan`/`apply`, or
 * Workload Identity Federation in CI — see `.github/workflows/deploy.yml`).
 * docs/00 §0.7: no secrets in this repo, so nothing here ever references a
 * service-account key file.
 */

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
