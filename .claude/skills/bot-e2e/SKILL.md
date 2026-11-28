---
name: bot-e2e
description: Run the DIM2 live E2E with bots against real previewnet (default) or paseo games, and read the results. Use when someone wants bots to play a scheduled game, a chosen set of bot profiles to run, a new profile proven without joining a game, every game of a session covered automatically, a bot run's results explained, or the bot identities rebuilt after a PreviewNet reset.
---

# Bots playing real DIM2 games

The live E2E plays real games with bots on **previewnet** (the default) or **paseo-next-v2**. Each bot runs as a real lite
person inside a real truapi host; compatible bots may share one physical GitHub
runner while remaining isolated logical slots. It loads the deployed
app by its dotNS name, signs up, plays every turn, files its report on chain,
and is checked against what the chain recorded.

Every bot is the same program with two inputs:
- **an identity**, the lite person it plays as;
- **a profile**, its device, network, clock and behaviour.

Profiles live in **scripts/e2e-live/profiles.json**.

**The harness itself** is documented in **scripts/e2e-live/** (start with the
header of **e2e-live.yml** and **timing.ts**), and the clock rules it tests in
**docs/time-and-clocks.md**. This skill is how to drive it.

## Rules (read before dispatching anything)

- **Nightly plus ad-hoc.** The complete PreviewNet catalogue starts every night at **03:17 Europe/Zurich**. There is no reserved time window. Ordinary PreviewNet game dispatches are refused only while a complete suite is queued or in progress, so they cannot compete for a game or identity. Before a run, check the board for an active HOLD and `gh run list --workflow e2e-live-nightly.yml --status in_progress` (and `--status queued`); when both are clear, dispatch a one-off run whenever someone asks. Do not start the continuous game loop unless the person explicitly asks for continuous play.
- **Bots play on previewnet unless told otherwise.** Never dispatch a paseo game run (network paseo-next-v2) or start a paseo loop unless the person explicitly asks for paseo. Every default here (workflow input, game loop, PR runs) is previewnet.
- **Never cancel a game run.** A run that looks stuck is usually sleeping until its game. Cancelling loses that game's evidence, and the game itself goes ahead without bots.
- **Previewnet currently runs a game every 20 minutes on its own**, at chain time XX:00, XX:20 and XX:40 (about two minutes later by wall clock). Treat this as operational information, not a timer: every wait and target comes from chain state. No one schedules anything there, so there is always a next game: a loop never runs out, and **--max** is what stops it.
- **Paseo games are scheduled by a person** in the sudo app (sudo.personhood.dev/game, Paseo NextV2). Nothing here schedules games.
- **Identities are per chain.** Previewnet's pool is the repo variable **E2E_IDENTITIES_PREVIEWNET**, paseo's is **E2E_IDENTITIES**; both use the E2E_ID_<USERNAME> secrets. A profile names its person per network in profiles.json (`"identity": {"previewnet": "...", "paseo-next-v2": "..."}`; a plain string means paseo). The boot identity is E2E_BOOT_MNEMONIC_PREVIEWNET + E2E_BOOT_USER_PREVIEWNET on previewnet. **Previewnet resets wipe only Previewnet people and its pool; Paseo identities and secrets persist.** After a reset run **scripts/e2e-live/rebuild-previewnet.sh** (resumable; `--dry-run` first): it rebuilds the boot identity, personas, pool and fresh pool, then repoints profiles.json, the crew catalogue, tests and doc at the new names. Rebuild only the catalogue's dedicated personas with the read-only-by-default `npx tsx scripts/e2e-live/bootstrap-personas.mts`, following **docs-internal/e2e-persona-bootstrap.md**.
- **One game run at a time per network.** All game runs on one network share one concurrency group (previewnet and paseo each have their own, so they can run side by side), so a second dispatch queues behind the running one. A queued run picks the NEXT game when it starts. Two dispatches for one game therefore make the second play the following game. Boot-only runs and PR runs have their own groups and never block a game.
- **Dispatch once per game, any time after the previous game ends.** The probe sleeps on one runner until the bots are due. The bots then start about 12.5 minutes before kickoff, and tap Register about 4 minutes before registration closes.
- **Every wait comes from the game's chain times**, never a fixed duration. If you change the harness, keep it that way.
- **Never print a mnemonic.** Each runner gets only its own identity's secret. New identities are made with **scripts/e2e-live/new-identity.mts**, which never prints one.
- **Capacity and cost:** the probe prints the selected logical-bot and physical-runner-group counts for each dispatch. Do not estimate a current **all** run from an old fixed persona count: the catalogue and grouping plan are the authority. Bots use Parity's internal spot VMs; the probe and gather stay on ubuntu-latest. A preempted runner has no artifact; gather then fails the run and the game is not marked played, so the next dispatch can replay it if registration is still open.

## Run the bots for one game

```
gh workflow run e2e-live.yml --ref main -f bots=rotate -f roles=true
```

The inputs:

| Input | Values |
|---|---|
| bots | **rotate** (default: fixed regression profiles plus alternating halves of the rest, advancing only after a run decides to play), **all** (every proven profile), **core** (the six core profiles), a number, or a JSON list of profile names |
| roles | **true** to act out each profile's behaviour (kill, freeze, reload, clock jumps, late join...). Off by default |
| network | **previewnet** (default) or **paseo-next-v2**. It picks the chain, the dotNS endpoints, the identity pool and the boot identity |
| app | empty (default) = the network's own: **dim2.testnet** on previewnet, **dim2next.paseo** (what main deployed) on paseo. Also **dim2.paseo** (the paseo release), **dim2-pr<N>-sandbox00.testnet** (a previewnet PR preview; it is compiled as dim2.testnet, so also pass app_product **dim2.testnet**) or **dim2-pr<N>-sandbox00.paseo** (a paseo PR preview). The TLD must match the network or the run fails at once |
| boot_only | **true** boots and checks one bot without joining a game, on the separate boot identity |
| boot_profile | the profile for that boot-only bot |
| telemetry | **true** sends the bots' telemetry to Sentry with test.tag e2e-bot. Off by default; telemetry torture profiles opt themselves in |

A PR preview may not exist: since #924 a PR deploys one only when its deployed sources change, and paseo only on request. Before dispatching a live game against a PR, add the **deploy-preview** label (or **deploy-paseo** for paseo) and wait for its Deploy run; otherwise the probe fails at once with "PR <N> has no preview on <network>".

A paseo game (a person must have scheduled it):

```
gh workflow run e2e-live.yml --ref main -f network=paseo-next-v2 -f bots=all -f roles=true
```

A chosen set of bots:

```
gh workflow run e2e-live.yml --ref main -f roles=true \
  -f bots='["clock-jumps","clock-wrong-then-corrected","visible-freeze"]'
```

A list must name each profile once, with no two profiles sharing an
identity. Profiles that are pending, unknown names, and identities missing from
the chosen network's pool are refused before any runner starts.

## Run the complete PreviewNet crew by hand

The scheduled workflow covers all runnable catalogue profiles in serial identity-safe waves. A manual complete suite uses the same path only after the ordinary dispatcher has been stopped and every ordinary PreviewNet run is idle:

```
gh workflow run e2e-live-nightly.yml --ref main -f reserved_window_confirmed=true
```

Both scheduled and manual suites retain every wave's evidence for 14 days and continue to later waves after an earlier product or infrastructure failure. Never dispatch an ordinary PreviewNet game until the suite reaches a terminal result.

## Cover every game of a session

Only when someone explicitly asks for continuous play.

**scripts/game-loop.sh** dispatches once per game, until a run's probe finds no game left (on previewnet that never happens, so pass **--max**):

```
.claude/skills/bot-e2e/scripts/game-loop.sh                 # dispatch now, then once per game
.claude/skills/bot-e2e/scripts/game-loop.sh --after <run>   # a run is already going: start after it
.claude/skills/bot-e2e/scripts/game-loop.sh --bots core --roles true --max 4
.claude/skills/bot-e2e/scripts/game-loop.sh --network paseo-next-v2 --max 4   # paseo, games a person scheduled
```

- It waits **--delay** seconds (default 360) after each run ends, then dispatches the next one.
- **--ref <branch>** runs that branch's e2e-live.yml instead of main, to measure a harness or runner change against real games before merging it.
- **--network** (default previewnet) is passed to every dispatch; **--app** must be on that network.
- It stops by itself when the probe reports "no scheduled game has a registration still to join" (paseo only) or at **--max** runs (the default is 24, about 8 hours of previewnet at the current cadence).
- **--sleep-mac** also kills caffeinate -dimsu and puts the Mac to sleep once no game is left, after a 10-minute grace. Touch **keep-awake** in the scripts folder to skip it.
- Touch **game-loop.stop** in the same folder to stop between runs.

**Claude: run the loop as a background command and read its log when it notifies you.** Check the chain before you start it (previewnet currently targets the next XX:00, XX:20 or XX:40 chain time). If a run is already in progress, pass it as **--after**. Otherwise the loop's first dispatch queues behind it and plays the game after.

## Read a run

```
.claude/skills/bot-e2e/scripts/run-results.sh <run id>
```

It prints one line per job: the result, the minutes on the runner, and the failing check lines for each bot that did not pass.

What the parts of a run mean:
- **probe** decides which game the run plays and when the bots are due. Its log says "decision": "play" or "skip", with the reason.
- **play (bot N, profile)** is one bot. Its "Boot and run the journey" step prints every check: PASS, FAIL, INCONCLUSIVE and GUARD lines.
- **gather** merges the bots into the run summary: who signed up, played, reported and settled, their votes, their group per round (clean, or mixed with real players), and the guards.
- **Artifacts:** each bot uploads its video, screenshots, devlog and result-N.json. In a game run, the fake camera source carries that identity's portrait, display name and username through WebRTC, so network damage appears in the received character video. The recording HUD names the test and describes its current action from the catalogue; result-N.json retains its timestamped narration timeline. Boot-only and PR proof use a neutral **PreviewNet Boot Harness** source and must never claim a crew identity. Download artifacts with **gh run download <run> -n e2e-live-<run>-bot<N>-attempt-<A>** (A is the run attempt, 1 unless the job was rerun; the small e2e-live-<run>-bot<N>-attempt-<A>-result holds just the result).

How to judge a failure:
- **Chain checks are the authority:** Game.Players, Game.ReportSubmitted, GameEnded, and the verdicts decoded from the report.
- **A role check** fails when the role never acted. Roles must prove they acted; a role that silently does nothing is a bug.
- **INCONCLUSIVE** means the bot's runner froze long enough to switch off the app's auto-confirm. The freeze is named, and the run is not failed (issue 341).
- **A missed turn is a reject.** A bot that was down (killed, crashed, frozen, hidden or reloading) during a co-player's turn files NotPerson for that turn, by design. Its check expects exactly that.
- **Bot timing numbers are relative.** Bots run on Parity's internal parity-int-ubuntu VMs (4 vCPU, since PR #348; the `runner` dispatch input picks -l, -xl or ubuntu-latest). Frames still take about 400 to 500 ms on an unthrottled bot against about 35 ms on iPhones, because of software GL and several video streams. Compare bots with each other, never with phones. The 5 s plus stalls of the old 2-core runners are gone.
- **For Sentry evidence**, filter the bots' project on test.tag:e2e-bot and the bot's user.id.

## Rebuild the identities after a PreviewNet reset

A reset wipes PreviewNet's people and pool (paseo is untouched). One script rebuilds everything:

1. From a worktree off a fresh origin/main: `scripts/e2e-live/rebuild-previewnet.sh --dry-run`, then without `--dry-run`. Options: `--regular 50` (pool size, at least the names profiles.json uses), `--fresh 3`, `--repo` (default $GITHUB_REPOSITORY, else paritytech/individuality-apps, where the e2e workflows live; it refuses a repo without e2e-live.yml), `--from <step>`.
2. It runs reset, boot, personas, pool, fresh, remap in order, about 1 minute per identity (roughly 65 minutes for 50 bots). It is resumable: if it stops, run the same command again. Markers live in `$WORK` (default `$HOME/.cache/previewnet-sync/rebuild-<date>`).
3. The remap step rewrites profiles.json, the crew catalogue, the tests that name usernames and the crew doc to the new names in one pass, then runs the crew-doc generator, the e2e-live tests and the typecheck. It leaves new-identity.mts, settle-claim.test.ts and the plan docs alone.
4. Commit on a branch, open the PR, merge it (the workflows read profiles.json from main), then run a boot-only dispatch to prove the boot identity. Never start a full pass before the merge.
5. Keep the worktree: it holds the minted mnemonic slots in .truapi-host/. The boot slot is parked in the main checkout's .truapi-host-boot-previewnet.

## Prove a new profile

1. Add it to **scripts/e2e-live/profiles.json** with its own identity, plus a role in **roles.ts** if it needs new behaviour. Mark it pending until it is proven. In the same change, keep **scripts/e2e-live/crew/** current: add identity prose and a WebP portrait for a new PreviewNet identity, then run **npm run e2e-live:crew-doc** and commit the regenerated **docs/e2e-live-previewnet-crew.md**. Scenario parameters, guards, action narration, and membership derive from the validated profiles and plans; never hand-copy them into catalogue JSON. The crew tests and **typecheck:e2e-live** must fail any drift.
2. Prove it without joining a game:
   ```
   gh workflow run e2e-live.yml --ref main -f boot_only=true -f roles=true -f boot_profile=<name>
   ```
3. A green boot proves profile injection, not the dedicated identity: boot-only uses the shared boot identity. Keep it pending until `new-identity.mts` has verified the dedicated lite key and the approved eligibility step is complete. Its first full game proves the paired username/profile binding. Camera-denied and camera-missing are deliberate terminal permission outcomes: stage (a) passes only with the exact reason-specific help while remaining on `/permissions` without handover; stages (b)–(d) skip because these personas do not sign up or join.
4. Remove the pending mark. It joins **all** and one rotation half; use `bots=all` when every eligible persona must run together.

The same catalogue rule applies when an existing identity gains a new test profile, role action, guard, or timing: regenerate and commit the public crew document with that change even when no portrait or identity prose changes.

Every guard must use a telemetry name the app really emits (guard-names.test.ts enforces this). A role must record and read back what it did.
