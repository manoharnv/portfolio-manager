/**
 * versions.tf — Terraform/provider version pins.
 *
 * docs/08-infrastructure.md (IaC, §8.6): "Terraform in infra/ for project, VM,
 * static IP, firewall, Secret Manager, service accounts, Firestore config."
 *
 * Pinned so `terraform init` is reproducible across operator machines and CI.
 * Bump deliberately, not by drift.
 */

terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}
