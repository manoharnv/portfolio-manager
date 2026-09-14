/**
 * vm.tf — the e2-micro that runs both units (docs/08 §8.2).
 *
 * The boot disk is a standalone `google_compute_disk` (rather than an
 * inline `boot_disk.initialize_params` block) purely so it has a stable
 * resource address to attach the daily-snapshot policy to.
 */

resource "google_compute_disk" "pm_backend_boot" {
  project = var.project_id
  name    = "pm-backend-boot"
  zone    = var.zone
  image   = var.image
  type    = "pd-standard"
  size    = 30 # GB — docs/08 §8.2: "20-30 GB standard PD"
}

resource "google_compute_instance" "pm_backend" {
  project      = var.project_id
  name         = "pm-backend-vm"
  zone         = var.zone
  machine_type = var.machine_type
  tags         = ["pm-api"]

  boot_disk {
    source = google_compute_disk.pm_backend_boot.id
  }

  network_interface {
    network    = data.google_compute_network.default.id
    subnetwork = data.google_compute_subnetwork.default.id

    access_config {
      nat_ip = google_compute_address.pm_static_ip.address
    }
  }

  # Single attached identity for the whole VM — see the long caveat on
  # `pm_strategy` in iam.tf. `cloud-platform` scope hands all authorization
  # decisions to IAM (the bindings in iam.tf), which is the modern
  # recommended pattern over enumerating legacy OAuth access scopes.
  service_account {
    email  = google_service_account.pm_backend.email
    scopes = ["cloud-platform"]
  }

  # docs/08 §8.2 topology diagram: systemd units for pm-backend + pm-strategy,
  # caddy, and the strategy egress firewall are all installed by this one
  # idempotent script, re-run safely by infra/scripts/deploy.sh on every
  # deploy. Metadata values below are this script's only per-environment
  # inputs — never a secret (secrets come from Secret Manager, never GCE
  # metadata, which is readable by anything with a shell on the VM).
  metadata = {
    pm-domain       = var.domain
    pm-repo-url     = var.repo_url
    pm-repo-ref     = var.repo_ref
    pm-gcp-project  = var.project_id
    pm-allowed-uids = join(",", var.allowed_uids)
  }

  metadata_startup_script = file("${path.module}/../vm/bootstrap.sh")

  # Debian 12 supports Shielded VM; there's no reason not to enable all three
  # on a box that holds broker order credentials.
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # Lets `terraform apply` change machine_type/metadata/etc. by stopping and
  # restarting the instance instead of requiring a destroy/recreate that
  # would lose the attached static IP's association or force re-whitelisting.
  allow_stopping_for_update = true

  # This VM's identity is the broker-whitelisted static IP (docs/08 §8.3).
  # An accidental `terraform destroy` here is not a "redeploy," it's an
  # incident (re-whitelisting takes broker-side turnaround time) — require a
  # deliberate `terraform apply` with this flipped to false first.
  deletion_protection = true

  # Operating window (docs/08 §8.2): started/stopped by the instance schedule
  # below. Empty when the schedule is disabled (always-on mode).
  resource_policies = var.vm_schedule_enabled ? [google_compute_resource_policy.pm_backend_schedule[0].self_link] : []

  labels = {
    app = "portfolio-manager"
    env = "prod"
  }
}

# ---- operating window -------------------------------------------------------
# The VM only needs to exist during the Indian trading day plus a pre-market
# window: up at 07:15 IST (two hours before the 09:15 open, for pre-market
# study and the opening gap), down at 16:15 IST (after the 15:45 eod tick and
# the reconcile loop have settled). Compute Engine's native instance schedule
# does this for free — no Cloud Function, no cron on the box.
#
# Costs that this changes (docs/08 §8.9): compute is billed only while
# running, but the reserved static IP is billed at the *unused* rate
# ($0.01/h, double the in-use rate) while the VM is stopped — and it must stay
# reserved, because it is the address the brokers whitelist.
#
# Known limitation: no holiday calendar — the VM also runs on NSE holidays
# that fall Mon–Fri (~9 h × ~15 days/yr ≈ $0.10/month). The strategy engine
# itself no-ops on holidays via PM_HOLIDAYS.
#
# Requires roles/compute.instanceAdmin.v1 on the Compute Engine service agent
# (iam.tf `compute_agent_instance_admin`), or the schedule silently never fires.
resource "google_compute_resource_policy" "pm_backend_schedule" {
  count = var.vm_schedule_enabled ? 1 : 0

  project = var.project_id
  region  = var.region
  name    = "pm-backend-trading-window"

  instance_schedule_policy {
    time_zone = "Asia/Kolkata"

    vm_start_schedule {
      schedule = var.vm_start_cron
    }

    vm_stop_schedule {
      schedule = var.vm_stop_cron
    }
  }
}

# Daily boot-disk snapshot. docs/08 §8.8 says "snapshot disk weekly"; we ship
# daily here (7-day retention, so cost is ~7 incremental snapshots at any
# time) because the marginal cost of a Standard PD snapshot at this size is
# a few cents/month and a same-day restore point matters more than the
# saving — dial back to a weekly `daily_schedule` cadence if you'd rather
# match docs/08 exactly.
resource "google_compute_resource_policy" "pm_backend_snapshot" {
  project = var.project_id
  region  = var.region
  name    = "pm-backend-daily-snapshot"

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "18:30" # 00:00 IST — after market close, before pre-open
      }
    }
    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      storage_locations = [var.region]
      guest_flush       = false
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "pm_backend_snapshot" {
  project = var.project_id
  zone    = var.zone
  name    = google_compute_resource_policy.pm_backend_snapshot.name
  disk    = google_compute_disk.pm_backend_boot.name
}

# ---- optional staging VM (docs/08 §8.3/§8.7) -------------------------------
# Off by default. Dhan allows multiple whitelisted IPs, so this can run
# against real Dhan read/paper endpoints without touching the prod IP; Kite's
# one-IP-per-app limit means Kite testing here would have to (re)whitelist
# this IP over the prod one out-of-band — not automated by this module.

resource "google_compute_disk" "pm_staging_boot" {
  count = var.enable_staging_vm ? 1 : 0

  project = var.project_id
  name    = "pm-staging-boot"
  zone    = var.zone
  image   = var.image
  type    = "pd-standard"
  size    = 30
}

resource "google_compute_instance" "pm_staging" {
  count = var.enable_staging_vm ? 1 : 0

  project      = var.project_id
  name         = "pm-staging-vm"
  zone         = var.zone
  machine_type = var.machine_type
  tags         = ["pm-api"]

  boot_disk {
    source = google_compute_disk.pm_staging_boot[0].id
  }

  network_interface {
    network    = data.google_compute_network.default.id
    subnetwork = data.google_compute_subnetwork.default.id

    access_config {
      nat_ip = google_compute_address.pm_staging_static_ip[0].address
    }
  }

  service_account {
    email  = google_service_account.pm_backend.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    pm-domain       = var.domain
    pm-repo-url     = var.repo_url
    pm-repo-ref     = var.repo_ref
    pm-gcp-project  = var.project_id
    pm-allowed-uids = join(",", var.allowed_uids)
  }

  metadata_startup_script = file("${path.module}/../vm/bootstrap.sh")

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  allow_stopping_for_update = true
  # Staging is disposable by design — no deletion_protection.
  deletion_protection = false

  labels = {
    app = "portfolio-manager"
    env = "staging"
  }
}
