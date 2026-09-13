#!/usr/bin/env bash
#
# infra/vm/bootstrap.sh — first-boot AND every-reboot provisioning for the
# e2-micro (docs/08 §8.2). Set as `metadata_startup_script` in
# infra/terraform/vm.tf, so GCE re-runs this on every boot — it must be
# fully idempotent (every step below is guarded to no-op when already done).
#
# Also safe to re-run by hand over SSH (`sudo bash /opt/pm/infra/vm/bootstrap.sh`)
# after editing this file, e.g. to pick up a new systemd unit without a full
# infra/scripts/deploy.sh cycle.
#
# PLACEHOLDERS: this script hardcodes no real domain or project id anywhere.
# `PM_DOMAIN`/`REPO_URL`/`REPO_REF`/`GCP_PROJECT`/`ALLOWED_UIDS` are read from
# GCE instance metadata (set by infra/terraform/vm.tf from your
# terraform.tfvars) with generic fallbacks, and can also be pre-exported as
# environment variables if you run this script by hand off-GCE for review.

set -euo pipefail

export HOME="${HOME:-/root}"
export DEBIAN_FRONTEND=noninteractive

log() { printf '[bootstrap] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 0. Read configuration from GCE instance metadata (best-effort — falls back
#    to placeholders so this script doesn't hard-fail off-GCE).
# ---------------------------------------------------------------------------
metadata() {
	local key="$1" default="${2:-}" value=""
	value="$(curl -sf -H 'Metadata-Flavor: Google' \
		"http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" \
		2>/dev/null)" || value=""
	[[ -n "${value}" ]] && printf '%s' "${value}" || printf '%s' "${default}"
}

external_ip() {
	curl -sf -H 'Metadata-Flavor: Google' \
		'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' \
		2>/dev/null || printf ''
}

REPO_URL="${REPO_URL:-$(metadata pm-repo-url 'https://github.com/manoharnv/portfolio-manager.git')}"
REPO_REF="${REPO_REF:-$(metadata pm-repo-ref 'main')}"
PM_DOMAIN="${PM_DOMAIN:-$(metadata pm-domain 'pm.example.com')}"
GCP_PROJECT="${GCP_PROJECT:-$(metadata pm-gcp-project '')}"
ALLOWED_UIDS="${ALLOWED_UIDS:-$(metadata pm-allowed-uids '')}"
STATIC_IP="$(external_ip)"

readonly REPO_URL REPO_REF PM_DOMAIN GCP_PROJECT ALLOWED_UIDS STATIC_IP
readonly REPO_DIR=/opt/pm

log "config: repo=${REPO_URL}#${REPO_REF} domain=${PM_DOMAIN} project=${GCP_PROJECT:-<unset>} static_ip=${STATIC_IP:-<unset>}"

# ---------------------------------------------------------------------------
# 1. Base packages + Node 22 (NodeSource) + pnpm 11.1.1 (corepack) — docs/00 §0.1.
# ---------------------------------------------------------------------------
apt-get update -y
apt-get install -y --no-install-recommends \
	ca-certificates curl gnupg git nftables debian-keyring \
	debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22.* ]]; then
	log "installing Node 22 from NodeSource"
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs
else
	log "Node $(node -v) already installed, skipping"
fi

corepack enable
corepack prepare pnpm@11.1.1 --activate
log "pnpm $(pnpm --version 2>/dev/null || echo '?') ready"

# ---------------------------------------------------------------------------
# 2. Caddy (official apt repo) — docs/08 §8.2.
# ---------------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
	log "installing caddy from the official apt repo"
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		| tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
	apt-get update -y
	apt-get install -y caddy
else
	log "caddy already installed, skipping"
fi

