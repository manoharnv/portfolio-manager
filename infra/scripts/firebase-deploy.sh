#!/usr/bin/env bash
#
# infra/scripts/firebase-deploy.sh — deploy Firestore rules/indexes + Cloud
# Functions, then (re)apply the two TTL field policies that `firebase
# deploy` cannot set (functions/README.md "Firestore TTL policy" section;
# docs/11 §11.3 #6). Idempotent: re-running this is always safe.
#
# Usage:
#   infra/scripts/firebase-deploy.sh <gcp-project-id>
#   PROJECT_ID=<gcp-project-id> infra/scripts/firebase-deploy.sh
#
# Requires: `firebase` CLI (firebase-tools) and `gcloud`, both authenticated
# already (`firebase login` / `gcloud auth login`, or a CI service account
# via Workload Identity Federation — see .github/workflows/deploy.yml).
# Run from the repo root (or anywhere — it cd's to the repo root itself).

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() { printf '[firebase-deploy] %s\n' "$*" >&2; }

PROJECT_ID="${1:-${PROJECT_ID:-}}"
if [[ -z "${PROJECT_ID}" ]]; then
	echo "usage: $0 <gcp-project-id>   (or set PROJECT_ID env var)" >&2
	echo "refusing to guess a project — .firebaserc's checked-in default is a placeholder." >&2
	exit 1
fi

for bin in firebase gcloud pnpm; do
	command -v "${bin}" >/dev/null 2>&1 || {
		echo "required command '${bin}' not found on PATH" >&2
		exit 1
	}
done

cd "${REPO_ROOT}"

# firebase.json's `predeploy` only builds @pm/functions itself; it does NOT
# build @pm/functions's workspace dependency @pm/core first (esbuild resolves
# @pm/core to its dist/ output — functions/README.md, "Build" section). Build
# it explicitly so a clean checkout deploys correctly.
log "pnpm --filter @pm/core build"
pnpm --filter @pm/core build

log "firebase deploy --project ${PROJECT_ID} --only firestore:rules,firestore:indexes,functions"
firebase deploy --project "${PROJECT_ID}" --only firestore:rules,firestore:indexes,functions

# TTL policies — NOT part of firestore.indexes.json, not touched by
# `firebase deploy` (functions/README.md). `gcloud firestore fields ttls
# update --enable-ttl` on an already-TTL-enabled field is a no-op, so this is
# safe to re-run on every deploy.
log "applying TTL policy: proposals.ttlExpiresAt"
gcloud firestore fields ttls update ttlExpiresAt \
	--collection-group=proposals \
	--enable-ttl \
	--project="${PROJECT_ID}"

log "applying TTL policy: idempotency.createdAt"
gcloud firestore fields ttls update createdAt \
	--collection-group=idempotency \
	--enable-ttl \
	--project="${PROJECT_ID}"

log "done."
