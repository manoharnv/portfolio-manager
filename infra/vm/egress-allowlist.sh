#!/usr/bin/env bash
#
# infra/vm/egress-allowlist.sh — (re)resolves the strategy engine's egress
# hostnames and repopulates the nftables sets defined in
# infra/vm/nftables-strategy-egress.conf (docs/01 §1.5, docs/08 §8.2).
#
# Run once at boot and every 10 minutes thereafter by
# pm-egress-allowlist.{service,timer} (installed by bootstrap.sh). Must run
# as root (nft requires CAP_NET_ADMIN).
#
# Design notes (read before changing the host list):
#   - Order endpoints and read endpoints share hostnames on both brokers
#     (api.dhan.co, api.kite.trade) — this script, like the nft rules it
#     feeds, enforces HOSTS, not PATHS. See the long comment at the top of
#     nftables-strategy-egress.conf.
#   - A host that fails to resolve this cycle is logged and skipped rather
#     than aborting the whole refresh — the OTHER hosts' addresses still get
#     applied. The net effect of a transient DNS failure is losing egress to
#     just that one host until the next successful cycle: a fail-CLOSED
#     outcome (a temporary read-connectivity gap), never a security gap.
#   - Uses `getent ahosts`, not `dig`/`host` — it's part of glibc (always
#     present on Debian), needs no extra package, and it also transparently
#     picks up /etc/hosts, which is how `metadata.google.internal` resolves
#     on GCE (the guest agent seeds /etc/hosts with the metadata server's
#     link-local IP, not a real DNS record).

set -euo pipefail

readonly NFT_TABLE="inet pm_filter"
readonly SET_V4="strategy_allowed_v4"
readonly SET_V6="strategy_allowed_v6"

# docs/08 §8.3 (Dhan/Kite order+read share hosts), infra/vm/env/strategy.env.example
# (PM_INSTRUMENTS_URL), docs/08 §8.5 (Firestore/Secret Manager). Keep this
# list in sync with infra/README.md's egress-allowlist table if you change it.
readonly HOSTS=(
	api.dhan.co             # Dhan REST API (read AND order endpoints — see caveat above)
	images.dhan.co          # Dhan scrip-master CSV (packages/broker-dhan DHAN_SCRIP_MASTER_URL)
	api.kite.trade          # Kite REST API + /instruments CSV (read AND order endpoints)
	firestore.googleapis.com
	secretmanager.googleapis.com
	oauth2.googleapis.com
	metadata.google.internal
)

log() {
	logger -t pm-egress-allowlist -- "$*" 2>/dev/null || true
	printf '%s\n' "$*" >&2
}

if ! command -v nft >/dev/null 2>&1; then
	log "FATAL: nft not found — is nftables installed? Refusing to continue (fail closed)."
	exit 1
fi

# shellcheck disable=SC2086 # deliberately unquoted: nft wants "inet" and
# "pm_filter" as two separate words, not one quoted string.
if ! nft list table ${NFT_TABLE} >/dev/null 2>&1; then
	log "FATAL: table ${NFT_TABLE} does not exist yet — run bootstrap.sh (or load nftables-strategy-egress.conf) first."
	exit 1
fi

v4_addrs=()
v6_addrs=()
failed_hosts=()

for host in "${HOSTS[@]}"; do
	# `getent ahosts` prints one line per resolved address (may repeat the
	# same family several times); field 1 is the raw IP.
	mapfile -t resolved < <(getent ahosts "${host}" 2>/dev/null | awk '{print $1}' | sort -u || true)

	if [[ ${#resolved[@]} -eq 0 ]]; then
		failed_hosts+=("${host}")
		log "WARN: could not resolve '${host}' this cycle — leaving it out of this refresh."
		continue
	fi

	for addr in "${resolved[@]}"; do
		if [[ "${addr}" == *:* ]]; then
			v6_addrs+=("${addr}")
		else
			v4_addrs+=("${addr}")
		fi
	done
done

if [[ ${#v4_addrs[@]} -eq 0 && ${#v6_addrs[@]} -eq 0 ]]; then
	log "FATAL: resolved zero addresses across all ${#HOSTS[@]} hosts — refusing to replace the existing allowlist with an empty one (fail closed: keep the last-known-good set)."
	exit 1
fi

# Build one nft script and apply it as a single atomic transaction so there
# is never a window where the set is empty (flush + re-add happen together).
tmp_script="$(mktemp)"
trap 'rm -f "${tmp_script}"' EXIT

{
	echo "flush set ${NFT_TABLE} ${SET_V4}"
	if [[ ${#v4_addrs[@]} -gt 0 ]]; then
		printf 'add element %s %s { %s }\n' "${NFT_TABLE}" "${SET_V4}" "$(
			IFS=,
			echo "${v4_addrs[*]}"
		)"
	fi
	echo "flush set ${NFT_TABLE} ${SET_V6}"
	if [[ ${#v6_addrs[@]} -gt 0 ]]; then
		printf 'add element %s %s { %s }\n' "${NFT_TABLE}" "${SET_V6}" "$(
			IFS=,
			echo "${v6_addrs[*]}"
		)"
	fi
} >"${tmp_script}"

nft -f "${tmp_script}"

if [[ ${#failed_hosts[@]} -gt 0 ]]; then
	log "refreshed egress allowlist with $((${#v4_addrs[@]} + ${#v6_addrs[@]})) addresses; ${#failed_hosts[@]} host(s) failed to resolve: ${failed_hosts[*]}"
	exit 0
fi

log "refreshed egress allowlist: ${#v4_addrs[@]} IPv4 + ${#v6_addrs[@]} IPv6 addresses across ${#HOSTS[@]} hosts."