# ---------------------------------------------------------------------------
# 3. Cloud Ops Agent — ships journald (pino JSON logs from both units, since
#    ExecStart runs `node` directly with no redirection) to Cloud Logging.
#    Without this, infra/terraform/monitoring.tf's log-based metrics
#    (IP_NOT_WHITELISTED, AUTH_EXPIRED bursts, order.failed) have nothing to
#    match — a plain GCE VM ships no logs on its own.
# ---------------------------------------------------------------------------
if ! systemctl list-unit-files 2>/dev/null | grep -q '^google-cloud-ops-agent'; then
	log "installing Cloud Ops Agent"
	curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
	bash add-google-cloud-ops-agent-repo.sh --also-install
	rm -f add-google-cloud-ops-agent-repo.sh
else
	log "Cloud Ops Agent already installed, skipping"
fi

# ---------------------------------------------------------------------------
# 4. System users — no login shell, no home directory (docs/08 §8.2: "two
#    isolated systemd units (backend + strategy as separate OS users)").
#    MUST exist before step 6 loads nftables-strategy-egress.conf, which
#    references `pm-strategy` by name in `meta skuid "pm-strategy"`.
# ---------------------------------------------------------------------------
id -u pm-backend >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pm-backend
id -u pm-strategy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin pm-strategy

# ---------------------------------------------------------------------------
# 5. Clone/update the repo and build (docs/00 §0.1: pnpm 11.1.1, Node >=22).
#    Runs as root: /opt/pm ends up root-owned and world-readable (default
#    umask), which is fine — pm-backend/pm-strategy only ever need to READ
#    and EXECUTE `dist/`, never write it. All writable per-service state
#    lives under /etc/pm/ instead, owned per-unit (step 8).
# ---------------------------------------------------------------------------
if [[ ! -d "${REPO_DIR}/.git" ]]; then
	log "cloning ${REPO_URL}#${REPO_REF} into ${REPO_DIR}"
	git clone --branch "${REPO_REF}" "${REPO_URL}" "${REPO_DIR}"
else
	log "updating existing checkout at ${REPO_DIR}"
	git -C "${REPO_DIR}" fetch origin "${REPO_REF}"
	git -C "${REPO_DIR}" checkout "${REPO_REF}"
	git -C "${REPO_DIR}" reset --hard "origin/${REPO_REF}"
fi

log "pnpm install (frozen lockfile) + build"
(cd "${REPO_DIR}" && pnpm install --frozen-lockfile && pnpm build)

# ---------------------------------------------------------------------------
# 6. nftables — strategy egress allowlist (docs/01 §1.5, docs/08 §8.2).
# ---------------------------------------------------------------------------
install -m 0644 "${REPO_DIR}/infra/vm/nftables-strategy-egress.conf" /etc/nftables-strategy-egress.conf
chmod +x "${REPO_DIR}/infra/vm/egress-allowlist.sh"

if ! grep -qxF 'include "/etc/nftables-strategy-egress.conf";' /etc/nftables.conf 2>/dev/null; then
	log "wiring nftables-strategy-egress.conf into /etc/nftables.conf"
	printf '\ninclude "/etc/nftables-strategy-egress.conf";\n' >>/etc/nftables.conf
fi

# ---------------------------------------------------------------------------
# 7. Caddy config + systemd drop-in so it picks up PM_DOMAIN/PM_BACKEND_PORT
#    from /etc/pm/caddy.env (the stock Debian caddy.service has no
#    EnvironmentFile= by default).
# ---------------------------------------------------------------------------
install -d -m 0755 /etc/caddy
install -m 0644 "${REPO_DIR}/infra/vm/Caddyfile" /etc/caddy/Caddyfile

install -d -m 0755 /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/pm-env.conf <<'UNIT'
[Service]
EnvironmentFile=/etc/pm/caddy.env
UNIT

# ---------------------------------------------------------------------------
# 8. /etc/pm/*.env — created from the checked-in examples ONLY IF ABSENT, so
#    re-running this script never clobbers values you've already filled in.
#    Mode 0600, owned by the unit that reads them.
# ---------------------------------------------------------------------------
install -d -m 0755 /etc/pm

