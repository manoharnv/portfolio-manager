#!/usr/bin/env bash
#
# infra/scripts/deploy.sh — redeploy the backend + strategy units on the VM
# to a given git ref (docs/08 §8.6). Invoked by .github/workflows/deploy.yml
# over `gcloud compute ssh --tunnel-through-iap`, or by hand:
#
#   sudo bash /opt/pm/infra/scripts/deploy.sh <ref>
#
# Must run as root (or via sudo) — /opt/pm is root-owned (infra/vm/bootstrap.sh)
# and restarting pm-backend.service/pm-strategy.service needs systemctl
# privileges. Idempotent-ish: safe to run twice in a row with the same ref.
#
# Deliberately refuses a dirty working tree rather than stashing/discarding
# anything (docs/00 §0.7: fail closed, never silently clobber hand-made
# changes on the VM).

set -euo pipefail

readonly REPO_DIR="${REPO_DIR:-/opt/pm}"
readonly REF="${1:?usage: deploy.sh <git-ref>}"

log() { printf '[deploy] %s\n' "$*" >&2; }

if [[ "${EUID}" -ne 0 ]]; then
	echo "deploy.sh must run as root (it restarts systemd units and writes to ${REPO_DIR}) — re-run with sudo." >&2
	exit 1
fi

cd "${REPO_DIR}"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "refusing to deploy: ${REPO_DIR} has uncommitted changes. Investigate before redeploying:" >&2
	git status --short >&2
	exit 1
fi

log "fetching origin/${REF}"
git fetch origin "${REF}"

log "checking out ${REF}"
git checkout "${REF}"
# If REF is a branch (not a tag/sha), fast-forward to its latest — `checkout`
# alone leaves you at whatever commit was already fetched for that name
# locally on a re-run.
git merge --ff-only "origin/${REF}" 2>/dev/null || true

log "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

log "pnpm build"
pnpm build

log "restarting pm-backend, pm-strategy"
systemctl restart pm-backend.service pm-strategy.service

# Give the backend a moment to bind its port before probing it.
sleep 3

# shellcheck source=/dev/null
source /etc/pm/backend.env 2>/dev/null || true
PORT="${PORT:-8080}"

log "health check: http://127.0.0.1:${PORT}/health"
if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health"; then
	echo
	log "health check OK"
else
	echo
	log "health check FAILED — see 'systemctl status pm-backend' output below"
fi

echo
log "service statuses:"
systemctl status --no-pager -l pm-backend.service pm-strategy.service caddy.service || true
