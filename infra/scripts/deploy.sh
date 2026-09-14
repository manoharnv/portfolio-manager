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

# Server apps + their workspace deps only (same rule as infra/vm/bootstrap.sh):
# a bare `pnpm install && pnpm build` would pull the mobile app's Expo/RN tree
# and run `expo export` on a 1 GB e2-micro for artifacts the VM never uses.
log "pnpm install --frozen-lockfile (backend, strategy and their deps only)"
pnpm install --frozen-lockfile --filter '@pm/backend...' --filter '@pm/strategy...'

log "pnpm build (backend, strategy and their deps only)"
pnpm --filter '@pm/backend...' --filter '@pm/strategy...' build

# The VM's baked startup script is frozen (vm.tf ignores metadata_startup_script:
# changing it would force-replace the VM). Re-running the checked-out
# bootstrap.sh is the sanctioned way to ship unit/config/firewall/swap changes;
# it is idempotent, and with the checkout present it never rebuilds.
log "re-applying infra/vm/bootstrap.sh (units, configs, firewall, swap)"
bash "${REPO_DIR}/infra/vm/bootstrap.sh"

log "restarting pm-backend, pm-strategy"
systemctl restart pm-backend.service pm-strategy.service

# shellcheck source=/dev/null
source /etc/pm/backend.env 2>/dev/null || true
PORT="${PORT:-8080}"

# The backend downloads both brokers' instrument masters (multi-MB CSVs)
# before it binds its port — 45–90 s on an e2-micro — so probe with patience
# instead of failing 3 s after the restart.
log "health check: http://127.0.0.1:${PORT}/health (waiting up to 180 s for the backend to bind)"
health_ok=0
for _ in $(seq 1 36); do
	if body="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then
		health_ok=1
		break
	fi
	sleep 5
done
if [[ "${health_ok}" == 1 ]]; then
	printf '%s\n' "${body}"
	log "health check OK"
else
	log "health check FAILED after 180 s — see 'systemctl status pm-backend' / 'journalctl -u pm-backend' output below"
fi

echo
log "service statuses:"
systemctl status --no-pager -l pm-backend.service pm-strategy.service caddy.service || true
