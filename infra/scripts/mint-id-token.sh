#!/usr/bin/env bash
#
# infra/scripts/mint-id-token.sh — print a short-lived (1 h) Firebase ID token
# for an allow-listed uid, for infra/scripts/smoke.sh's authenticated check.
#
#   PM_ID_TOKEN=$(infra/scripts/mint-id-token.sh <PROJECT_ID> <FIREBASE_UID> <WEB_API_KEY>) \
#     infra/scripts/smoke.sh https://<DOMAIN>
#
# How: the Firebase Admin SDK (from apps/strategy's node_modules, using your
# Application Default Credentials) creates a custom token for the uid, signed
# through the backend service account's signBlob, and the Identity Toolkit
# REST API exchanges it for an ID token. Nothing here reads or writes any
# Secret Manager secret.
#
# Prerequisites:
#   - `gcloud auth application-default login` done on this machine;
#   - roles/iam.serviceAccountTokenCreator on pm-backend@<PROJECT_ID> for your
#     user (project Owner does NOT include signBlob) — see smoke.sh's output;
#   - the workspace installed (`pnpm install`) so firebase-admin resolves.
#
# The token is a credential for that user: it goes to stdout only, never to a
# file in the repo, never into shell history via echo. Treat it accordingly.

set -euo pipefail

PROJECT_ID="${1:?usage: mint-id-token.sh <PROJECT_ID> <FIREBASE_UID> <WEB_API_KEY>}"
UID_="${2:?usage: mint-id-token.sh <PROJECT_ID> <FIREBASE_UID> <WEB_API_KEY>}"
WEB_API_KEY="${3:?usage: mint-id-token.sh <PROJECT_ID> <FIREBASE_UID> <WEB_API_KEY>}"
SA="${PM_BACKEND_SA:-pm-backend@${PROJECT_ID}.iam.gserviceaccount.com}"

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

export GOOGLE_CLOUD_PROJECT="${PROJECT_ID}" GOOGLE_CLOUD_QUOTA_PROJECT="${PROJECT_ID}"
cd "${REPO_ROOT}/apps/strategy"

PM_PROJECT="${PROJECT_ID}" PM_UID="${UID_}" PM_KEY="${WEB_API_KEY}" PM_SA="${SA}" node --input-type=module -e '
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
const { PM_PROJECT, PM_UID, PM_KEY, PM_SA } = process.env;
initializeApp({ credential: applicationDefault(), projectId: PM_PROJECT, serviceAccountId: PM_SA });
const custom = await getAuth().createCustomToken(PM_UID);
const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${PM_KEY}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
});
const body = await res.json();
if (typeof body.idToken !== "string") { console.error("token exchange failed:", JSON.stringify(body).slice(0, 300)); process.exit(1); }
process.stdout.write(body.idToken);
' 2>/dev/null
