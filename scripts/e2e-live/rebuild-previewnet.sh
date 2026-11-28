#!/usr/bin/env bash
# Copyright 2026 Parity Technologies (UK) Ltd.
# SPDX-License-Identifier: GPL-3.0-or-later

# Rebuild every PreviewNet bot identity after a chain reset, then repoint the repo at the new names.
#   scripts/e2e-live/rebuild-previewnet.sh [--regular 50] [--fresh 3] [--repo owner/name] [--dry-run] [--from <step>]
# Steps (resumable; each finished step leaves a marker in $WORK, re-run the same command to continue):
#   reset    delete the PreviewNet pool/boot/fresh secrets and variables
#   boot     mint the boot identity, set E2E_BOOT_*, keep it out of the pool, park its slot
#   personas rebuild the dedicated personas from persona-bootstrap.json (re-mint any that clash with a paseo name)
#   pool     mint regular bots until the pool holds --regular of them
#   fresh    mint the fresh-seat pool (check-seat-preparing)
#   remap    rewrite profiles.json, the crew catalogue, tests and the crew doc to the new names; run the checks
# Paseo secrets and variables are never touched. Commit and PR the result yourself (a branch off a fresh origin/main).
set -euo pipefail

REGULAR=50; FRESH_N=3; REPO="${GITHUB_REPOSITORY:-paritytech/individuality-apps}"; DRY=0; FROM=reset
while [ $# -gt 0 ]; do
  case "$1" in
    --regular) REGULAR=$2; shift 2 ;;
    --fresh) FRESH_N=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --from) FROM=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

NET=previewnet
ROOT=$(git rev-parse --show-toplevel)
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
BOOT_SLOTS=${BOOT_SLOTS:-$MAIN/.truapi-host-boot-$NET}
WORK=${WORK:-$HOME/.cache/previewnet-sync/rebuild-$(date +%Y%m%d)}
STATE_ROOT=$ROOT/.truapi-host/persona-bootstrap
POOL_VAR=E2E_IDENTITIES_PREVIEWNET; POOL_SECRET=E2E_POOL_PREVIEWNET
FRESH_VAR=E2E_FRESH_IDENTITIES_PREVIEWNET; FRESH_SECRET=E2E_FRESH_POOL_PREVIEWNET
BOOT_VAR=E2E_BOOT_USER_PREVIEWNET; BOOT_SECRET=E2E_BOOT_MNEMONIC_PREVIEWNET
cd "$ROOT"; mkdir -p "$WORK"
log() { echo "[$(date +%H:%M:%S)] $*"; }
run() { if [ "$DRY" = 1 ]; then echo "DRY: $*"; else "$@"; fi; }
mint() { run npx tsx scripts/e2e-live/new-identity.mts --repo "$REPO" "$@"; }
varkeys() { gh variable get "$1" --repo "$REPO" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Object.keys(JSON.parse(s)).join("\n"))}catch{}})'; }
count_prefix() { varkeys "$POOL_VAR" | grep -c "^$1\." || true; }
done_marker() { echo "$WORK/done.$1"; }
order=(reset boot personas pool fresh remap)
started=0
step() { # step <name> : true when this step should run now
  [ "$1" = "$FROM" ] && started=1
  [ "$started" = 1 ] || return 1
  [ -e "$(done_marker "$1")" ] && { log "skip $1 (done)"; return 1; }
  log "== $1"; return 0
}
finish() { [ "$DRY" = 1 ] || touch "$(done_marker "$1")"; }

# Preflight: never write to the wrong repo (it must hold the e2e-live workflows).
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in" >&2; exit 1; }
gh api "repos/$REPO/actions/workflows" --jq '.workflows[].path' | grep -q 'e2e-live.yml' || { echo "$REPO has no e2e-live.yml; pass --repo explicitly" >&2; exit 1; }
node -e 'process.exit(require("./scripts/e2e-live/persona-bootstrap.json").personas.length?0:1)'
OLD=$(NETWORK=$NET npx tsx scripts/e2e-live/remap-identities.mts --list)
echo "$OLD" > "$WORK/old-names.json"
NEEDED=$(node -e 'const o=require(process.argv[1]);console.log(o.length)' "$WORK/old-names.json")
log "repo $REPO, $NEEDED previewnet names in profiles.json, regular pool target $REGULAR, work dir $WORK"
[ "$REGULAR" -ge "$NEEDED" ] || { echo "--regular $REGULAR is below the $NEEDED names the profiles use" >&2; exit 1; }

if step reset; then
  for s in $POOL_SECRET $BOOT_SECRET $FRESH_SECRET; do run gh secret delete "$s" --repo "$REPO" || true; done
  for v in $POOL_VAR $FRESH_VAR $BOOT_VAR; do run gh variable delete "$v" --repo "$REPO" || true; done
  finish reset
fi

