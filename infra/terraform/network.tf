/**
 * network.tf — reserved static IP + firewall (docs/08 §8.2/§8.3, docs/01 §1.6).
 *
 * The static IP is the whole point of running a VM instead of Cloud Run
 * (docs/01 §1.6): brokers whitelist it, so it must survive VM
 * stop/start/recreate. Firewall: only 80/443 in from the internet (Caddy
 * terminates TLS), and SSH only through Identity-Aware Proxy's TCP
 * forwarding range — never a public 0.0.0.0/0:22.
 *
 * Uses the project's auto-mode "default" VPC/subnet rather than creating a
 * custom network — this is a single-VM system and a custom VPC would add
 * moving parts without a security benefit here. If your project was created
 * without the default network, set one up first (Phase 0 in infra/README.md).
 */

data "google_compute_network" "default" {
  project = var.project_id
  name    = "default"
}

data "google_compute_subnetwork" "default" {
  project = var.project_id
  region  = var.region
  name    = "default"
}

# The reserved external IP the prod VM binds to (vm.tf) and whitelists with
# the broker (infra/README.md Phase 0). Regional, not global — matches a
# zonal Compute Engine instance's network interface.
resource "google_compute_address" "pm_static_ip" {
  project      = var.project_id
  name         = "pm-backend-static-ip"
  region       = var.region
  address_type = "EXTERNAL"
  description  = "Reserved IP whitelisted with the broker(s) — docs/08 §8.3. Do not release while any broker whitelist references it."
}

# A second, independent reserved IP for the optional staging VM (docs/08
# §8.3: "Because Dhan allows multiple IPs, you can whitelist a staging VM IP
# too"). Kite's one-IP-per-app limit means Kite staging either reuses the
# prod IP out-of-band or simply isn't exercised against real Kite endpoints.
resource "google_compute_address" "pm_staging_static_ip" {
  count = var.enable_staging_vm ? 1 : 0

  project      = var.project_id
  name         = "pm-staging-static-ip"
  region       = var.region
  address_type = "EXTERNAL"
  description  = "Reserved IP for the staging VM (enable_staging_vm=true) — docs/08 §8.3/§8.7."
}

# Ingress: Caddy's HTTP-01 ACME challenge (80) and HTTPS (443). Public by
# necessity — the mobile app and the broker's webhook callbacks (if any)
# reach the backend here. The backend itself binds only to 127.0.0.1
# (docs/08 §8.2: "Backend listens only on the proxy; no direct public port
# besides 443") so this rule never exposes the app port directly.
resource "google_compute_firewall" "pm_allow_web" {
  project     = var.project_id
  name        = "pm-allow-web"
  network     = data.google_compute_network.default.id
  direction   = "INGRESS"
  priority    = 1000
  target_tags = ["pm-api"]

  source_ranges = ["0.0.0.0/0"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# SSH only via IAP TCP forwarding (`gcloud compute ssh --tunnel-through-iap`).
# 35.235.240.0/20 is Google's fixed IAP source range — never widen this.
resource "google_compute_firewall" "pm_allow_iap_ssh" {
  project     = var.project_id
  name        = "pm-allow-iap-ssh"
  network     = data.google_compute_network.default.id
  direction   = "INGRESS"
  priority    = 1000
  target_tags = ["pm-api"]

  source_ranges = ["35.235.240.0/20"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# VERIFY-LIVE (infra): a freshly created GCP project's auto-mode "default"
# network comes with implicit rules named `default-allow-ssh` (0.0.0.0/0
# tcp:22), `default-allow-rdp`, and `default-allow-icmp`. Terraform did not
# create them, so this module does not manage or delete them. They MUST be
# removed by hand (see infra/README.md Phase 0) or the IAP-only SSH posture
# above is cosmetic — a public 0.0.0.0/0:22 rule would still allow direct SSH.
