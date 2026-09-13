/**
 * variables.tf — inputs for the single root module.
 *
 * docs/08 §8.1/§8.2: dedicated project, asia-south1 region, e2-micro VM in
 * asia-south1-a. Fill real values in terraform.tfvars (git-ignored except
 * the *.example file — see docs/00 §0.7 / .gitignore).
 */

variable "project_id" {
  description = <<-EOT
    Dedicated GCP project id for this system (docs/08 §8.1: blast-radius
    isolation — this project should hold nothing else). Create it in
    Phase 0 per infra/README.md before running `terraform init`.
  EOT
  type        = string

  validation {
    condition     = length(var.project_id) > 0
    error_message = "project_id must not be empty — never default this to a shared project."
  }
}

variable "region" {
  description = "GCP region. docs/08 §8.1: asia-south1 (Mumbai) for lowest latency to Indian broker endpoints."
  type        = string
  default     = "asia-south1"
}

variable "zone" {
  description = "GCP zone for the VM. docs/08 §8.2."
  type        = string
  default     = "asia-south1-a"
}

variable "machine_type" {
  description = "VM machine type. docs/08 §8.2: e2-micro; upgrade to e2-small if strategy load grows."
  type        = string
  default     = "e2-micro"
}

variable "domain" {
  description = <<-EOT
    Public DNS name the mobile app / operator hits over HTTPS, e.g.
    "pm.example.com" (placeholder — this repo must never contain a real
    domain per the task's hard rules). Caddy requests a Let's Encrypt cert
    for this name; you must point a DNS A record at the reserved static IP
    (see outputs.tf `static_ip`) before the VM's first boot, or Caddy's ACME
    HTTP-01 challenge will fail.
  EOT
  type        = string
}

variable "allowed_uids" {
  description = <<-EOT
    Firebase Auth uids permitted to use the backend (docs/04 §4.9,
    config.ts `ALLOWED_UIDS`). Fail-closed: an empty list denies everyone.
    Passed to the VM as instance metadata (`pm-allowed-uids`, comma-joined)
    so `infra/vm/bootstrap.sh` can seed a fresh `/etc/pm/backend.env` on
    first boot — it is never written directly into Terraform state as a
    "secret" (uids are not secret) but double-check your tfvars file is not
    committed with real uids if that matters to you.
  EOT
  type        = list(string)
  default     = []
}

variable "alert_email" {
  description = "Email address for the Cloud Monitoring notification channel (docs/07 §7.7, docs/08 §8.8). Placeholder in the example file."
  type        = string
}

variable "image" {
  description = "Boot disk image for the VM. docs/08 §8.2: Debian 12."
  type        = string
  default     = "debian-cloud/debian-12"
}

variable "enable_staging_vm" {
  description = <<-EOT
    Create a second, smaller VM for paper-trading / staging (docs/08 §8.3,
    §8.7). Dhan allows whitelisting multiple IPs, so a staging VM can be
    tested without touching the prod IP; Kite's single-IP-per-app limit
    means Kite staging shares or swaps the IP instead. Off by default to
    keep the baseline deployment to one VM.
  EOT
  type        = bool
  default     = false
}

variable "repo_url" {
  description = <<-EOT
    Git URL `infra/vm/bootstrap.sh` clones to /opt/pm. Passed as instance
    metadata (`pm-repo-url`) rather than hardcoded in the script so a fork
    doesn't require editing bootstrap.sh. Placeholder default — point this
    at your own remote before applying.
  EOT
  type        = string
  default     = "https://github.com/manoharnv/portfolio-manager.git"
}

variable "repo_ref" {
  description = "Git branch/tag/ref `infra/vm/bootstrap.sh` checks out (instance metadata `pm-repo-ref`)."
  type        = string
  default     = "main"
}