if step boot; then
  mint --count 1 --base jollityboot
  BOOT=$(varkeys "$POOL_VAR" | grep '^jollityboot\.' | head -1 || true)
  [ "$DRY" = 1 ] && BOOT=jollityboot.00
  [ -n "$BOOT" ] || { echo "no boot identity minted" >&2; exit 1; }
  ACC=$(find ".truapi-host/$BOOT" -name accounts.json 2>/dev/null | head -1 || true)
  if [ "$DRY" = 1 ]; then echo "DRY: set $BOOT_SECRET from $ACC and $BOOT_VAR=$BOOT"; else
    node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=(Array.isArray(a)?a:a.accounts||[]).find(x=>x.lite_username&&x.mnemonic);if(!x||x.lite_username!==process.argv[2])process.exit(3);process.stdout.write(x.mnemonic)' "$ACC" "$BOOT" | gh secret set "$BOOT_SECRET" --repo "$REPO"
    gh variable set "$BOOT_VAR" --repo "$REPO" --body "$BOOT"
    mkdir -p "$BOOT_SLOTS"; mv ".truapi-host/$BOOT" "$BOOT_SLOTS/"
  fi
  # the boot identity is not a pool member: empty the pool again so the "pool member without a slot" guard stays quiet
  run gh secret delete "$POOL_SECRET" --repo "$REPO" || true
  run gh variable delete "$POOL_VAR" --repo "$REPO" || true
  finish boot
fi

if step personas; then
  PERSONAS=$(node -e 'console.log(require("./scripts/e2e-live/persona-bootstrap.json").personas.map(p=>p.profile+":"+p.base).join(" "))')
  rebuild() { run npx tsx scripts/e2e-live/bootstrap-personas.mts --apply --network "$NET" --rebuild "$1" --repo "$REPO" --state-root "$STATE_ROOT"; }
  for pb in $PERSONAS; do
    profile=${pb%%:*}; base=${pb##*:}
    for attempt in 1 2 3 4; do
      rebuild "$profile"
      [ "$DRY" = 1 ] && break
      new=$(varkeys "$POOL_VAR" | grep "^$base\." | tail -1 || true)
      echo "[\"$new\"]" > "$WORK/one.json"
      NETWORK=$NET npx tsx scripts/e2e-live/remap-identities.mts --paseo-clash "$WORK/one.json" >/dev/null && break
      log "$new clashes with a paseo name; re-minting $profile ($attempt)"
    done
  done
  finish personas
fi

if step pool; then
  fails=0
  while [ "$DRY" = 1 ] || [ "$(count_prefix jollitypv)" -lt "$REGULAR" ]; do
    log "regular bots $(count_prefix jollitypv)/$REGULAR"
    if mint --count 1 --base jollitypv; then fails=0; else fails=$((fails+1)); [ $fails -lt 3 ] || { echo "3 mints failed in a row" >&2; exit 1; }; fi
    [ "$DRY" = 1 ] && break
  done
  finish pool
fi

if step fresh; then
  fails=0
  while [ "$DRY" = 1 ] || [ "$(varkeys "$FRESH_VAR" | grep -c . || true)" -lt "$FRESH_N" ]; do
    if mint --fresh --count 1; then fails=0; else fails=$((fails+1)); [ $fails -lt 3 ] || { echo "3 fresh mints failed in a row" >&2; exit 1; }; fi
    [ "$DRY" = 1 ] && break
  done
  finish fresh
fi

if step remap; then
  if [ "$DRY" = 1 ]; then echo "DRY: remap-identities.mts --apply, crew-doc, vitest, typecheck"; else
    node -e '
      const {execFileSync}=require("child_process");
      const keys=JSON.parse(execFileSync("gh",["variable","get",process.argv[1],"--repo",process.argv[2]],{encoding:"utf8"}));
      const bases=require("./scripts/e2e-live/persona-bootstrap.json").personas.map(p=>p.base);
      const names=Object.keys(keys),personas={},regular=[];
      for(const n of names){const b=n.split(".")[0];if(bases.includes(b))personas[b]=n;else if(b==="jollitypv")regular.push(n)}
      require("fs").writeFileSync(process.argv[3],JSON.stringify({regular,personas},null,1))' "$POOL_VAR" "$REPO" "$WORK/new-names.json"
    NETWORK=$NET npx tsx scripts/e2e-live/remap-identities.mts --apply "$WORK/new-names.json" | tee "$WORK/remap-result.json" | head -60
    npm run e2e-live:crew-doc
    npx vitest run scripts/e2e-live 2>&1 | tail -6
    npm run typecheck:e2e-live 2>&1 | tail -3
    git checkout -- package-lock.json 2>/dev/null || true
    log "now: commit on a branch off a fresh origin/main, open the PR, merge it, then run a boot-only dispatch to prove the boot identity"
  fi
  finish remap
fi
log "rebuild done"
