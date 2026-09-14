#!/usr/bin/env bash
#
# infra/scripts/rotate-broker-key.sh — add a new Secret Manager version for
# one broker secret, then restart the backend so it picks it up. Used both
# for routine rotation (docs/07 §7.4: "broker key annually") and step 2 of
# the incident playbook (docs/07 §7.8: "revoke broker token / rotate
# secret" — infra/README.md's incident-playbook section documents the full
# sequence this script is one step of).
#
# Deliberately takes the new secret VALUE as a local file path, never as a
# command-line argument or inline literal — an argument lands in shell
# history and `ps` output; a file you control does not. This script never
# contains, prints, or logs the value itself.
#
# Usage:
#   infra/scripts/rotate-broker-key.sh <secret-name> <path-to-value-file> \
#     --project <gcp-project-id> [--vm pm-backend-vm] [--zone asia-south1-a]
#
# <secret-name> must be one of the secret_ids infra/terraform/secrets.tf
# creates (dhan-api-key, dhan-api-secret, dhan-access-token, dhan-client-id,
# kite-api-key, kite-api-secret, kite-access-token, pm-strategy-read-creds)
# — see infra/README.md's secret table for which backend.env / strategy.env
# variable names each one.
#
# Requires: `gcloud`, authenticated with rights to
# `secretmanager.versions.add` on the secret and
# `compute.instances.osLogin`/IAP tunnel access to the VM.

set -euo pipefail

log() { printf '[rotate-broker-key] %s\n' "$*" >&2; }

SECRET_NAME="${1:?usage: rotate-broker-key.sh <secret-name> <value-file> --project <id> [--vm NAME] [--zone ZONE]}"
VALUE_FILE="${2:?usage: rotate-broker-key.sh <secret-name> <value-file> --project <id> [--vm NAME] [--zone ZONE]}"
shift 2

PROJECT_ID=""
VM_NAME="pm-backend-vm"
ZONE="asia-south1-a"

while [[ $# -gt 0 ]]; do
	case "$1" in
	--project)
		PROJECT_ID="${2:?--project needs a value}"
		shift 2
		;;
	--vm)
		VM_NAME="${2:?--vm needs a value}"
		shift 2
		;;
	--zone)
		ZONE="${2:?--zone needs a value}"
		shift 2
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 1
		;;
	esac
done

if [[ -z "${PROJECT_ID}" ]]; then
	echo "refusing to guess: pass --project <gcp-project-id>" >&2
	exit 1
fi

if [[ ! -s "${VALUE_FILE}" ]]; then
	echo "value file '${VALUE_FILE}' is missing or empty" >&2
	exit 1
fi

command -v gcloud >/dev/null 2>&1 || {
	echo "gcloud not found on PATH" >&2
	exit 1
}

log "adding a new version of secret '${SECRET_NAME}' in project ${PROJECT_ID} (value never printed)"
gcloud secrets versions add "${SECRET_NAME}" \
	--project="${PROJECT_ID}" \
	--data-file="${VALUE_FILE}"

log "restarting pm-backend on ${VM_NAME} (${ZONE}) via IAP"
gcloud compute ssh "${VM_NAME}" \
	--project="${PROJECT_ID}" \
	--zone="${ZONE}" \
	--tunnel-through-iap \
	--command="sudo systemctl restart pm-backend.service && systemctl is-active pm-backend.service"

log "done. ${VALUE_FILE} still contains the plaintext secret — delete/shred it yourself now:"
log "  shred -u '${VALUE_FILE}'   (or) rm -f '${VALUE_FILE}'"
