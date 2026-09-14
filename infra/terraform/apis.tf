/**
 * apis.tf — enable the GCP APIs this system needs.
 *
 * docs/08 §8.1: "Services: Compute Engine, Firestore (native), Firebase Auth,
 * Cloud Messaging, Cloud Functions, Secret Manager, Cloud Logging/Monitoring."
 * Plus IAM + Cloud Resource Manager (service accounts / project metadata) and
 * Cloud Scheduler (functions/README.md scheduled sweeps, docs/11 §11.3 #4) and
 * Cloud Run (2nd-gen Cloud Functions deploy onto Cloud Run under the hood).
 *
 * `disable_dependent_services = false` and `disable_on_destroy = false`: a
 * `terraform destroy` must never silently disable APIs out from under a
 * project that might have other resources depending on them (defense against
 * an accidental blast-radius outside this module — docs/00 §0.7 fail closed).
 */

locals {
  # Firebase enablement (Firestore Native + Auth + FCM) is done via the
  # `firebase` CLI in infra/README.md Phase 0, not Terraform — the
  # `firebase.googleapis.com` / `firebaseauth.googleapis.com` API-enable
  # step below is a prerequisite for that CLI step, not a substitute for it.
  required_apis = [
    "compute.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudscheduler.googleapis.com",
    "run.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "firebase.googleapis.com",
    # Required for 2nd-gen Cloud Functions (build + artifact storage) and for
    # the Admin SDK / gcloud auth token exchange used throughout.
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "eventarc.googleapis.com",
    "iamcredentials.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each = toset(local.required_apis)

  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}
