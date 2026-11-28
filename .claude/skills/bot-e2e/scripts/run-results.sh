#!/bin/bash
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

# One line per bot for an e2e-live run: result, minutes on the runner, and the
# FAIL / INCONCLUSIVE / GUARD FAIL lines from its journey log.
# Usage: run-results.sh <run id>
set -u
R=${E2E_REPO:-paritytech/individuality-apps}; RUN=${1:?run id}
gh run view "$RUN" --repo "$R" --json conclusion,url -q '"run \(.url): \(.conclusion)"'
gh run view "$RUN" --repo "$R" --json jobs -q '.jobs[]|"\(.databaseId)\t\(.name)\t\(.conclusion)\t\(.startedAt)\t\(.completedAt)"' |
while IFS=$'\t' read -r id name concl start end; do
  mins=""
  if [ -n "$start" ] && [ -n "$end" ] && [ "$end" != null ]; then
    s=$(date -j -u -f %Y-%m-%dT%H:%M:%SZ "$start" +%s 2>/dev/null || date -u -d "$start" +%s)
    e=$(date -j -u -f %Y-%m-%dT%H:%M:%SZ "$end" +%s 2>/dev/null || date -u -d "$end" +%s)
    mins=$(awk "BEGIN{printf \"%.1f min\", ($e-$s)/60}")
  fi
  printf '%-8s %-9s %s\n' "$concl" "$mins" "$name"
  case $name in play*) ;; *) continue ;; esac
  [ "$concl" = success ] && continue
  gh run view --repo "$R" --job "$id" --log 2>/dev/null |
    awk -F'\t' 'index($2,"Boot and run")==1{sub(/^[^ ]* /,"",$3); print $3}' |
    grep -E '^\s*(FAIL|INCONCLUSIVE)|GUARD FAIL|never reached' | grep -v '^\s*[+-] ' | cut -c1-220 | head -5 | sed 's/^/           /'
done
