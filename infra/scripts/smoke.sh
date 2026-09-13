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

To mint a short-lived ID token for a TEST user via the Firebase Auth REST API
(never do this with a real/production account, and never commit the output):

  curl -fsS -X POST \\
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_WEB_API_KEY>" \\
    -H 'Content-Type: application/json' \\
    -d '{"email":"<TEST_USER_EMAIL>","password":"<TEST_USER_PASSWORD>","returnSecureToken":true}' \\
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["idToken"])'

<FIREBASE_WEB_API_KEY> is the "Web API Key" on the Firebase console's
Project Settings > General page (not a secret in the Secret Manager sense —
it identifies the project, it doesn't authorize anything by itself — but
still don't paste real values into a shared shell history). The test user
must exist in Firebase Auth (Authentication > Users) and its uid must be in
backend.env's ALLOWED_UIDS or /v1/session will correctly 403.

Then re-run:
  PM_ID_TOKEN=<the idToken value>  infra/scripts/smoke.sh ${HOST}
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
