#!/usr/bin/env bash
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

# Shape the runner's egress like a phone network, for the live E2E bots.
# Linux only (tc netem + iptables, needs root or passwordless sudo).
#
#   netem.sh apply <profile>   shape egress (replace-in-place, so idempotent)
#   netem.sh swap <profile>    same qdisc replace: atomic, no gap between profiles
#   netem.sh custom <delayMs> <jitterMs> <lossPct> <rateMbit>   shape with ad-hoc numbers
#   netem.sh spike <secs> <delayMs> <jitterMs> <lossPct> <rateMbit>   ad-hoc numbers for <secs>, then the previous link back
#   netem.sh outage <host> <secs>   drop all traffic to and from ONE host (iptables + ip6tables, every address it resolves to over three lookups) for <secs>, probing it before, during and after
#   netem.sh udp-cut <secs> <relay-host> <keep-host>   cut the WebRTC path for <secs> (UDP but DNS, and every address of the relay host,
#                              both directions) while <keep-host> (the People RPC: signalling, presence) stays reachable; proven by probes
#   netem.sh video-stall <secs>   drop UDP packets of 300 bytes or more, both directions, for <secs>: RTP stops, ICE consent passes
#   netem.sh blackout <secs>   drop everything, then restore the previous link
#   netem.sh host-chain-cut <windowS> <holdS> <host> <pid-file> [host-log] [in-force-marker]
#                              cut ONE PROCESS (the signing host, truapi-host) off <host>: its pid moves into its own cgroup v2,
#                              iptables -m cgroup REJECTs its new connects for <holdS>, ss -K kills its established sockets, then
#                              the probes watch the rest of <windowS> for its reconnect; the rest of the runner is never cut
#   netem.sh block-udp         drop outbound UDP except DNS (relay-only: TURN over TCP/TLS still works)
#   netem.sh clear             remove the shaping and the UDP block
#   netem.sh show              print the current state
#   netem.sh stats <label>     label and print raw tc -s counters without resetting them
#   netem.sh profile-args <p>  print the tc netem arguments (no root, any OS; tested)
#
# Profiles live in netem-profiles.json, the one source of truth that
# profile.ts validates too. Netem shapes the WHOLE runner (chain RPC and
# statement store included), which is also what a phone on LTE feels.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES_JSON="${NETEM_PROFILES_JSON:-$HERE/netem-profiles.json}"
STATE_FILE="${NETEM_STATE_FILE:-/tmp/netem-current-profile}"
ARGS_FILE="$STATE_FILE.args" # the tc netem arguments in force, so a blackout or spike restores an ad-hoc link too
UDP_CHAIN="E2E_NO_UDP"

say() { echo "[netem] $*"; }
die() { echo "[netem] ERROR: $*" >&2; exit 1; }
# A deliberately tiny, stable stdout protocol consumed by network.ts. The
# detail is always a hard-coded verb, never a host, address, secret or free-form
# error. Human diagnostics keep their existing [netem] prefix.
lifecycle() { printf 'E2E_NETEM_PHASE\t%s\t%s\n' "$1" "$2"; }

# Print the tc netem arguments for a profile, read from the JSON.
profile_args() {
  command -v node >/dev/null || die "node is needed to read $PROFILES_JSON"
  node -e '
    const [file, name] = process.argv.slice(1)
    const p = JSON.parse(require("fs").readFileSync(file, "utf8"))[name]
    if (!p) { console.error("unknown profile " + name + "; known: " + Object.keys(JSON.parse(require("fs").readFileSync(file, "utf8"))).join(", ")); process.exit(2) }
    const a = ["delay", p.delayMs + "ms"]
    if (p.jitterMs > 0) a.push(p.jitterMs + "ms")
    if (p.lossPct > 0) a.push("loss", p.lossPct + "%")
    if (p.rateMbit > 0) a.push("rate", p.rateMbit + "mbit")
    console.log(a.join(" "))
  ' "$PROFILES_JSON" "$1" || die "no such profile: $1"
}

need_linux() {
  [ "$(uname -s)" = "Linux" ] || die "netem is Linux-only (this is $(uname -s)); run it on the CI runner, not locally"
}

SUDO=""
setup_root() {
  need_linux
  if [ "$(id -u)" != "0" ]; then SUDO="sudo -n"; fi
  command -v tc >/dev/null || die "tc not found (apt-get install iproute2)"
}

egress_if() {
  local dev
  dev="$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)"
  if [ -n "$dev" ]; then echo "$dev" > "$STATE_FILE.dev"; else dev="$(cat "$STATE_FILE.dev" 2>/dev/null || true)"; fi
  if [ -z "$dev" ]; then ip -o route >&2 || true; ip -o addr >&2 || true; die "cannot detect the default egress interface"; fi
  echo "$dev"
}

set_qdisc() { # <profile>
  local dev args
  dev="$(egress_if)"
  args="$(profile_args "$1")"
  # shellcheck disable=SC2086
  put_args "$dev" "$1" "$args"
}

put_args() { # <dev> <label> <tc args>
  # shellcheck disable=SC2086
  # a pure link-quality change is `tc qdisc change` on the netem already in place, so it never tears the qdisc
  # down: `replace` was seen to stall established flows for ~3 s (game 185, bot 4's ICE links went
  # disconnected 5 s after the swap). `replace` only when there is no netem root yet.
  if $SUDO tc qdisc show dev "$1" | grep -q "qdisc netem 8001: root"; then
    $SUDO tc qdisc change dev "$1" root netem $3
  else
    $SUDO tc qdisc replace dev "$1" root netem $3
  fi
  echo "$2" > "$STATE_FILE"
  echo "$3" > "$ARGS_FILE"
  say "$1: netem $3  (profile $2)"
}

# tc netem arguments from the four ad-hoc numbers
custom_args() { # <delayMs> <jitterMs> <lossPct> <rateMbit>
  local a="delay ${1}ms"
  awk "BEGIN{exit !($2>0)}" && a="$a ${2}ms"
  awk "BEGIN{exit !($3>0)}" && a="$a loss ${3}%"
  awk "BEGIN{exit !($4>0)}" && a="$a rate ${4}mbit"
  echo "$a"
}

require_netem_absent() { # <dev> <safe label>
  local qdisc status
  if qdisc="$($SUDO tc qdisc show dev "$1" 2>/dev/null)"; then
    :
  else
    status=$?
    die "$2 NOT PROVEN: qdisc inspection failed on $1 (status $status)"
  fi
  if grep -q "qdisc netem .* root" <<< "$qdisc"; then die "$2 NOT PROVEN: netem is still installed on $1"; fi
}

restore_previous() { # <dev> <label> <args>
  if [ -n "$3" ]; then
    put_args "$1" "$2" "$3"
  else
    $SUDO tc qdisc del dev "$1" root 2>/dev/null || true
    require_netem_absent "$1" "spike restore"
    rm -f "$STATE_FILE" "$ARGS_FILE"
    say "$1: restored (no shaping)"
  fi
}