if [[ ! -f /etc/pm/backend.env ]]; then
	log "seeding /etc/pm/backend.env from the example (fill in secrets project / ENVIRONMENT / MARKET_HOLIDAYS before going live)"
	cp "${REPO_DIR}/infra/vm/env/backend.env.example" /etc/pm/backend.env
	# Best-effort seed of what Terraform/the metadata server already know.
	# Everything else (ENVIRONMENT, LOG_LEVEL, MARKET_HOLIDAYS, ...) is left
	# at the example's safe defaults for the operator to review.
	[[ -n "${GCP_PROJECT}" ]] && sed -i "s|^GCP_PROJECT=.*|GCP_PROJECT=${GCP_PROJECT}|" /etc/pm/backend.env
	[[ -n "${GCP_PROJECT}" ]] && sed -i "s|^FIREBASE_PROJECT_ID=.*|FIREBASE_PROJECT_ID=${GCP_PROJECT}|" /etc/pm/backend.env
	[[ -n "${ALLOWED_UIDS}" ]] && sed -i "s|^ALLOWED_UIDS=.*|ALLOWED_UIDS=${ALLOWED_UIDS}|" /etc/pm/backend.env
	[[ -n "${STATIC_IP}" ]] && sed -i "s|^STATIC_IP=.*|STATIC_IP=${STATIC_IP}|" /etc/pm/backend.env
fi
chown pm-backend:pm-backend /etc/pm/backend.env
chmod 0600 /etc/pm/backend.env

if [[ ! -f /etc/pm/strategy.env ]]; then
	log "seeding /etc/pm/strategy.env from the example (fill in PM_UID / PM_BROKER_SECRET / PM_INSTRUMENTS_URL before starting)"
	cp "${REPO_DIR}/infra/vm/env/strategy.env.example" /etc/pm/strategy.env
	[[ -n "${ALLOWED_UIDS}" ]] && sed -i "s|^PM_UID=.*|PM_UID=${ALLOWED_UIDS%%,*}|" /etc/pm/strategy.env
fi
chown pm-strategy:pm-strategy /etc/pm/strategy.env
chmod 0600 /etc/pm/strategy.env

if [[ ! -f /etc/pm/caddy.env ]]; then
	cp "${REPO_DIR}/infra/vm/env/caddy.env.example" /etc/pm/caddy.env
	sed -i "s|^PM_DOMAIN=.*|PM_DOMAIN=${PM_DOMAIN}|" /etc/pm/caddy.env
fi
chmod 0644 /etc/pm/caddy.env

# ---------------------------------------------------------------------------
# 9. systemd units.
# ---------------------------------------------------------------------------
install -m 0644 "${REPO_DIR}/infra/vm/pm-backend.service" /etc/systemd/system/pm-backend.service
install -m 0644 "${REPO_DIR}/infra/vm/pm-strategy.service" /etc/systemd/system/pm-strategy.service
install -m 0644 "${REPO_DIR}/infra/vm/pm-egress-allowlist.service" /etc/systemd/system/pm-egress-allowlist.service
install -m 0644 "${REPO_DIR}/infra/vm/pm-egress-allowlist.timer" /etc/systemd/system/pm-egress-allowlist.timer

systemctl daemon-reload

# ---------------------------------------------------------------------------
# 10. Enable + start, in dependency order. `enable --now` is idempotent — a
#     no-op start if already running, so re-running this script on every
#     reboot never bounces a healthy service.
# ---------------------------------------------------------------------------
systemctl enable --now nftables.service
systemctl enable --now pm-egress-allowlist.timer
systemctl start pm-egress-allowlist.service # populate the sets now, don't wait for OnBootSec
systemctl enable --now caddy.service
systemctl enable --now pm-backend.service
systemctl enable --now pm-strategy.service

log "bootstrap complete. Check: systemctl status pm-backend pm-strategy caddy pm-egress-allowlist.timer"
log "Remember: /etc/pm/backend.env and /etc/pm/strategy.env still need PM_UID / PM_BROKER_SECRET / broker secret values filled in — see infra/README.md Phase 0."
