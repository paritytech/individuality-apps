#!/bin/bash
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

# Play every scheduled game with the live-E2E bots, one e2e-live run per game.
# PREVIEWNET (the default network) currently schedules a game every 20 min on its own
# (chain XX:00, XX:20 and XX:40). This is documentation only: the probe derives every
# target and wait from chain state. The loop NEVER runs out there: --max stops it.
# On paseo-next-v2 a person schedules the games in the sudo app, and the loop stops
# when none is left.
#
# After each run ends, wait --delay seconds, then dispatch the next run. The probe in
# that run finds the next game in Registration and sleeps until the bots are due
# (about T-12.5 min, scripts/e2e-live/timing.ts), so the delay only shortens the
# probe's own idle wait. When a run's probe found no game to join (no play job ran),
# the loop stops. It never cancels a run.
#
# Usage:
#   game-loop.sh [--after <run id>] [--bots rotate|all|core|<n>|'<json list>'] [--roles true|false]
#                [--network previewnet|paseo-next-v2] [--app <dotNS name>] [--delay <s>] [--max <runs>] [--ref <branch>] [--sleep-mac]
#   --network   the chain (default previewnet); the app, identity pool and boot identity follow it.
#               --app must be on that network (a .testnet name on previewnet, .paseo on paseo-next-v2).
#   --after     wait for this run to finish before the first dispatch (default: dispatch now)
#   --ref       the branch whose e2e-live.yml runs (default main; a PR branch to measure
#               a harness or runner change against real games before merging it)
#   --sleep-mac when no game is left: kill caffeinate -dimsu and put this Mac to sleep
#               (after a 10 min grace; touch <this dir>/keep-awake to skip it)
# Stop early: touch <this dir>/game-loop.stop (checked between runs).
set -u
R=${E2E_REPO:-paritytech/individuality-apps}
D=$(cd "${0%/*}" && pwd)
after="" bots=rotate roles=true app="" network=previewnet delay="" max=24 ref=main sleepmac=0
while [ $# -gt 0 ]; do
  case $1 in
    --after) after=$2; shift 2 ;;
    --bots) bots=$2; shift 2 ;;
    --roles) roles=$2; shift 2 ;;
    --app) app=$2; shift 2 ;;
    --network) network=$2; shift 2 ;;
    --delay) delay=$2; shift 2 ;;
    --max) max=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --sleep-mac) sleepmac=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
# previewnet's 600 s report window ends a run about 13 min after kickoff, so its next game's sign-up budget is
# already close: dispatch at once (the probe sleeps until the bots are due anyway). paseo keeps the old 6 min.
[ -z "$delay" ] && { [ "$network" = previewnet ] && delay=30 || delay=360; }
log() { echo "$(date '+%H:%M %Z') $*"; }

dispatch() {
  local t; t=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local args=(-f "bots=$bots" -f "roles=$roles" -f "network=$network"); [ -n "$app" ] && args+=(-f "app=$app")
  # stdout to /dev/null: gh 2.8x prints the run URL there, and this function's
  # stdout IS the run id the loop polls (a two-line id polled forever, 5 Oct)
  gh workflow run e2e-live.yml --repo "$R" --ref "$ref" "${args[@]}" >/dev/null || return 1
  sleep 10
  gh run list --repo "$R" --workflow e2e-live.yml --event workflow_dispatch --limit 5 \
    --json databaseId,createdAt -q "[.[]|select(.createdAt>=\"$t\")]|last|.databaseId"
}

cur=$after n=0
while [ "$n" -lt "$max" ]; do
  if [ -n "$cur" ]; then
    until [ "$(gh run view "$cur" --repo "$R" --json status -q .status 2>/dev/null)" = completed ]; do sleep 30; done
    played=$(gh run view "$cur" --repo "$R" --json jobs -q '[.jobs[]|select((.name|startswith("play")) and .conclusion!="skipped")]|length')
    log "run $cur: $(gh run view "$cur" --repo "$R" --json conclusion -q .conclusion), bots that played: $played"
    if [ "$played" = 0 ]; then
      # Stop only on the probe's explicit no-game reason (decide.ts). Any other skip (already played, too late to
      # sign up, a failed probe) just moves on to the next game: previewnet never runs out of games.
      pj=$(gh run view "$cur" --repo "$R" --json jobs -q '.jobs[]|select(.name=="probe")|.databaseId')
      if ! gh api "repos/$R/actions/jobs/$pj/logs" 2>/dev/null | grep -q "no scheduled game has a registration still to join"; then
        log "run $cur played no bot, but the probe did not say no game is left: next game"
        [ -f "$D/game-loop.stop" ] && { log "stop file, exiting"; exit 0; }
        sleep 60
        cur=$(dispatch) || { log "dispatch failed, retrying in 60 s"; sleep 60; cur=""; continue; }
        log "dispatched $cur (network=$network bots=$bots roles=$roles${app:+ app=$app})"; n=$((n+1))
        sleep 120
        continue
      fi
      log "NO-GAME: the probe found no game to join; the loop stops"
      if [ "$sleepmac" = 1 ]; then
        sleep 600
        if [ -f "$D/keep-awake" ]; then log "keep-awake present, not sleeping"; exit 0; fi
        log "killing caffeinate -dimsu and sleeping the Mac"
        pkill -f 'caffeinate -dimsu'; sleep 2; pmset sleepnow
      fi
      exit 0
    fi
    [ -f "$D/game-loop.stop" ] && { log "stop file, exiting"; exit 0; }
    sleep "$delay"
  fi
  cur=$(dispatch) || { log "dispatch failed, retrying in 60 s"; sleep 60; continue; }
  log "dispatched $cur (network=$network bots=$bots roles=$roles${app:+ app=$app})"; n=$((n+1))
  sleep 600
done
log "reached --max $max runs"
