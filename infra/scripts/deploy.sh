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

# bash reads a script incrementally, and the `git checkout` below rewrites
# THIS file when the ref changes it — the rest of the run would then execute
# whatever bytes the new version has at the old offsets. So never run from
# the checkout: copy to a private temp file and re-exec from there. (A script
# piped over ssh — `sudo bash -s <ref> < deploy.sh` — has no file to rewrite
# and runs as is.)
if [[ "${PM_DEPLOY_DETACHED:-}" != 1 && -f "${BASH_SOURCE[0]:-}" ]]; then
	tmp_script="$(mktemp /tmp/pm-deploy.XXXXXX.sh)"
	cp -- "${BASH_SOURCE[0]}" "${tmp_script}"
	PM_DEPLOY_DETACHED=1 exec bash "${tmp_script}" "$@"
fi
if [[ "${PM_DEPLOY_DETACHED:-}" == 1 ]]; then
	trap 'rm -f -- "${BASH_SOURCE[0]}"' EXIT
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

# The strategy engine holds a parsed instrument master (~250 MB RSS) and does
# nothing between ticks; on a 1 GB box that is the difference between a build
# that takes 10 minutes and one that swaps for 20. It comes back at the end.
log "stopping pm-strategy for the duration of the build"
systemctl stop pm-strategy.service

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
PM_BOOTSTRAP_SKIP_START=1 bash "${REPO_DIR}/infra/vm/bootstrap.sh"

# Backend first, engine after it is healthy: both parse the same multi-MB
# instrument master at start-up, and doing that concurrently on 1 GB pushes
# the backend's bind time from ~2 min to 5+. The engine also reads the
# backend's freshly written cache (file:// PM_INSTRUMENTS_URL), so this order
# spares it a crash-loop until the file exists.
log "restarting pm-backend"
systemctl restart pm-backend.service

# shellcheck source=/dev/null
source /etc/pm/backend.env 2>/dev/null || true
PORT="${PORT:-8080}"

# The backend downloads + parses both brokers' instrument masters before it
# binds its port — 2–3 min on an e2-micro — so probe with patience.
readonly HEALTH_WAIT_S=360
log "health check: http://127.0.0.1:${PORT}/health (waiting up to ${HEALTH_WAIT_S} s for the backend to bind)"
health_ok=0
for _ in $(seq 1 $((HEALTH_WAIT_S / 5))); do
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
	log "health check FAILED after ${HEALTH_WAIT_S} s — see 'systemctl status pm-backend' / 'journalctl -u pm-backend' output below"
fi

log "starting pm-strategy"
systemctl start pm-strategy.service

echo
log "service statuses:"
systemctl status --no-pager -l pm-backend.service pm-strategy.service caddy.service || true

if [[ "${health_ok}" != 1 ]]; then
	exit 1
fi
