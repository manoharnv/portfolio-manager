#!/usr/bin/env bash
#
# infra/vm/egress-allowlist.sh — (re)resolves the strategy engine's egress
# hostnames, repopulates the nftables sets defined in
# infra/vm/nftables-strategy-egress.conf, and PINS each hostname in /etc/hosts
# to one of the addresses it just allowed (docs/01 §1.5, docs/08 §8.2).
#
# Run once at boot and every 10 minutes thereafter by
# pm-egress-allowlist.{service,timer} (installed by bootstrap.sh). Must run
# as root (nft requires CAP_NET_ADMIN; /etc/hosts is root-owned).
#
# Why the pin (docs/11 §11.6 #15): api.dhan.co and the Google APIs sit behind
# CDNs/anycast fronts whose DNS answers rotate between lookups (CloudFront
# returned 108.158.46.x on one lookup and 18.161.246.x on the next). An IP
# allowlist filled from THIS process's lookups only matches the engine's own
# later lookups by luck — every miss is a dropped connection and a strategy
# tick failing closed with "fetch failed". Pinning the hostname to one of the
# allowed addresses makes both processes agree by construction: glibc's
# getaddrinfo (which Node's dns.lookup, undici and grpc-js all use) consults
# /etc/hosts before DNS. The pins are refreshed on every cycle; the sets keep
# every address seen, so a stale pin is still allowed until the next refresh.
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
#   - Resolution goes through `host` (bind9-host, installed by bootstrap.sh)
#     because it asks DNS directly: `getent ahosts` would read back our own
#     /etc/hosts pin and never see a new address again. `getent` remains the
#     fallback when `host` is missing, and the way `metadata.google.internal`
#     is resolved (the guest agent seeds it in /etc/hosts; it is never pinned).

set -euo pipefail

readonly NFT_TABLE="inet pm_filter"
readonly SET_V4="strategy_allowed_v4"
readonly SET_V6="strategy_allowed_v6"
readonly HOSTS_FILE="/etc/hosts"
readonly PIN_BEGIN="# BEGIN pm-egress-allowlist (managed by infra/vm/egress-allowlist.sh — do not edit)"
readonly PIN_END="# END pm-egress-allowlist"

# docs/08 §8.3 (Dhan/Kite order+read share hosts), docs/08 §8.5 (Firestore /
# Secret Manager). The instrument masters are read from the backend's local
# cache (PM_INSTRUMENTS_DIR), so no CDN host is needed for them. Keep this
# list in sync with infra/README.md's egress-allowlist table if you change it.
readonly HOSTS=(
	api.dhan.co             # Dhan REST API (read AND order endpoints — see caveat above)
	api.kite.trade          # Kite REST API (read AND order endpoints)
	firestore.googleapis.com
	secretmanager.googleapis.com
	oauth2.googleapis.com
	metadata.google.internal
)

# Already static in /etc/hosts (seeded by the GCE guest agent) — never pinned,
# and resolved through getent so the seed is what we see.
readonly NO_PIN=(metadata.google.internal)

log() {
	logger -t pm-egress-allowlist -- "$*" 2>/dev/null || true
	printf '%s\n' "$*" >&2
}

is_no_pin() {
	local h
	for h in "${NO_PIN[@]}"; do [[ "$h" == "$1" ]] && return 0; done
	return 1
}

# One address per line, IPv4 and IPv6 mixed, de-duplicated. DNS-only via
# `host` so an existing pin cannot mask a changed record.
resolve_host() {
	local host="$1"
	if ! is_no_pin "${host}" && command -v host >/dev/null 2>&1; then
		{
			host -t A "${host}" 2>/dev/null || true
			host -t AAAA "${host}" 2>/dev/null || true
		} | awk '/ has (IPv6 )?address /{print $NF}' | sort -u
	else
		getent ahosts "${host}" 2>/dev/null | awk '{print $1}' | sort -u || true
	fi
}

# Replace our managed block in /etc/hosts atomically (write + rename).
write_pins() {
	local block="$1" tmp
	tmp="$(mktemp "${HOSTS_FILE}.pm.XXXXXX")"
	awk -v b="${PIN_BEGIN}" -v e="${PIN_END}" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "${HOSTS_FILE}" >"${tmp}"
	printf '%s\n%s%s\n' "${PIN_BEGIN}" "${block}" "${PIN_END}" >>"${tmp}"
	chmod 0644 "${tmp}"
	mv -f "${tmp}" "${HOSTS_FILE}"
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

if ! command -v host >/dev/null 2>&1; then
	log "WARN: 'host' (bind9-host) not installed — resolving via getent; hostnames will NOT be pinned, so CDN-backed hosts may fail intermittently."
fi

v4_addrs=()
v6_addrs=()
failed_hosts=()
pin_block=""
pinned=0

for host in "${HOSTS[@]}"; do
	mapfile -t resolved < <(resolve_host "${host}")

	if [[ ${#resolved[@]} -eq 0 ]]; then
		failed_hosts+=("${host}")
		log "WARN: could not resolve '${host}' this cycle — leaving it out of this refresh."
		continue
	fi

	first_v4=""
	for addr in "${resolved[@]}"; do
		if [[ "${addr}" == *:* ]]; then
			v6_addrs+=("${addr}")
		else
			v4_addrs+=("${addr}")
			[[ -z "${first_v4}" ]] && first_v4="${addr}"
		fi
	done

	# Pin to the first IPv4 (the VM has no IPv6 egress; both units run Node
	# with --dns-result-order=ipv4first).
	if ! is_no_pin "${host}" && command -v host >/dev/null 2>&1 && [[ -n "${first_v4}" ]]; then
		pin_block+="${first_v4} ${host}"$'\n'
		pinned=$((pinned + 1))
	fi
done

if [[ ${#v4_addrs[@]} -eq 0 && ${#v6_addrs[@]} -eq 0 ]]; then
	log "FATAL: resolved zero addresses across all ${#HOSTS[@]} hosts — refusing to replace the existing allowlist with an empty one (fail closed: keep the last-known-good set)."
	exit 1
fi

# Pins first, then the sets that must contain them.
if [[ ${pinned} -gt 0 ]]; then
	if ! write_pins "${pin_block}"; then
		log "ERROR: could not rewrite ${HOSTS_FILE} — pins are stale; egress to CDN-backed hosts may fail until the next cycle."
	fi
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
	log "refreshed egress allowlist with $((${#v4_addrs[@]} + ${#v6_addrs[@]})) addresses, ${pinned} pinned; ${#failed_hosts[@]} host(s) failed to resolve: ${failed_hosts[*]}"
	exit 0
fi

log "refreshed egress allowlist: ${#v4_addrs[@]} IPv4 + ${#v6_addrs[@]} IPv6 addresses across ${#HOSTS[@]} hosts; ${pinned} hostname(s) pinned in ${HOSTS_FILE}."
