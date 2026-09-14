#!/usr/bin/env bash
#
# infra/scripts/smoke.sh — minimal post-deploy smoke test (docs/11 go-live
# checklist / infra/README.md "smoke test" step).
#
#   1. unauthenticated GET /health  — must succeed for anyone (it's the one
#      public route: apps/backend/src/http/app.ts PUBLIC_PATHS).
#   2. authenticated GET /v1/session — needs a Firebase ID token. This
#      script does NOT mint one (that needs a real test-user password /
#      Firebase Web API key, i.e. project-specific secrets that don't belong
#      in this repo) — pass one in, or read the instructions this script
#      prints when you don't.
#
# Usage:
#   infra/scripts/smoke.sh https://pm.example.com [id-token]
#   PM_ID_TOKEN=eyJ...  infra/scripts/smoke.sh https://pm.example.com

set -euo pipefail

HOST="${1:?usage: smoke.sh <https://your-domain> [firebase-id-token]}"
HOST="${HOST%/}" # strip a trailing slash if given
ID_TOKEN="${2:-${PM_ID_TOKEN:-}}"

log() { printf '[smoke] %s\n' "$*" >&2; }

log "GET ${HOST}/health (unauthenticated)"
if ! body="$(curl -fsS --max-time 10 "${HOST}/health")"; then
	echo "FAILED: /health did not return 2xx" >&2
	exit 1
fi
printf '%s\n' "${body}"
log "/health OK"

if [[ -z "${ID_TOKEN}" ]]; then
	cat >&2 <<EOF

No ID token provided — skipping the authenticated /v1/session check.

The app signs in with Google/Apple only (no password users), so mint a
short-lived (1 h) ID token for an allow-listed uid via a Firebase custom token:

  PM_ID_TOKEN=\$(infra/scripts/mint-id-token.sh <PROJECT_ID> <FIREBASE_UID> <FIREBASE_WEB_API_KEY>) \\
    infra/scripts/smoke.sh ${HOST}

One-time prerequisite: the operator needs roles/iam.serviceAccountTokenCreator
on the backend service account (the Admin SDK signs the custom token through
its signBlob; project Owner does NOT include that permission):

  gcloud iam service-accounts add-iam-policy-binding \\
    pm-backend@<PROJECT_ID>.iam.gserviceaccount.com \\
    --member=user:<YOU> --role=roles/iam.serviceAccountTokenCreator --project=<PROJECT_ID>

<FIREBASE_WEB_API_KEY> is the "Web API Key" on Project Settings > General
(the same value as EXPO_PUBLIC_FIREBASE_API_KEY in apps/mobile/.env). It
identifies the project and authorizes nothing by itself. The uid must be in
backend.env's ALLOWED_UIDS or /v1/session will correctly 403. Never commit or
paste the minted token anywhere.
EOF
	exit 0
fi

log "GET ${HOST}/v1/session (authenticated)"
response_body="$(mktemp)"
trap 'rm -f "${response_body}"' EXIT
http_code="$(curl -sS -o "${response_body}" -w '%{http_code}' --max-time 10 \
	-H "Authorization: Bearer ${ID_TOKEN}" \
	"${HOST}/v1/session")"

cat "${response_body}"
echo

if [[ "${http_code}" != "200" ]]; then
	echo "FAILED: /v1/session returned HTTP ${http_code}" >&2
	exit 1
fi

log "/v1/session OK"