cmd_custom() {
  setup_root
  [ $# -eq 4 ] || die "usage: custom <delayMs> <jitterMs> <lossPct> <rateMbit>"
  put_args "$(egress_if)" "custom" "$(custom_args "$@")"
  lifecycle active custom
}

cmd_spike() {
  setup_root
  [ $# -eq 5 ] || die "usage: spike <secs> <delayMs> <jitterMs> <lossPct> <rateMbit>"
  local dev secs="$1" prev="" prev_args=""
  shift
  dev="$(egress_if)"
  [ -f "$STATE_FILE" ] && prev="$(cat "$STATE_FILE")"
  [ -f "$ARGS_FILE" ] && prev_args="$(cat "$ARGS_FILE")"
  put_args "$dev" "spike" "$(custom_args "$@")"
  lifecycle active spike
  sleep "$secs"
  restore_previous "$dev" "$prev" "$prev_args"
  lifecycle restored spike
}

cmd_apply() { setup_root; [ $# -eq 1 ] || die "usage: apply <profile>"; set_qdisc "$1"; lifecycle active apply; }
cmd_swap() { setup_root; [ $# -eq 1 ] || die "usage: swap <profile>"; set_qdisc "$1"; lifecycle active swap; }

cmd_stats() {
  setup_root
  [ $# -eq 1 ] || die "usage: stats <label>"
  local dev profile
  dev="$(egress_if)"
  profile="$(cat "$STATE_FILE" 2>/dev/null || echo none)"
  say "qdisc snapshot label=$1 profile=$profile local=$(date '+%Y-%m-%dT%H:%M:%S%z') interface=$dev"
  $SUDO tc -s qdisc show dev "$dev"
}

# A BLACKOUT is an iptables drop, not `netem loss 100%`: the netem form left the runner without a default route
# (a live run: "cannot detect the default egress interface" right after it, and an earlier boot-only
# self-test hung). Loopback and the Azure wire server / metadata addresses stay open, so the VM's own
# plumbing is never starved; everything else, both directions, is dropped for the duration.
BLACKOUT_CHAIN="E2E_BLACKOUT"
# One probe for the log: does a fresh connection to an outside host get through right now?
reach() { # <label>
  if curl -4 -sS -m 3 -o /dev/null https://example.com 2>/dev/null; then say "blackout probe ($1): outside host REACHED"; else say "blackout probe ($1): outside host UNREACHABLE"; fi
}
cmd_blackout() {
  setup_root
  [ $# -eq 1 ] || die "usage: blackout <seconds>"
  command -v iptables >/dev/null || die "iptables not found"
  # Drop EVERYTHING but loopback and the Azure wire server / metadata, both directions, at the very top of
  # OUTPUT and INPUT with no state match (established and related flows are cut too), IPv4 and IPv6.
  $SUDO iptables -w -N "$BLACKOUT_CHAIN" 2>/dev/null || $SUDO iptables -w -F "$BLACKOUT_CHAIN"
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -o lo -j ACCEPT
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -i lo -j ACCEPT
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -d 168.63.129.16 -j ACCEPT
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -s 168.63.129.16 -j ACCEPT
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -d 169.254.0.0/16 -j ACCEPT
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -s 169.254.0.0/16 -j ACCEPT
  $SUDO iptables -w -A "$BLACKOUT_CHAIN" -j DROP
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -N "$BLACKOUT_CHAIN" 2>/dev/null || $SUDO ip6tables -w -F "$BLACKOUT_CHAIN"
    $SUDO ip6tables -w -A "$BLACKOUT_CHAIN" -o lo -j ACCEPT
    $SUDO ip6tables -w -A "$BLACKOUT_CHAIN" -i lo -j ACCEPT
    $SUDO ip6tables -w -A "$BLACKOUT_CHAIN" -j DROP
  fi
  # an ESTABLISHED flow running across the window (a rate-limited download): bytes short of rate x time show it was cut
  local flowlog total; flowlog="$(mktemp)"; total=$(( $1 + 6 ))
  curl -4 -sS -m "$total" --limit-rate 100k -o /dev/null -w '%{size_download}' "https://speed.cloudflare.com/__down?bytes=50000000" > "$flowlog" 2>/dev/null &
  local pingpid=$!
  sleep 1
  reach "before"
  $SUDO iptables -w -I OUTPUT 1 -j "$BLACKOUT_CHAIN"
  $SUDO iptables -w -I INPUT 1 -j "$BLACKOUT_CHAIN"
  command -v ip6tables >/dev/null && { $SUDO ip6tables -w -I OUTPUT 1 -j "$BLACKOUT_CHAIN"; $SUDO ip6tables -w -I INPUT 1 -j "$BLACKOUT_CHAIN"; } || true
  lifecycle active blackout
  say "BLACKOUT for $1 s (iptables, both directions, no state match; the link in force stays: $( [ -f "$STATE_FILE" ] && cat "$STATE_FILE" || echo none ))"
  sleep 2
  reach "during"
  local rest=$(( $1 - 2 )); [ "$rest" -gt 0 ] && sleep "$rest"
  blackout_off
  prove_chain_off "blackout" "$BLACKOUT_CHAIN" OUTPUT INPUT
  lifecycle restored blackout
  say "blackout over"
  sleep 2
  reach "after"
  wait "$pingpid" 2>/dev/null || true
  say "established flow across the window: $(cat "$flowlog") bytes in $total s at 100 kB/s (unimpeded would be ~$(( total * 100000 )); a shortfall of about $(( $1 * 100000 )) is the blackout cutting it)"
  rm -f "$flowlog"
}
blackout_off() {
  $SUDO iptables -w -D OUTPUT -j "$BLACKOUT_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -D INPUT -j "$BLACKOUT_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -F "$BLACKOUT_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$BLACKOUT_CHAIN" 2>/dev/null || true
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -D OUTPUT -j "$BLACKOUT_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -D INPUT -j "$BLACKOUT_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -F "$BLACKOUT_CHAIN" 2>/dev/null && $SUDO ip6tables -w -X "$BLACKOUT_CHAIN" 2>/dev/null || true
  fi
}
require_hook_absent() { # <iptables command> <safe label> <rule...>
  local family="$1" label="$2" status
  shift 2
  command -v "$family" >/dev/null || return 0
  if $SUDO "$family" -w -C "$@" 2>/dev/null; then
    die "$label still installed after cleanup"
  else
    status=$?
    # iptables-nft and iptables-legacy disagree here: an absent rule in an
    # existing chain is 1, while a jump to a chain that has already been
    # deleted is 2. Both prove absence. Lock and inspection failures (4+) do
    # not, so keep those fail-closed.
    [ "$status" -eq 1 ] || [ "$status" -eq 2 ] || die "$label inspection failed after cleanup (status $status)"
  fi
}
prove_chain_off() { # <safe label> <chain> <hook...>
  local label="$1" chain="$2" family hook
  shift 2
  for family in iptables ip6tables; do
    command -v "$family" >/dev/null || continue
    for hook in "$@"; do
      require_hook_absent "$family" "$family $label $hook hook" "$hook" -j "$chain"
    done
  done
}

resolvers() { sed -n 's/^nameserver[[:space:]]\+\([^[:space:]]\+\).*/\1/p' /etc/resolv.conf; }

cmd_block_udp() {
  setup_root
  command -v iptables >/dev/null || die "iptables not found"
  $SUDO iptables -w -N "$UDP_CHAIN" 2>/dev/null || $SUDO iptables -w -F "$UDP_CHAIN"
  $SUDO iptables -w -A "$UDP_CHAIN" -o lo -j ACCEPT
  local r
  for r in $(resolvers); do
    case "$r" in *:*) continue ;; esac # iptables is IPv4; ip6tables is not handled
    $SUDO iptables -w -A "$UDP_CHAIN" -p udp -d "$r" --dport 53 -j ACCEPT
    say "UDP/53 to resolver $r stays open"
  done
  $SUDO iptables -w -A "$UDP_CHAIN" -p udp -j DROP
  $SUDO iptables -w -C OUTPUT -p udp -j "$UDP_CHAIN" 2>/dev/null || $SUDO iptables -w -I OUTPUT 1 -p udp -j "$UDP_CHAIN"
  command -v ip6tables >/dev/null && ($SUDO ip6tables -w -C OUTPUT -p udp ! -o lo -j DROP 2>/dev/null || $SUDO ip6tables -w -I OUTPUT 1 -p udp ! -o lo -j DROP 2>/dev/null) || true
  say "outbound UDP blocked except DNS; TURN over TCP/TLS still works"
  lifecycle active block-udp
}

cmd_allow_udp() {
  setup_root
  command -v iptables >/dev/null || die "iptables not found"
  $SUDO iptables -w -D OUTPUT -p udp -j "$UDP_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -F "$UDP_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$UDP_CHAIN" 2>/dev/null || true
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -D OUTPUT -p udp ! -o lo -j DROP 2>/dev/null || true
  fi
  require_hook_absent iptables "allow-udp IPv4 OUTPUT hook" OUTPUT -p udp -j "$UDP_CHAIN"
  require_hook_absent iptables "allow-udp IPv4 DROP rule" "$UDP_CHAIN" -p udp -j DROP
  require_hook_absent ip6tables "allow-udp IPv6 OUTPUT hook" OUTPUT -p udp ! -o lo -j DROP
  say "outbound UDP allowed"
  lifecycle active allow-udp
}

OUTAGE_CHAIN="E2E_OUTAGE"
# Every address of <host> as the resolver hands them out over a few lookups: a CDN rotates its answer set, so one
# lookup can miss the address a new connection is about to use.
outage_addrs() { # <host> <4|6>
  local i
  for i in 1 2 3; do
    { getent "ahostsv$2" "$1" 2>/dev/null || true; } | awk '{print $1}'
    if [ "$i" -lt 3 ]; then sleep 0.5; fi
  done | sort -u
}
# One probe: does a fresh HTTPS connection to the target get an answer right now, over IPv4 and, when the host has a real IPv6
# address (not a v4-mapped one), over IPv6 too? Any HTTP status counts as REACHED (a People RPC node answers a plain GET with an
# error status); only a connect failure or a timeout is not. Prints the verdict to the log; returns 0 when reached by either family.
probe_host() { # <label> <host> <has real v6: 0|1>
  local code="" fam
  for fam in 4 6; do
    [ "$fam" = 6 ] && [ "$3" != 1 ] && continue
    if code="$(curl "-$fam" -sS -m 4 -o /dev/null -w '%{http_code}' "https://$2/" 2>/dev/null)"; then
      say "outage probe ($1): $2 REACHED over IPv$fam (HTTP $code)"
      return 0
    fi
  done
  say "outage probe ($1): $2 UNREACHABLE"
  return 1
}
# THE OUTAGE MUST PROVE IT CUT SOMETHING: the target answers before, does not answer during, answers again after. Anything else
# (no answer before, an answer during, no answer after) makes this command exit non-zero, rules removed, so the bot's network
# check fails instead of reading a no-op as a pass. The rules are removed on any exit or signal (trap), so a killed run never
# leaves a host dropped.
cmd_outage() {
  setup_root
  [ $# -eq 2 ] || die "usage: outage <host> <secs>"
  command -v iptables >/dev/null || die "iptables not found"
  local ips ips6 ip real6=0 verdict=""
  ips="$(outage_addrs "$1" 4)"
  ips6="$(outage_addrs "$1" 6)"
  [ -n "$ips" ] || die "cannot resolve $1"
  if echo "$ips6" | grep -qv '^::ffff:' && [ -n "$ips6" ]; then real6=1; fi
  # the "before" probe comes first, ahead of the first rule of either family
  probe_host "before" "$1" "$real6" || verdict="the target did not answer BEFORE the outage, so a cut cannot be shown"
  trap outage_off EXIT INT TERM
  $SUDO iptables -w -N "$OUTAGE_CHAIN" 2>/dev/null || $SUDO iptables -w -F "$OUTAGE_CHAIN"
  for ip in $ips; do
    $SUDO iptables -w -A "$OUTAGE_CHAIN" -d "$ip" -j DROP
    $SUDO iptables -w -A "$OUTAGE_CHAIN" -s "$ip" -j DROP
  done
  # IPv6: Chromium takes it when the runner has a route, and an outage that leaves it open is no outage
  if [ -n "$ips6" ] && command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -N "$OUTAGE_CHAIN" 2>/dev/null || $SUDO ip6tables -w -F "$OUTAGE_CHAIN"
    for ip in $ips6; do
      $SUDO ip6tables -w -A "$OUTAGE_CHAIN" -d "$ip" -j DROP
      $SUDO ip6tables -w -A "$OUTAGE_CHAIN" -s "$ip" -j DROP
    done
    $SUDO ip6tables -w -C OUTPUT -j "$OUTAGE_CHAIN" 2>/dev/null || $SUDO ip6tables -w -I OUTPUT 1 -j "$OUTAGE_CHAIN"
    $SUDO ip6tables -w -C INPUT -j "$OUTAGE_CHAIN" 2>/dev/null || $SUDO ip6tables -w -I INPUT 1 -j "$OUTAGE_CHAIN"
  fi
  $SUDO iptables -w -C OUTPUT -j "$OUTAGE_CHAIN" 2>/dev/null || $SUDO iptables -w -I OUTPUT 1 -j "$OUTAGE_CHAIN"
  $SUDO iptables -w -C INPUT -j "$OUTAGE_CHAIN" 2>/dev/null || $SUDO iptables -w -I INPUT 1 -j "$OUTAGE_CHAIN"
  lifecycle active outage
  say "OUTAGE of $1 (v4: $(echo $ips | tr '\n' ' '); v6: $( [ -n "$ips6" ] && echo $ips6 | tr '\n' ' ' || echo none )) for $2 s, both directions"
  local rest="$2"
  if [ "$rest" -gt 3 ]; then sleep 2; rest=$(( rest - 2 )); fi
  if probe_host "during" "$1" "$real6"; then verdict="${verdict:+$verdict; }the target STILL ANSWERED during the outage: the rules cut nothing (shared or rotating address?)"; fi
  sleep "$rest"
  outage_off
  prove_chain_off "outage" "$OUTAGE_CHAIN" OUTPUT INPUT
  lifecycle restored outage
  say "outage of $1 over"
  sleep 1
  probe_host "after" "$1" "$real6" || verdict="${verdict:+$verdict; }the target did not answer again after the outage"
  trap - EXIT INT TERM
  if [ -n "$verdict" ]; then die "outage of $1 NOT PROVEN: $verdict"; fi
  say "outage of $1 proven: answered before, cut during, answered after"
}
outage_off() {
  $SUDO iptables -w -D OUTPUT -j "$OUTAGE_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -D INPUT -j "$OUTAGE_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -F "$OUTAGE_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$OUTAGE_CHAIN" 2>/dev/null || true
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -D OUTPUT -j "$OUTAGE_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -D INPUT -j "$OUTAGE_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -F "$OUTAGE_CHAIN" 2>/dev/null && $SUDO ip6tables -w -X "$OUTAGE_CHAIN" 2>/dev/null || true
  fi
}
# THE WEBRTC PATH CUT WHILE SIGNALLING STAYS UP (#245's deadlock: a link that drops while its player is still heard). UDP but
# DNS to the resolvers drops both ways, and so does every address of the relay host (TURN over TCP/TLS too); <keep-host>, the
# People RPC that carries the statement store, must answer before, DURING and after, or the cut proves nothing (a shared
# address cut with the relay would take presence down with it). The relay must answer before and after and not during.
UDPCUT_CHAIN="E2E_UDP_CUT"
cmd_udp_cut() {
  setup_root
  [ $# -eq 3 ] || die "usage: udp-cut <secs> <relay-host> <keep-host>"
  command -v iptables >/dev/null || die "iptables not found"
  local secs="$1" relay="$2" keep="$3" relays relays6 ip r verdict=""
  relays="$(outage_addrs "$relay" 4)"
  relays6="$(outage_addrs "$relay" 6)"
  [ -n "$relays" ] || die "cannot resolve $relay"
  probe_host "before" "$keep" 0 || verdict="$keep did not answer BEFORE the cut"
  probe_host "before" "$relay" 0 || verdict="${verdict:+$verdict; }$relay did not answer BEFORE the cut"
  trap udp_cut_off EXIT INT TERM
  $SUDO iptables -w -N "$UDPCUT_CHAIN" 2>/dev/null || $SUDO iptables -w -F "$UDPCUT_CHAIN"
  $SUDO iptables -w -A "$UDPCUT_CHAIN" -o lo -j ACCEPT
  $SUDO iptables -w -A "$UDPCUT_CHAIN" -i lo -j ACCEPT
  for r in $(resolvers); do
    case "$r" in *:*) continue ;; esac
    $SUDO iptables -w -A "$UDPCUT_CHAIN" -p udp -d "$r" --dport 53 -j ACCEPT
    $SUDO iptables -w -A "$UDPCUT_CHAIN" -p udp -s "$r" --sport 53 -j ACCEPT
  done
  $SUDO iptables -w -A "$UDPCUT_CHAIN" -p udp -j DROP
  for ip in $relays; do
    $SUDO iptables -w -A "$UDPCUT_CHAIN" -d "$ip" -j DROP
    $SUDO iptables -w -A "$UDPCUT_CHAIN" -s "$ip" -j DROP
  done
  $SUDO iptables -w -I OUTPUT 1 -j "$UDPCUT_CHAIN"
  $SUDO iptables -w -I INPUT 1 -j "$UDPCUT_CHAIN"
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -N "$UDPCUT_CHAIN" 2>/dev/null || $SUDO ip6tables -w -F "$UDPCUT_CHAIN"
    $SUDO ip6tables -w -A "$UDPCUT_CHAIN" -p udp ! -o lo -j DROP
    for ip in $relays6; do
      $SUDO ip6tables -w -A "$UDPCUT_CHAIN" -d "$ip" -j DROP
      $SUDO ip6tables -w -A "$UDPCUT_CHAIN" -s "$ip" -j DROP
    done
    $SUDO ip6tables -w -I OUTPUT 1 -j "$UDPCUT_CHAIN"
    $SUDO ip6tables -w -I INPUT 1 -j "$UDPCUT_CHAIN"
  fi
  lifecycle active udp-cut
  say "UDP CUT for $secs s (UDP but DNS, and $relay: $(echo $relays | tr '\n' ' ')), both directions; $keep stays up"
  local rest="$secs"
  if [ "$rest" -gt 3 ]; then sleep 2; rest=$(( rest - 2 )); fi
  probe_host "during" "$keep" 0 || verdict="${verdict:+$verdict; }$keep went UNREACHABLE during the cut: presence was cut too"
  if probe_host "during" "$relay" 0; then verdict="${verdict:+$verdict; }$relay STILL ANSWERED during the cut"; fi
  sleep "$rest"
  udp_cut_off
  prove_chain_off "udp-cut" "$UDPCUT_CHAIN" OUTPUT INPUT
  lifecycle restored udp-cut
  say "udp cut over"
  sleep 1
  probe_host "after" "$relay" 0 || verdict="${verdict:+$verdict; }$relay did not answer again after the cut"
  trap - EXIT INT TERM
  if [ -n "$verdict" ]; then die "udp cut NOT PROVEN: $verdict"; fi
  say "udp cut proven: $keep up throughout, $relay cut during and back after"
}
udp_cut_off() {
  $SUDO iptables -w -D OUTPUT -j "$UDPCUT_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -D INPUT -j "$UDPCUT_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -F "$UDPCUT_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$UDPCUT_CHAIN" 2>/dev/null || true
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -D OUTPUT -j "$UDPCUT_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -D INPUT -j "$UDPCUT_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -F "$UDPCUT_CHAIN" 2>/dev/null && $SUDO ip6tables -w -X "$UDPCUT_CHAIN" 2>/dev/null || true
  fi
}
# VIDEO BLACKHOLED ON A LINK THAT STAYS CONNECTED (rank 9 of the game logs, the media-stall heal): UDP packets of 300 bytes or
# more drop both ways, so RTP stops while the small STUN consent checks keep the connection `connected`. Proven by the rule's
# own counter: no packet dropped means no video flowed to stall, and the step fails.
STALL_CHAIN="E2E_VIDEO_STALL"
cmd_video_stall() {
  setup_root
  [ $# -eq 1 ] || die "usage: video-stall <secs>"
  command -v iptables >/dev/null || die "iptables not found"
  trap video_stall_off EXIT INT TERM
  $SUDO iptables -w -N "$STALL_CHAIN" 2>/dev/null || $SUDO iptables -w -F "$STALL_CHAIN"
  $SUDO iptables -w -A "$STALL_CHAIN" -o lo -j RETURN
  $SUDO iptables -w -A "$STALL_CHAIN" -i lo -j RETURN
  $SUDO iptables -w -A "$STALL_CHAIN" -p udp -m length --length 300:65535 -j DROP
  $SUDO iptables -w -I OUTPUT 1 -j "$STALL_CHAIN"
  $SUDO iptables -w -I INPUT 1 -j "$STALL_CHAIN"
  lifecycle active video-stall
  say "VIDEO STALL for $1 s (UDP packets of 300 bytes or more dropped, both directions)"
  sleep "$1"
  local dropped
  dropped="$($SUDO iptables -w -L "$STALL_CHAIN" -v -n -x 2>/dev/null | awk '$3 == "DROP" { n += $1 } END { print n + 0 }')"
  video_stall_off
  prove_chain_off "video-stall" "$STALL_CHAIN" OUTPUT INPUT
  lifecycle restored video-stall
  trap - EXIT INT TERM
  say "video stall over: $dropped packet(s) dropped"
  [ "$dropped" -gt 0 ] || die "video stall NOT PROVEN: no packet of 300 bytes or more was dropped (no video flowing over UDP?)"
  say "video stall proven"
}
video_stall_off() {
  $SUDO iptables -w -D OUTPUT -j "$STALL_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -D INPUT -j "$STALL_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -F "$STALL_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$STALL_CHAIN" 2>/dev/null || true
}
# THE SIGNING HOST LOSES ITS CHAIN (platform-bugs #76): one PROCESS, not the runner. The app reads the chain THROUGH the host
# (getHostProvider; the deployed bundle bakes no NEXT_PUBLIC_PEOPLE_WS), so the browser holds no socket of its own to <host> and
# a long per-process cut would be a whole-host blackout. So: kill the host's ESTABLISHED sockets to <host> (ss -K, one 4-tuple
# at a time, so the journey's own chain reader and anything else on the runner keeps its sockets), REJECT the host's NEW
# connects for <holdS> (iptables -m cgroup on OUTPUT, tcp-reset, v4 and v6; the cgroup of a socket is fixed when it is made,
# which is why the established ones must be killed), then let it connect again and watch until <windowS> whether it does.
# PROVEN = the host held a socket before, none after the kill, a connect from inside its cgroup is refused during the hold
# while one from outside gets through, and one from inside gets through after. The host's reconnect is RECORDED, not
# required: whether its follow subscription comes back is what the persona is there to find out.
HOSTCHAIN_CHAIN="E2E_HOST_CHAIN"
HOSTCHAIN_FLOW_OUT="E2E_HOST_FLOW_OUT"
HOSTCHAIN_FLOW_IN="E2E_HOST_FLOW_IN"
HOSTCHAIN_CG=""
HOSTCHAIN_PIDS=""
HOSTCHAIN_ORIG=""
HOSTCHAIN_MARKER=""
HOSTCHAIN_IPS=""
HOSTCHAIN_IPS6=""
HOSTCHAIN_ADDRS=""
HOSTCHAIN_BEFORE=""
HOSTCHAIN_OTHERS=""
HOSTCHAIN_LOGFROM=0
# the exit code of a cut proven for the host while the app's side could not be shown: neither a pass nor NOT PROVEN (die = 1)
# 64, not a small number: under set -e an unguarded failure (status 1-3 from iptables, ss, curl) must never read as INCONCLUSIVE
HOSTCHAIN_INCONCLUSIVE_EXIT=64
# established TCP sockets to the given addresses: "<pid> <local> <peer>" per line, every process (ss -tnpH)
sockets_to() { # <addrs...>
  local want=" $* "
  $SUDO ss -tnpH state established 2>/dev/null | awk -v want="$want" '{
    peer=$4; ip=peer; sub(/:[0-9]+$/, "", ip); gsub(/[\[\]]/, "", ip); sub(/^::ffff:/, "", ip)
    if (index(want, " " ip " ") == 0) next
    n=split($0, parts, "pid="); for (i=2; i<=n; i++) { split(parts[i], q, ","); proc=parts[i-1]; sub(/.*\(\("/, "", proc); sub(/".*/, "", proc); print q[1], $3, peer, proc }
  }'
}
host_sockets() { # <addrs...>  sockets of the host's pids only
  sockets_to "$@" | awk -v pids=" $(echo "$HOSTCHAIN_PIDS" | tr ',' ' ') " 'index(pids, " " $1 " ") > 0'
}
# one HTTPS connect from INSIDE the host's cgroup (a root shell moved in first, then curl): 0 = reached
probe_in_cgroup() { # <host> <cg>
  $SUDO sh -c "echo \$\$ > '$2/cgroup.procs' && exec curl -sS -m 4 -o /dev/null https://$1/" >/dev/null 2>&1
}
host_chain_rules_off() {
  $SUDO iptables -w -D OUTPUT -j "$HOSTCHAIN_FLOW_OUT" 2>/dev/null || true
  $SUDO iptables -w -D INPUT -j "$HOSTCHAIN_FLOW_IN" 2>/dev/null || true
  $SUDO iptables -w -F "$HOSTCHAIN_FLOW_OUT" 2>/dev/null && $SUDO iptables -w -X "$HOSTCHAIN_FLOW_OUT" 2>/dev/null || true
  $SUDO iptables -w -F "$HOSTCHAIN_FLOW_IN" 2>/dev/null && $SUDO iptables -w -X "$HOSTCHAIN_FLOW_IN" 2>/dev/null || true
  $SUDO iptables -w -D OUTPUT -j "$HOSTCHAIN_CHAIN" 2>/dev/null || true
  $SUDO iptables -w -F "$HOSTCHAIN_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$HOSTCHAIN_CHAIN" 2>/dev/null || true
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -D OUTPUT -j "$HOSTCHAIN_FLOW_OUT" 2>/dev/null || true
    $SUDO ip6tables -w -D INPUT -j "$HOSTCHAIN_FLOW_IN" 2>/dev/null || true
    $SUDO ip6tables -w -F "$HOSTCHAIN_FLOW_OUT" 2>/dev/null && $SUDO ip6tables -w -X "$HOSTCHAIN_FLOW_OUT" 2>/dev/null || true
    $SUDO ip6tables -w -F "$HOSTCHAIN_FLOW_IN" 2>/dev/null && $SUDO ip6tables -w -X "$HOSTCHAIN_FLOW_IN" 2>/dev/null || true
    $SUDO ip6tables -w -D OUTPUT -j "$HOSTCHAIN_CHAIN" 2>/dev/null || true
    $SUDO ip6tables -w -F "$HOSTCHAIN_CHAIN" 2>/dev/null && $SUDO ip6tables -w -X "$HOSTCHAIN_CHAIN" 2>/dev/null || true
  fi
}
prove_host_chain_rules_off() {
  prove_chain_off "host-chain cgroup" "$HOSTCHAIN_CHAIN" OUTPUT
  prove_chain_off "host-chain flow-out" "$HOSTCHAIN_FLOW_OUT" OUTPUT
  prove_chain_off "host-chain flow-in" "$HOSTCHAIN_FLOW_IN" INPUT
}
host_chain_off() {
  host_chain_rules_off
  # the host back where it came from, then the empty cgroup gone; a pid that cannot move back stays (and is said)
  local pair pid orig
  for pair in $HOSTCHAIN_ORIG; do
    pid="${pair%%=*}"; orig="${pair#*=}"
    [ -d "/proc/$pid" ] || continue
    if ! $SUDO sh -c "echo $pid > '/sys/fs/cgroup$orig/cgroup.procs'" 2>/dev/null; then say "host-chain cut: could not move pid $pid back to $orig (left in $HOSTCHAIN_CG)"; fi
  done
  if [ -n "$HOSTCHAIN_CG" ] && [ -d "$HOSTCHAIN_CG" ]; then $SUDO rmdir "$HOSTCHAIN_CG" 2>/dev/null || true; fi
  if [ -n "$HOSTCHAIN_MARKER" ]; then rm -f "$HOSTCHAIN_MARKER"; fi
  HOSTCHAIN_ORIG=""
}
# every e2e-host-chain cgroup and rule, for `clear` (a killed run's leftovers)
host_chain_clear() {
  host_chain_rules_off
  local cg pid
  for cg in /sys/fs/cgroup/e2e-host-chain-*; do
    [ -d "$cg" ] || continue
    for pid in $(cat "$cg/cgroup.procs" 2>/dev/null); do $SUDO sh -c "echo $pid > /sys/fs/cgroup/cgroup.procs" 2>/dev/null || true; done
    $SUDO rmdir "$cg" 2>/dev/null || true
  done
}
# Shared setup for both host-chain modes. The cut and hang differ only in what
# happens to the already-open flows; pid discovery, cgroup placement and the
# new-connect rule must stay identical so a fix cannot land in one mode only.
host_chain_prepare() { # <label> <host> <pid-file> <host-log> <marker>
  local label="$1" host="$2" pidfile="$3" hostlog="$4" marker="$5" pid
  command -v iptables >/dev/null || die "iptables not found"
  command -v ss >/dev/null || die "ss not found (iproute2)"
  [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = "cgroup2fs" ] || die "host-chain $label NOT PROVEN: /sys/fs/cgroup is not cgroup v2 ($(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo missing))"
  [ -s "$pidfile" ] || die "host-chain $label NOT PROVEN: no host pid in $pidfile (boot.mts writes it when the host is ready)"
  HOSTCHAIN_PIDS="$(tr -s ' \n' ',,' < "$pidfile" | sed 's/^,//; s/,$//')"
  for pid in $(echo "$HOSTCHAIN_PIDS" | tr ',' ' '); do [ -d "/proc/$pid" ] || die "host-chain $label NOT PROVEN: host pid $pid is not running"; done
  HOSTCHAIN_IPS="$(outage_addrs "$host" 4)"; HOSTCHAIN_IPS6="$(outage_addrs "$host" 6)"
  [ -n "$HOSTCHAIN_IPS" ] || die "cannot resolve $host"
  HOSTCHAIN_ADDRS="$(echo $HOSTCHAIN_IPS $HOSTCHAIN_IPS6)"
  HOSTCHAIN_LOGFROM=0; [ -n "$hostlog" ] && [ -f "$hostlog" ] && HOSTCHAIN_LOGFROM="$(stat -c %s "$hostlog")"
  HOSTCHAIN_MARKER="$marker"
  HOSTCHAIN_CG="/sys/fs/cgroup/e2e-host-chain-${HOSTCHAIN_PIDS%%,*}"
  trap host_chain_off EXIT INT TERM
  $SUDO mkdir -p "$HOSTCHAIN_CG" || die "host-chain $label NOT PROVEN: cannot create $HOSTCHAIN_CG"
  for pid in $(echo "$HOSTCHAIN_PIDS" | tr ',' ' '); do
    HOSTCHAIN_ORIG="$HOSTCHAIN_ORIG $pid=$(sed -n 's/^0:://p' "/proc/$pid/cgroup")"
    $SUDO sh -c "echo $pid > '$HOSTCHAIN_CG/cgroup.procs'" || die "host-chain $label NOT PROVEN: cannot move pid $pid into $HOSTCHAIN_CG"
  done
  # Snapshot after the move: old sockets are still found by PID, while every
  # socket created after this point inherits the new cgroup and is covered by
  # the shared cgroup rule even if it misses the exact-flow snapshot.
  HOSTCHAIN_BEFORE="$(host_sockets $HOSTCHAIN_ADDRS)"
  HOSTCHAIN_OTHERS="$(sockets_to $HOSTCHAIN_ADDRS | awk -v pids=" $(echo "$HOSTCHAIN_PIDS" | tr ',' ' ') " 'index(pids, " " $1 " ") == 0')"
}
host_chain_cgroup_rules() { # <DROP|REJECT>
  local target="$1" cgpath="${HOSTCHAIN_CG#/sys/fs/cgroup/}" ip
  $SUDO iptables -w -N "$HOSTCHAIN_CHAIN" 2>/dev/null || $SUDO iptables -w -F "$HOSTCHAIN_CHAIN"
  for ip in $HOSTCHAIN_IPS; do
    if [ "$target" = REJECT ]; then
      $SUDO iptables -w -A "$HOSTCHAIN_CHAIN" -m cgroup --path "$cgpath" -p tcp -d "$ip" -j REJECT --reject-with tcp-reset
    else
      $SUDO iptables -w -A "$HOSTCHAIN_CHAIN" -m cgroup --path "$cgpath" -p tcp -d "$ip" -j DROP
    fi || die "host-chain NOT PROVEN: iptables refused the cgroup match (no xt_cgroup on this kernel?)"
  done
  $SUDO iptables -w -I OUTPUT 1 -j "$HOSTCHAIN_CHAIN"
  if [ -n "$HOSTCHAIN_IPS6" ] && command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -N "$HOSTCHAIN_CHAIN" 2>/dev/null || $SUDO ip6tables -w -F "$HOSTCHAIN_CHAIN"
    for ip in $HOSTCHAIN_IPS6; do
      if [ "$target" = REJECT ]; then
        $SUDO ip6tables -w -A "$HOSTCHAIN_CHAIN" -m cgroup --path "$cgpath" -p tcp -d "$ip" -j REJECT --reject-with tcp-reset
      else
        $SUDO ip6tables -w -A "$HOSTCHAIN_CHAIN" -m cgroup --path "$cgpath" -p tcp -d "$ip" -j DROP
      fi || die "host-chain NOT PROVEN: ip6tables refused the cgroup match"
    done
    $SUDO ip6tables -w -I OUTPUT 1 -j "$HOSTCHAIN_CHAIN"
  fi
}
cmd_host_chain_cut() {
  setup_root
  [ $# -ge 4 ] && [ $# -le 6 ] || die "usage: host-chain-cut <windowS> <holdS> <host> <pid-file> [host-log] [in-force-marker]"
  local window="$1" hold="$2" host="$3" pidfile="$4" hostlog="${5:-}" marker="${6:-}"
  HOSTCHAIN_MARKER="$marker"
  [ "$hold" -ge 3 ] || die "host-chain cut: holdS must be at least 3 (the during probe runs 2 s in)"
  [ "$window" -ge "$hold" ] || die "host-chain cut: windowS ($window) is shorter than holdS ($hold)"
  local verdict="" started
  host_chain_prepare cut "$host" "$pidfile" "$hostlog" "$marker"
  local ips="$HOSTCHAIN_IPS" ips6="$HOSTCHAIN_IPS6" addrs="$HOSTCHAIN_ADDRS" logfrom="$HOSTCHAIN_LOGFROM" before="$HOSTCHAIN_BEFORE" others="$HOSTCHAIN_OTHERS"
  say "host-chain cut: host pid(s) $HOSTCHAIN_PIDS hold $(echo -n "$before" | grep -c . || true) socket(s) to $host ($addrs)"
  [ -n "$before" ] && echo "$before" | sed 's/^/[netem]   host  /'
  if [ -n "$others" ]; then echo "$others" | sed 's/^/[netem]   other /'; else say "host-chain cut: no other process on the runner holds a socket to $host (the app reads the chain through the host)"; fi
  [ -n "$before" ] || verdict="the host held no socket to $host BEFORE the cut, so a cut cannot be shown"
  probe_host "before" "$host" 0 || verdict="${verdict:+$verdict; }$host did not answer BEFORE the cut"
  say "host-chain cut: pid(s) $HOSTCHAIN_PIDS moved into ${HOSTCHAIN_CG#/sys/fs/cgroup/} (from$HOSTCHAIN_ORIG)"
  host_chain_cgroup_rules REJECT
  # the established ones, by their own 4-tuple: nobody else's socket to the same address is touched
  local line lport peer killed=0
  while read -r pid lport peer _; do
    [ -n "$peer" ] || continue
    if $SUDO ss -K -tn state established src "$lport" dst "$peer" >/dev/null 2>&1; then killed=$(( killed + 1 )); fi
  done <<< "$before"
  started=$(date +%s)
  [ -n "$marker" ] && date -u +%Y-%m-%dT%H:%M:%SZ > "$marker"
  sleep 1
  local after; after="$(host_sockets $addrs)"
  say "HOST-CHAIN CUT of $host for pid(s) $HOSTCHAIN_PIDS: $killed socket(s) killed (ss -K), new connects REJECTed for $hold s, watched for $window s; host sockets left: $(echo -n "$after" | grep -c . || true)"
  lifecycle active host-chain-cut
  [ -z "$after" ] || verdict="${verdict:+$verdict; }the host still held $(echo "$after" | wc -l) socket(s) after ss -K (no INET_DIAG_DESTROY?)"
  sleep 1
  if probe_in_cgroup "$host" "$HOSTCHAIN_CG"; then verdict="${verdict:+$verdict; }a connect from INSIDE the host's cgroup still reached $host during the hold"; else say "host-chain probe (during): from the host's cgroup $host UNREACHABLE"; fi
  probe_host "during, from outside the host's cgroup" "$host" 0 || verdict="${verdict:+$verdict; }$host was unreachable from OUTSIDE the host's cgroup too: the cut was not scoped to the host"
  # THE APP'S OWN CONNECTION (app=local bakes NEXT_PUBLIC_PEOPLE_WS, so the browser reads the chain itself): every browser
  # socket to <host> from before must still be established now. A deployed app has none (it reads through the host), and
  # then this says so instead of passing.
  local app_before app_kept=0 app_lost=0 app_side=""
  app_before="$(echo "$others" | awk 'tolower($4) ~ /chrom|headless/')"
  if [ -n "$app_before" ]; then
    local now; now="$(sockets_to $addrs)"
    while read -r _ lport peer _; do
      [ -n "$peer" ] || continue
      if echo "$now" | awk -v l="$lport" -v p="$peer" '$2 == l && $3 == p { f = 1 } END { exit !f }'; then app_kept=$(( app_kept + 1 )); else app_lost=$(( app_lost + 1 )); fi
    done <<< "$app_before"
    say "host-chain probe (during): the browser's own socket(s) to $host: $app_kept still established, $app_lost gone"
    [ "$app_kept" -gt 0 ] || verdict="${verdict:+$verdict; }the browser's own socket(s) to $host did not survive the cut: the app was cut too"
  else
    app_side="the browser held NO socket of its own to $host (a deployed app reads the chain through the host), so the app's reads were cut with the host's"
    say "host-chain probe (during): $app_side"
  fi
  local rest=$(( hold - ($(date +%s) - started) )); [ "$rest" -gt 0 ] && sleep "$rest"
  host_chain_rules_off
  prove_host_chain_rules_off
  lifecycle restored host-chain-cut
  say "host-chain hold over after $(( $(date +%s) - started )) s: the host may connect again"
  sleep 1
  if probe_in_cgroup "$host" "$HOSTCHAIN_CG"; then say "host-chain probe (after): from the host's cgroup $host REACHED"; else verdict="${verdict:+$verdict; }a connect from the host's cgroup did not reach $host after the hold"; fi
  local back=""
  while [ $(( $(date +%s) - started )) -lt "$window" ]; do
    if [ -z "$back" ] && [ -n "$(host_sockets $addrs)" ]; then back=$(( $(date +%s) - started )); say "host-chain cut: the host reconnected to $host $back s after the kill"; fi
    sleep 2
  done
  [ -n "$back" ] || say "host-chain cut: the host did NOT reconnect to $host within the $window s window"
  if [ -n "$hostlog" ] && [ -f "$hostlog" ]; then
    local lines; lines="$(tail -c +$(( logfrom + 1 )) "$hostlog" | grep -iE 'subscri|disconnect|clos|drop|reconnect|error|warn|block' | head -15 || true)"
    if [ -n "$lines" ]; then say "host log during the window:"; echo "$lines" | sed 's/^/[netem]   /'; else say "host log: nothing about the connection during the window (the CLI logs little at its default level)"; fi
  fi
  host_chain_off
  trap - EXIT INT TERM
  [ -n "$marker" ] && rm -f "$marker"
  if [ -n "$verdict" ]; then die "host-chain cut NOT PROVEN: $verdict"; fi
  if [ -n "$app_side" ]; then
    say "host-chain cut proven for the HOST only; the app's side is INCONCLUSIVE: $app_side (host reconnect: ${back:+after $back s}${back:-NOT within $window s})"
    exit "$HOSTCHAIN_INCONCLUSIVE_EXIT"
  fi
  say "host-chain cut proven: the host's sockets killed, its cgroup refused during the hold, the rest of the runner reached $host, the cgroup reached it again after; host reconnect: ${back:+after $back s}${back:-NOT within $window s}"
}

# THE SIGNING HOST STAYS CONNECTED BUT STOPS ANSWERING (#726): unlike host-chain-cut, this deliberately does NOT destroy the
# host's established socket. Every outbound TCP packet from the host's cgroup to the People RPC is silently DROPped, so both
# existing and new sockets hang until their own deadlines. The rest of the runner keeps reaching the RPC. This is the failure
# shape that exercises two bounded health-probe timeouts instead of an immediate disconnect/reset.
cmd_host_chain_hang() {
  setup_root
  [ $# -ge 3 ] && [ $# -le 5 ] || die "usage: host-chain-hang <holdS> <host> <pid-file> [host-log] [in-force-marker]"
  local hold="$1" host="$2" pidfile="$3" hostlog="${4:-}" marker="${5:-}"
  HOSTCHAIN_MARKER="$marker"
  [ "$hold" -ge 10 ] || die "host-chain hang: holdS must be at least 10 (two five-second probes must fit)"
  local verdict="" started
  host_chain_prepare hang "$host" "$pidfile" "$hostlog" "$marker"
  local ips="$HOSTCHAIN_IPS" ips6="$HOSTCHAIN_IPS6" addrs="$HOSTCHAIN_ADDRS" logfrom="$HOSTCHAIN_LOGFROM" before="$HOSTCHAIN_BEFORE"
  say "host-chain hang: host pid(s) $HOSTCHAIN_PIDS hold $(echo -n "$before" | grep -c . || true) established socket(s) to $host ($addrs)"
  [ -n "$before" ] && echo "$before" | sed 's/^/[netem]   host  /'
  [ -n "$before" ] || verdict="the host held no socket to $host BEFORE the hang, so an established-socket hang cannot be shown"
  probe_host "before" "$host" 0 || verdict="${verdict:+$verdict; }$host did not answer BEFORE the hang"
  host_chain_cgroup_rules DROP
  # Moving a process after connect does not reclassify an existing socket's
  # cgroup. Freeze every socket observed BEFORE the move by its exact flow in
  # both directions. These rules touch no other process, and unlike a socket
  # destroy they preserve the connection so it can resume after the hold.
  $SUDO iptables -w -N "$HOSTCHAIN_FLOW_OUT" 2>/dev/null || $SUDO iptables -w -F "$HOSTCHAIN_FLOW_OUT"
  $SUDO iptables -w -N "$HOSTCHAIN_FLOW_IN" 2>/dev/null || $SUDO iptables -w -F "$HOSTCHAIN_FLOW_IN"
  if command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -N "$HOSTCHAIN_FLOW_OUT" 2>/dev/null || $SUDO ip6tables -w -F "$HOSTCHAIN_FLOW_OUT"
    $SUDO ip6tables -w -N "$HOSTCHAIN_FLOW_IN" 2>/dev/null || $SUDO ip6tables -w -F "$HOSTCHAIN_FLOW_IN"
  fi
  local line local_ep peer_ep local_port peer_port local_ip peer_ip family flow_rules=0
  while read -r _ local_ep peer_ep _; do
    [ -n "$peer_ep" ] || continue
    local_port="${local_ep##*:}"; peer_port="${peer_ep##*:}"
    local_ip="${local_ep%:*}"; local_ip="${local_ip#[}"; local_ip="${local_ip%]}"; local_ip="${local_ip#::ffff:}"
    peer_ip="${peer_ep%:*}"; peer_ip="${peer_ip#[}"; peer_ip="${peer_ip%]}"; peer_ip="${peer_ip#::ffff:}"
    family=4; case "$peer_ip" in *:*) family=6 ;; esac
    if [ "$family" = 4 ]; then
      $SUDO iptables -w -A "$HOSTCHAIN_FLOW_OUT" -p tcp -s "$local_ip" --sport "$local_port" -d "$peer_ip" --dport "$peer_port" -j DROP
      $SUDO iptables -w -A "$HOSTCHAIN_FLOW_IN" -p tcp -s "$peer_ip" --sport "$peer_port" -d "$local_ip" --dport "$local_port" -j DROP
    elif command -v ip6tables >/dev/null; then
      $SUDO ip6tables -w -A "$HOSTCHAIN_FLOW_OUT" -p tcp -s "$local_ip" --sport "$local_port" -d "$peer_ip" --dport "$peer_port" -j DROP
      $SUDO ip6tables -w -A "$HOSTCHAIN_FLOW_IN" -p tcp -s "$peer_ip" --sport "$peer_port" -d "$local_ip" --dport "$local_port" -j DROP
    fi
    flow_rules=$(( flow_rules + 1 ))
  done <<< "$before"
  [ "$flow_rules" -gt 0 ] || verdict="${verdict:+$verdict; }no established flow was available to freeze"
  $SUDO iptables -w -I OUTPUT 1 -j "$HOSTCHAIN_FLOW_OUT"
  $SUDO iptables -w -I INPUT 1 -j "$HOSTCHAIN_FLOW_IN"
  if [ -n "$ips6" ] && command -v ip6tables >/dev/null; then
    $SUDO ip6tables -w -I OUTPUT 1 -j "$HOSTCHAIN_FLOW_OUT"
    $SUDO ip6tables -w -I INPUT 1 -j "$HOSTCHAIN_FLOW_IN"
  fi
  started=$(date +%s)
  [ -n "$marker" ] && date -u +%Y-%m-%dT%H:%M:%SZ > "$marker"
  sleep 1
  local after; after="$(host_sockets $addrs)"
  say "HOST-CHAIN HANG of $host for pid(s) $HOSTCHAIN_PIDS: all cgroup traffic DROPped for $hold s; no socket was killed; host sockets still established: $(echo -n "$after" | grep -c . || true)"
  lifecycle active host-chain-hang
  [ -n "$after" ] || verdict="${verdict:+$verdict; }the established host socket vanished immediately even though the harness did not close it"
  if probe_in_cgroup "$host" "$HOSTCHAIN_CG"; then verdict="${verdict:+$verdict; }a connect from INSIDE the host's cgroup still reached $host during the hang"; else say "host-chain probe (during hang): from the host's cgroup $host TIMED OUT"; fi
  probe_host "during hang, from outside the host's cgroup" "$host" 0 || verdict="${verdict:+$verdict; }$host was unreachable from OUTSIDE the host's cgroup too: the hang was not scoped to the host"
  # Prefer traffic from the established host flow. An idle waiting-room host
  # is still provable because the forced in-cgroup connect above must hit the
  # DROP rule and its packets are counted separately.
  local proof_wait=$(( hold > 25 ? 25 : hold - 2 )); [ "$proof_wait" -gt 0 ] && sleep "$proof_wait"
  local flow_packets flow_packets6=0 cgroup_packets cgroup_packets6=0
  flow_packets="$($SUDO iptables -w -L "$HOSTCHAIN_FLOW_OUT" -v -n -x 2>/dev/null | awk 'NR > 2 { n += $1 } END { print n + 0 }')"
  cgroup_packets="$($SUDO iptables -w -L "$HOSTCHAIN_CHAIN" -v -n -x 2>/dev/null | awk '$3 == "DROP" { n += $1 } END { print n + 0 }')"
  if command -v ip6tables >/dev/null; then flow_packets6="$($SUDO ip6tables -w -L "$HOSTCHAIN_FLOW_OUT" -v -n -x 2>/dev/null | awk 'NR > 2 { n += $1 } END { print n + 0 }')"; fi
  if command -v ip6tables >/dev/null; then cgroup_packets6="$($SUDO ip6tables -w -L "$HOSTCHAIN_CHAIN" -v -n -x 2>/dev/null | awk '$3 == "DROP" { n += $1 } END { print n + 0 }')"; fi
  flow_packets=$(( flow_packets + flow_packets6 ))
  cgroup_packets=$(( cgroup_packets + cgroup_packets6 ))
  if [ "$flow_packets" -gt 0 ]; then
    say "host-chain hang proof: $flow_packets packet(s) from the established host flow were DROPped"
  elif [ "$cgroup_packets" -gt 0 ]; then
    # A waiting-room host can be idle for the whole window. The forced HTTPS
    # connect above runs inside its cgroup; its counted DROP proves the hang is
    # active without pretending the quiet established socket sent traffic.
    say "host-chain hang proof: established flow idle; forced cgroup connect had $cgroup_packets packet(s) DROPped"
  else
    verdict="${verdict:+$verdict; }neither the established flow nor the forced cgroup connect matched a DROP rule during the proof window"
  fi
  local rest=$(( hold - ($(date +%s) - started) )); [ "$rest" -gt 0 ] && sleep "$rest"
  host_chain_rules_off
  prove_host_chain_rules_off
  lifecycle restored host-chain-hang
  say "host-chain hang lifted after $(( $(date +%s) - started )) s: the host's existing socket may resume"
  sleep 1
  if probe_in_cgroup "$host" "$HOSTCHAIN_CG"; then say "host-chain probe (after hang): from the host's cgroup $host REACHED"; else verdict="${verdict:+$verdict; }a connect from the host's cgroup did not reach $host after the hang"; fi
  if [ -n "$hostlog" ] && [ -f "$hostlog" ]; then
    local lines; lines="$(tail -c +$(( logfrom + 1 )) "$hostlog" | grep -iE 'subscri|disconnect|clos|drop|reconnect|error|warn|block|timeout' | head -15 || true)"
    if [ -n "$lines" ]; then say "host log during the hang:"; echo "$lines" | sed 's/^/[netem]   /'; else say "host log: nothing about the connection during the hang (the CLI logs little at its default level)"; fi
  fi
  host_chain_off
  trap - EXIT INT TERM
  [ -n "$marker" ] && rm -f "$marker"
  [ -z "$verdict" ] || die "host-chain hang NOT PROVEN: $verdict"
  say "host-chain hang proven: established sockets were left open, all host-cgroup traffic timed out, the rest of the runner reached $host, and the cgroup reached it again after"
}

cmd_clear() {
  setup_root
  local dev
  dev="$(egress_if)"
  if $SUDO tc qdisc del dev "$dev" root 2>/dev/null; then say "$dev: qdisc removed"; else say "$dev: no qdisc to remove"; fi
  rm -f "$STATE_FILE" "$ARGS_FILE" "$STATE_FILE.dev"
  if $SUDO iptables -w -C OUTPUT -p udp -j "$UDP_CHAIN" 2>/dev/null; then
    $SUDO iptables -w -D OUTPUT -p udp -j "$UDP_CHAIN"
    say "UDP block removed from OUTPUT"
  fi
  $SUDO iptables -w -F "$UDP_CHAIN" 2>/dev/null && $SUDO iptables -w -X "$UDP_CHAIN" 2>/dev/null || true
  command -v ip6tables >/dev/null && $SUDO ip6tables -w -D OUTPUT -p udp ! -o lo -j DROP 2>/dev/null || true
  outage_off
  udp_cut_off
  video_stall_off
  blackout_off
  host_chain_clear
  require_netem_absent "$dev" "clear"
  if command -v ip6tables >/dev/null; then
    require_hook_absent ip6tables "IPv6 UDP block" OUTPUT -p udp ! -o lo -j DROP
  fi
  prove_chain_off "outage" "$OUTAGE_CHAIN" OUTPUT INPUT
  prove_chain_off "udp-cut" "$UDPCUT_CHAIN" OUTPUT INPUT
  prove_chain_off "video-stall" "$STALL_CHAIN" OUTPUT INPUT
  prove_chain_off "blackout" "$BLACKOUT_CHAIN" OUTPUT INPUT
  prove_host_chain_rules_off
  say "cleared"
  lifecycle restored clear
}

cmd_show() {
  setup_root
  local dev
  dev="$(egress_if)"
  say "egress interface: $dev; profile: $( [ -f "$STATE_FILE" ] && cat "$STATE_FILE" || echo none )"
  $SUDO tc qdisc show dev "$dev"
  $SUDO iptables -w -S "$UDP_CHAIN" 2>/dev/null || say "no UDP block"
}

case "${1:-}" in
  apply) shift; cmd_apply "$@" ;;
  swap) shift; cmd_swap "$@" ;;
  blackout) shift; cmd_blackout "$@" ;;
  outage) shift; cmd_outage "$@" ;;
  host-chain-cut) shift; cmd_host_chain_cut "$@" ;;
  host-chain-hang) shift; cmd_host_chain_hang "$@" ;;
  udp-cut) shift; cmd_udp_cut "$@" ;;
  video-stall) shift; cmd_video_stall "$@" ;;
  custom) shift; cmd_custom "$@" ;;
  spike) shift; cmd_spike "$@" ;;
  custom-args) shift; custom_args "$@" ;;
  block-udp) cmd_block_udp ;;
  allow-udp) cmd_allow_udp ;;
  clear) cmd_clear ;;
  show) cmd_show ;;
  stats) shift; cmd_stats "$@" ;;
  profile-args) shift; [ $# -eq 1 ] || die "usage: profile-args <profile>"; profile_args "$1" ;;
  *) die "usage: netem.sh apply|swap <profile> | outage <host> <secs> | host-chain-cut <windowS> <holdS> <host> <pid-file> [host-log] [marker] | udp-cut <secs> <relay-host> <keep-host> | video-stall <secs> | custom <d> <j> <l> <r> | spike <s> <d> <j> <l> <r> | blackout <secs> | block-udp | allow-udp | clear | show | stats <label> | profile-args <profile>" ;;
esac
