# Humanity and Jollity hand-off timing

One fresh Ada uses both apps' real screens, both built from this checkout, on a fresh Paseo copy. Non-play
directions use transaction-only setup players; gameplay uses two real Jollity media peers. Each run measures
its total time and its parts.

| Scenario | Locally selectable rows |
| --- | --- |
| Sign up in Jollity, Humanity shows it (C1) | 3 |
| Sign up in Humanity, Jollity shows it (C2) | 3 |
| Open Jollity from Humanity (C3) | 3 |
| Play a real game, Humanity's card updates (C4) | 3 |
| Miss a game, both apps show it (C5) | 3 |
| Full loop: Humanity to a game and back (C6) | 1 |
| Apps catch up after being in the background: missed game while Humanity was away (B1) | 3 |
| Apps catch up after being in the background: game result while Humanity was away (B2) | 3 |
| Apps catch up after being in the background: sign-up while Jollity was away (B3) | 3 |
| Jollity's new-version screen: while opening Jollity from Humanity (U3) | 3 |
| Jollity's new-version screen: after a game on the way back (U4) | 3 |

Each outline retains three locally selectable runs; PR CI selects only run 1. Full loop: Humanity to a game and back (C6) is one complete loop. Each scenario gets a new Ada and a new game.

## How it is built

- `lab.cross-app.config.ts` reuses the scenarios lab: `freshPaseoCopy`, `keepBundle`, the drain, schedule and
  lab-player steps, the fast/full setup switch, the network guard and its video.
- `crossAppSessions` (`../scenarios/session.ts`) also serves Jollity's static export (`../flows/apps.ts`). It opens
  Jollity for Ada in a second host process, the way the Humanity to DIM2 flow does: the pinned CLI host runs one
  process per actor and app. It checks that Jollity's account 1 is Ada's game account.
- **The two host processes do not share host storage.** Humanity's cross-product read of Jollity's sign-up record
  (`src/features/card/hooks/use-game-registration.ts`) therefore finds nothing here, and Sign up in Jollity, Humanity shows it (C1) measures Humanity's own
  chain polling only.

For a separate Sign up in Humanity, Jollity shows it (C2) cause probe, `CROSS_APP_NAME_BEFORE_JOLLITY=1` holds Jollity's permission gate until the
Humanity console has reported a name-link `unfunded`/`skipped` result or a sign-up startup failure. It has a
120 s cap: a missing prerequisite fails the probe and proves no hand-off. This changes the preparation order
only, not an app. Keep these runs out of ordinary latency comparisons and distinguish a controlled reproduction
from evidence about an earlier run whose console was not captured. Sign up in Humanity, Jollity shows it (C2) now
funds Ada's game account on People and Asset Hub and waits for Humanity to report the name linked before Register,
so in that case the probe can no longer reach the hand-off. The unfunded hand-off stays reachable on purpose in
Open Jollity from Humanity (C3), Jollity's new-version screen while opening Jollity from Humanity (U3) and the entry
of the full loop (C6), none of which fund Ada, and every run keeps Humanity's startup log.

## The timing recorder

`timing.ts` holds the math only:

- `breakdown()` turns the marks into these parts: signing, inclusion, finality, hand-off, render and unattributed.
- A part counts only between two adjacent marks that were both kept. A missing or out-of-order mark is never counted
  as negative time; its time goes to "unattributed". So the parts on the path always add up to the total.
- Finality is on the path only for a reader of the finalized head. Both apps read the registration at the best head,
  so finality is shown beside the path and not summed.
- Labels: `ok` up to 45 s, `slow` up to 90 s, `too slow` above that. A label never fails a run. A run fails only when
  the end state is missing after 10 minutes (`capMs`), or when a step breaks.

Where the marks come from (`chain-watch.ts` and `steps.ts`):

| Mark | Source |
| --- | --- |
| tap | Just before the trusted click on Register |
| submitted | The first poll (200 ms) of the node's `author_pendingExtrinsics` that holds one of the inclusion block's extrinsics; the newest such sighting |
| included | The lab's own chainHead `bestBlocks$` first reporting a block whose `Game.Players(Account)` row is `registered` |
| finalized | The same, on `finalizedBlock$` |
| hand-off | The network guard's first received socket frame on the reading app's origin that carries that row's storage key. The payload is matched in memory and never saved |
| rendered | A MutationObserver on the reading app's page, installed before the tap, with a 100 ms poll as the backstop |

If the writing app asks its host to open the other app instead of signing (its `navigations.jsonl`), and no
registered row appears within 15 s, the run fails when the pool stayed empty or the writing app itself confirmed
the hand-off. `handoff.ts` keeps background pool traffic from hiding a confirmed hand-off. Its seven tests include
the captured unfunded case with 45 pool sightings, and negative controls for an included registration, an old
navigation, an unconfirmed navigation with pool activity, ordinary sign-up logs and the grace boundary. A stall reports:

- what the chain watch saw;
- the writing app's sign-up console lines;
- both apps' views.

The cross-app session also keeps sign-up, name-link, registration and bounded RTC console lines (excluding candidate payloads and credential lines) from before either page opens.
`startupLog` carries the page URL and Unix timestamp, retaining the first 100 and latest 900 matching lines, each
at most 600 characters. It resets for each new actor. This preserves a capability failure before the tap as well
as a later hand-off reason. Failed timed runs save `failed-<direction>-<run>.json` beside the timings before
throwing; the startup history is also included in passing runs. Existing Humanity-only scenarios do not collect it.

Every run appends to `timings.jsonl` and rewrites `comment.md` under `CROSS_APP_TIMINGS_DIR` (default
`.product-lab/cross-app/<start time>`). `lab/cross-app/scripts/cross-app-report.mts <timings.jsonl>...` prints the comment
section from one or more of those files. Nothing is posted.

## Run

From the repository root, with Node 24 first on PATH, inside the machine slot, using the cached bundle:

```sh
npm run build -w @jollity/app   # with the NEXT_PUBLIC_* and NEXT_TELEMETRY_DISABLED values of ../shared/build.ts
export PRODUCT_LAB_CACHE_DIR="$HOME/.cache/e2e-nightly" PRODUCT_LAB_FORK_BUNDLE=keep
export HUMANITY_SCENARIOS_FORK_DIRECTORY="$PWD/.product-lab/scenarios-engine"
export HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS=180000 HUMANITY_SCENARIOS_SETUP=fast HUMANITY_SCENARIOS_VIDEO_SIZE=640x360
nice -n 10 node_modules/.bin/product-lab test --config lab/cross-app/lab.cross-app.config.ts --tags '@C1 or @C2' --own-lab --video
```

Unit tests, which start no chain, host or browser:

```sh
npm test --workspace @individuality/lab -- cross-app/tests --maxWorkers=1
```

`tests/shared-registration.test.ts` joins the real page assembly, registration hook and current-game
hook at their query boundary. A delivered Jollity app record in `registering`, `sent` or `registered` phase selects
3 s game reads; absent and failed records keep 30 s reads (negative controls). The host record query stays at 2 s.
This is a hook integration proof with query results supplied by the test, not proof that any host delivered the
record. The pinned CLI adapter still runs a separate process and storage owner for each app. A single-process
multi-product CLI measurement is unavailable: the host's process-wide product selection disconnects existing
product sockets when switched. The core and the lab's shared WASM shell support separate product contexts, but
the shell's current preimage callback reads a test map, not Bulletin manifests. Do not call either a measured
phone result without qualifying its actual storage grants and transactions.

## Cross-app CI

`.github/workflows/cross-app-lab.yml` runs each of the ten cases once on PRs, plus the full loop while
its PR switch is true: 11 jobs, or 10 with the switch off. The PR concurrency cap is 11, so all scenarios can
run at once when enough self-hosted runners are available. Nightly keeps only Full loop: Humanity to a game
and back (C6), with full setup and a concurrency cap of eight (one actual scenario job). Every job owns a fresh Paseo copy,
identities, CLI hosts, storage and report directory. The host pinned by Humanity's lock (0.31.0) is checksum and attestation verified.

A shared build job on `ubuntu-latest` type-checks the lab and report scripts once, then compiles Humanity once
(including its strict app type check) and Jollity once. Scenario jobs depend on that check and build. Every run uses the same Jollity build with the
loopback version file kept current; only explicit update steps promote it. The
commit-keyed artifact holds static output and a manifest with the commit, build durations and SHA256 of
every file. Each run verifies the complete manifest before installing Jollity and Humanity.
The built-app config selects the static Humanity server in every scenario process and reuses the existing lab configuration;
ordinary scenario commands retain their Vite server. No app source or framework changes are needed. The root devDependency pins `polkadot-cli` 1.24.0 and its
complete tree through `package-lock.json` and `npm ci`. The prepare wrapper links that installed `dot` into
the pinned Engine tooling path before fetch, so the framework skips its unlocked npm install.
The same proxy supplies owned local routes to the built apps. Internal feature filenames, tags, direction keys,
run ids and command arguments retain their short codes so existing evidence and selectors remain compatible;
every visible name is expanded by the shared naming table. The shared Jollity build has the same loopback version URL for every case. That file is present and current
outside the two update experiments; those steps alone promote it. Builds are never repeated in the scenario jobs.

These shared builds change what the ordinary cases measure, so their timings are not directly comparable with the
2026-11-08 samples. Jollity's new-version check used to be off outside the update experiments; it is now on in
every case, so Open Jollity from Humanity (C3) and the full loop's entry (C6) include Jollity re-reading the local
version file during the hand-over. Humanity is now a production build served statically instead of the Vite dev
server. The funding step's finality checkpoint also applies wherever Ada is funded: Sign up in Jollity, Humanity
shows it (C1), Miss a game, both apps show it (C5), missed game while Humanity was away (B1), sign-up while Jollity was away
(B3), and the full loop (C6) after its entry.

The shared local/CI entry, inside the machine slot with the existing cache, is:

```sh
node_modules/.bin/tsx lab/cross-app/scripts/cross-app-ci.mts plan pull_request
node_modules/.bin/tsx lab/cross-app/scripts/cross-app-ci.mts build artifacts/cross-app-shared-build
node_modules/.bin/tsx lab/cross-app/scripts/cross-app-ci.mts run c2-1
```

Set `CROSS_APP_CI_OUT` to a fresh output directory. An existing timing file is refused. Every run selects
one tag and one exact outline row, and refuses any report containing other than one scenario. The summary
merges every dataset, keeps individual failed and missing run statuses in both HTML and markdown, and preserves
the grouped timing statistics. A group with one measurement says `single run` in place of a min-to-max
spread in both report formats and timing comments; repeated local samples retain their median and range.
Manual `run <id>` selection is independent of event plans: `c1-1` through `c5-3`, `b1-1` through `b3-3`,
`u3-1` through `u4-3` (rows 1, 2 and 3 for each case), and `c6-1` remain available, 31 ids in total.
Unknown ids, including `c6-2`, are refused. Only the isolated comment job writes the sticky comment; scripts post nothing.
Permissions stay contents-read by default, pull-requests-write on the comment job, and actions-write on cleanup.
The full loop remains nightly under `25 1 * * *`; `CROSS_APP_C6_ON_PR: "false"` removes it from PRs.
PR setup is fast and nightly setup is full. Recorder and report controls still run in Open Jollity from
Humanity (C3), run 1, and on the nightly full loop after browser preparation. Threshold labels never change
pass/fail outcomes.

The PR target is about 30 minutes for the parallel scenario phase, plus shared preparation, build and summary
time, assuming 11 free runner slots. The existing per-scenario estimates sum to 146–235 scenario runner-minutes
with the loop (128–205 without it); shared jobs and runner setup add time. These are estimates, not measured
results from this revision. The unchanged nightly full loop is estimated at 18–30 scenario runner-minutes,
with full-setup and shared-job overhead still additional. Per-job timeout limits remain 45 or 65 minutes.

The funded Humanity sign-up tops up only its local PGAS shortfall to two PGAS on the owned Asset Hub copy,
verifies the issuer and inner dispatch, and waits for finality. It then waits for the funding batch's finality, a finalized People balance covering the
play deposit, and Humanity's own successful name-gate message before Register. That last condition proves its
Asset Hub client has caught up too; the wait is bounded to 180 seconds. Earlier unfunded messages stay recorded
as findings. The recorder self-check draws animated canvas frames before closing and waits at most five seconds
for non-empty video output, keeping the one-video and summary-link assertions.

Bundle keys are `cross-app-paseo-bundle-<PR-number-or-nightly>-<asset-digest>` and the equivalent
`...-pin-<asset-digest>`. They live under the PR ref. The coordinator can delete that PR's entries when it
closes using that prefix and ref. A cleanup job prunes this ref's other assets older than six hours.

## Standalone timing report

`report.ts` validates every dataset, required configuration value and exact segment sum. It never fills a
missing mark from an expected polling interval. Declared configuration cites source file/line; installed
versions and the acquired host binary digest are observed. An npm package with no build SHA says not measured.

New recorder segments retain their actual clock intervals and lab actions get separate parts with overlaps
removed once. Their chronological timeline and accounting table both prove the sum. Older recordings retain
their original parts and chronological event marks; exclusive boundaries absent from the file say not measured.
Finality is always labelled lab-observed, upper bound. Data arrival is a received-key proxy. Pure render and
actual poll wait remain unmeasured; no native signing trace is claimed. A Register click is retained separately
from the pool-observed signing interval in new runs of both sign-up cases, Sign up in Jollity, Humanity shows it (C1) and Sign up in Humanity, Jollity shows it (C2). Missing finite marks are unattributed; non-finite
numbers are refused before saving. Background/return and registration-setup samples have separate summaries.

The combined Humanity missed-state/next-date observation counts once. Signed leads from the stored endpoints
stay visible; a lead is never clamped to zero latency. Return-CTA rows are alternatives for the same game.
The per-direction filter changes the view, and the report has no external styles, scripts or assets.

```sh
node_modules/.bin/tsx lab/cross-app/scripts/cross-app-report.mts --out report.html dataset.json
```

Tests in `tests/report.test.ts`, `ci.test.ts`, `timing.test.ts`, `recovery.test.ts` and `save.test.ts`
cover sums, interval boundaries, configuration, run selection and refusal controls. All lab/report scripts are
included by `tsconfig.scenarios.json`, which CI type-checks. The inherited return-control helper adaptation is
recorded in `lab/flows/UPSTREAM.json` and `patches/humanity-jollity-scarcity-e2e/manifest.json`.

## Opening Jollity and returning after a real game

Two cases, Open Jollity from Humanity (C3) and Play a real game, Humanity's card updates (C4), reuse this recorder, network guard, fresh-copy session and the existing real play loop.
Every reported duration is specific to the two-host topology. There is no shared CLI host-storage measurement.

- Open Jollity from Humanity (C3) selects Humanity's real **Register hand-off** (`use-register-for-game.ts:228-234`), holding Jollity's
  permission gate until Humanity has logged its unfunded/skipped name-link outcome. It follows the host's actual
  `polkadot://dim2.paseo` target with Jollity's own host session. The destination must show Ada's game/account
  and an enabled **Register**. A saved-seat "You're in" screen has no next-action button, so it is not this end state.
- Play a real game, Humanity's card updates (C4) prepares a member card using the existing fast fixture, then schedules and enrolls a distinct game. Ada plays
  the real tile-and-confirm loop imported for the full flow; the two lab bots report by transaction only after
  Ada's report is on chain. No forced attendance stands in for that measured game. The following game's schedule
  is finalized before play. Its setup is excluded from the measurement.
- Play a real game, Humanity's card updates (C4) starts at the lab's first best block holding Ada's attended score row
  (her `Score.Participants` row for the measured game). Ada's own report writes that row, five or six blocks before the
  game ends, and the returned card shows only that row, so the game's end is not on the card's path: a start that also
  waited for it could fall after the card (#1988's C4 and C6). The game's end is still proven after timing: the step
  waits for the indexed finalized GameEnded event. C6's return and U4 use the same step and the same start.
  It reports best-to-finalized, finalized-to-Humanity's data-arrival proxy and render, plus alternate origins at
  the end-of-play confirmation and Jollity's first payoff screen. It follows the real visible post-game exit and
  records a second CTA breakdown without counting it as another game run.
- `RegistrationWatch` accepts an optional read-only result predicate; Sign up in Jollity, Humanity shows it (C1) and Sign up in
  Humanity, Jollity shows it (C2) keep their original registration predicate. Both watches use the existing best/finalized subscriptions and pool recorder.
- The first best block that shows the result can lose a reorg to a sibling at the same height. Once the sibling is finalized
  the node prunes the loser and `chain_getBlock` answers null. `marks()` then keeps the best-head time, sets
  `includedRetracted`, and leaves signing (`submitted`) unmeasured instead of failing the step. Timing tables show
  "not measured" for signing with the reason, and the report and comment say the best block lost a reorg.
  `tests/chain-watch-reorg.test.ts` replays it; its control removes the guard and gets the CI message
  "Cannot read properties of null (reading 'block')".
- A page initializer records document load, usable state and attendance/date mutations before navigation. The
  existing browser-body audit covers its callback and the new journeys. Socket probes match the storage key in
  received frames; they are an arrival proxy, not a decoded React-query notification or a native-host trace.
- Open Jollity from Humanity (C3) reports tap-to-navigation, **lab overhead** (navigation emitted to the lab following it), document load,
  data arrival, render and unattributed time. The wall total includes the explicit overhead. Do not call that
  overhead app time or silently remove it from the total.
- The same-next-game-time check compares the actual localized game dates with the finalized schedule and retains
  date changes. Permission gates, loading views and payoff screens can have no visible date; those are not
  simultaneous date observations. Retiming is lab setup. Play a real game, Humanity's card updates (C4) records the old/new schedule and the transition views.

Run the additions with the environment above and `--tags '@C3 or @C4' --video`. Each feature has three outline
rows. Run a single pilot with `--name 'run 1$'`. A fail-fast custom Cucumber configuration must include bundled
support and `lab/cross-app/journeys.ts`, as well as the existing scenario and cross-app steps. The dedicated cross-app workflow uses the same configuration.

The new math and destination/date checks have unit tests and negative controls in
`tests/journey-timing.test.ts`. Unknown or ambiguous cross-app direction tags are also refused by the
network guard's tests. The full local evidence for Open Jollity from Humanity (C3) and Play a real game, Humanity's card updates (C4) lives in
their hand-back report, outside the source checkout.

Every date check expects Jollity's time from `lab/cross-app/jollity-time.ts`, which runs in the Jollity page. It
mirrors Jollity's `formatGameAt`: the clock alone today, in the device's hour cycle ("16:00" or "4:00 PM"), and
"Nov 12 at 16:00" on another day. The lab may not import Jollity code, so `tests/jollity-time.test.ts`
pins the mirror to those forms through serialized callbacks, including the tsx keepNames transform, midnight
and noon. Its fake page controls both Intl and locale clocks; legacy-format negative controls do not depend on
the machine locale. Change both when Jollity changes how it writes the time.

## No-show, background recovery and local update experiments

Miss a game, both apps show it (C5) reuses Sign up in Jollity, Humanity shows it (C1)'s real Jollity registration, a member fixture and a one-miss grace window. Ada never sends a game
report. The existing lab repository shuffles, has only the two bots report, and advances the local reporting
deadline. A best-block result watch, an independent lab-observed finalized mark and indexed finalized GameEnded
proof anchor the run. Humanity must show the exact game's missed attendance mark, her card, the caution note
and the next game. Jollity has no persistent missed-history panel on home; its transient You missed this one gate is for accounts not registered in a running game; its endpoint is Ada's exact account with the next
game and its actual available action/funding state. Each app's retained date timeline includes disagreements and missing-date coverage gaps.

- `@C5`: ordinary no-show, three outline rows.
- `@B1`: Humanity suspended after registration through the no-show result, then resumed; foreground-to-correct
  attendance/card/caution and next-game endpoints. The active Jollity endpoint remains a separate Miss a game, both apps show it (C5) observation.
- `@B2`: the real Play a real game, Humanity's card updates (C4) game, Humanity suspended on Jollity's post-game screen before its return CTA, then resumed
  once the lab has seen Ada's attended score row finalized, through fresh attendance and the next game. The subsequent real return remains separately recorded.
- `@B3`: Jollity suspended before registration; the lab enrolls Ada by transaction while it is suspended, then
  resumes it through the exact account's You're in state.
- `@U3`: the actual Humanity Register hand-off meets Jollity's real stale-build gate. Requires the local update
  build and `CROSS_APP_UPDATE_LAB=1`. The experiment ends at the blocking gate, without replacing its UI.
- `@U4`: the real Play a real game, Humanity's card updates (C4) return with the local version file promoted after play and before the return. Humanity's
  current source contains no stale-build gate or version URL. This is a measured absence of that gate on this
  source revision, not a simulated Humanity update screen.

`lifecycle.ts` uses CDP `Debugger.pause`/`Debugger.resume` on the guarded app page. The lab waits for the actual
paused event and verifies timers stop while received WebSocket messages remain queued for delivery after resume.
The earlier native lifecycle command acknowledged without stopping timers; a timer-only scripting-disable fallback
then dropped WebSocket events and left a real app unable to refresh. Both were rejected by real-browser controls.
No document property, lifecycle event or app state is patched. Visibility remains the browser's actual value.
This is a JavaScript suspension experiment, not phone visibility, OS process death, host suspension or socket loss.
A foreground recorder snapshot retains stale or already-correct cached state. Missing received-key frames leave
arrival attribution unmeasured; an unchanged cached view alone does not prove a new read.

`version-file.ts` serves a real local HTTP JSON file at `http://127.0.0.1:49791/version.json`. The update-only Jollity
build uses `NEXT_PUBLIC_VERSION_URL` with that URL, `NEXT_PUBLIC_APP_VERSION=cross-app-update-lab` and
`NEXT_PUBLIC_BUILD_TIME=1`. Its current file reports the same version/time; promotion reports a different version
and time 2. The unchanged app supplies its own permission grant and fetch. No network guard exception is added.
The file resets for every actor. Direct Vite scenario commands and manually built source flows retain their existing release settings; the shared CI build uses the same current local version file in every run. The lab must build and run
this variant inside the machine slot; the report retains exact build commands and source references.

Every new endpoint uses the existing timing recorder and save path. Lab file promotion, permission clicks,
navigation follows, payoff walks, optional prompts and card display controls have explicit intervals. The recorder
intersects each lab interval with the measured window and subtracts it from any overlapping part before adding it
once. Invalid or overlapping actions are rejected. Unknown or inverted marks remain unattributed. Finality figures
are always lab-observed upper bounds; a UI endpoint before that notification keeps its signed offset in raw evidence.

Run with the normal Node 24, cache, local routes and machine-slot wrapper above; select a tag such as `--tags '@C5'`
or `--tags '@B1 or @B2 or @B3'`. The fail-fast Cucumber support must also import `lab/cross-app/recovery.ts` and
`lab/cross-app/update.ts`. The local report includes the complete run wrapper, commands, measurements and videos.
Unit tests in `tests` cover readiness, account/game negative controls, exact sums with lab-action overlaps,
real Chromium script suspension, guarded origin rejection and the actual HTTP version-file promotion/reset. The
scenario browser-body audit also covers the new modules. CI uses the dedicated cross-app workflow. The existing upstream-copy instrumentation now has a patch manifest.

The initial Miss a game, both apps show it (C5) pilot retained the member fixture's cancelled game between its last attended index and the
measured miss. Humanity consequently labelled the miss as that cancelled index. The strict exact-game check
refused it. Miss a game, both apps show it (C5)/Apps catch up after being in the background: missed game while Humanity was away (B1) now explicitly seed the synthetic prior attended index at G-1 before measuring G; the measured
absence is never forced. `fixtureAttendanceIndex` rejects G or later and is negative-control tested. The pilot
stays failed and separate. The no-show completion uses indexed GameEnded plus the result predicate instead of
requiring Game=None, because the pre-scheduled next game can already occupy Game in the ending block.

Miss a game, both apps show it (C5)'s missed endpoint requires the correct next-game date as well as the exact missed row, card and caution.
Score can change during processing before GameEnded, so an early missed tile alone does not complete that
combined endpoint. `observations.jsonl`/`observations.md` retain every signed UI offset from the best-result
notification and lab-finality notification. An endpoint before an independent observer mark is a signed lead,
not a negative duration or a fabricated zero. Only nonnegative forward intervals enter the existing breakdown
recorder; signed observations remain visible in the run log and comment file.

Miss a game, both apps show it (C5) also distinguishes the passive `Game at …` next-date view from the later actionable `Game starts at …`
view. The queued date already counts as a displayed next game. `jollity-next-date` requires its exact account
and schedule only; `jollity-next-action` additionally requires Next game or Top up to play. A separate endpoint
prevents the later Register milestone from inflating next-date latency. The data-proxy-to-state interval is a
mixed wait; its pure rendering component is unmeasured. Summaries aggregate repeated same-name actions within
each run, preferring on-path parts over beside copies, so every click is included once in per-part statistics.

Jollity's new-version screen: after a game on the way back (U4) leaves Jollity on its real post-game page after the return. Reopening its home solely for a date comparison
would create a new stale gate after the measured hand-off, so that extra navigation is omitted for Jollity's new-version screen: after a game on the way back (U4). The current
date comparison records a coverage gap for the dateless post-game view; an earlier matching pair is never claimed
as current agreement. The ordinary Play a real game, Humanity's card updates (C4)/Apps catch up after being in the background: game result while Humanity was away (B2) comparison still opens Jollity home and waits for both actual dates.
Version-file writes below one millisecond remain explicit zero-duration lab parts at the recorder's clock resolution.

The caution recorder accepts the app's general Play the next game to keep it line as well as a dated deadline.
The general line is valid while the next game is queued; waiting for the later actionable deadline would inflate
first-correct-state latency by another poll. Final Miss a game, both apps show it (C5)/Apps catch up after being in the background: missed game while Humanity was away (B1) repeats use this inclusive note boundary; the earlier
deadline-bearing repeats remain separately retained. Parts with lab-action overlap print their original wall span
and say the lab interval was removed. The full best-to-lab-finality clock is also shown beside Play a real game, Humanity's card updates (C4)'s exclusive parts;
a zero residual in an overlapping part is never a claim of instant finality or a causal optimization.


### Dispatch evidence and imported schedules

The CI data artifact includes `transactions.jsonl` alongside the timing dataset. The cross-app session observes
inclusion and finality receipts before validation, so a failed `Sudo.Sudid` survives run-directory cleanup.
The projection exports only lab labels, block and transaction hashes, outer status, and decoded Sudo/Utility
error variants. It exports no signer, signed bytes, account keys, arbitrary event payloads or host files.
`lab/shared/transactions.ts` provides `transactionEvidence`, `observedSubmitter` and `transactionWriter`, and
`transactions.ts` here re-exports them. Shared name-link funding writes receipts only to a file its caller names;
`funding.ts` passes cross-app's actor, journal and `transactions.jsonl`. No port is added. `tests/transactions.test.ts` covers retention and
rejects an unsafe payload and a swallowed submission error.

A finalized idle snapshot can still list a schedule already consumed by the runtime at the best head.
The imported-game drain accepts `Game.NoSuchGameScheduled` only if that exact schedule is absent at the
receipt's block. Other inner errors fail. A replacement game must match a snapshotted date, be empty Registration
and have no pending attendance. The scenario then removes the remaining schedules and cancels that validated
promotion before requiring finalized idle state. `tests/imported-race.test.ts` covers promotion,
expired schedules and refusal controls; `tests/scenarios/fast-setup.test.ts` covers the handoff's final cleanup.

### Real media peers for play

CI tests the PR merge commit, whose Jollity UI can differ from this branch. Merge `d798fd2e` removes No video
recap tiles and correctly hides unseen players. Transaction-only bots therefore expose no tappable peer on that UI.
Play a real game, Humanity's card updates (C4), Apps catch up after being in the background: game result while Humanity was away (B2), Full loop: Humanity to a game and back (C6) and Jollity's new-version screen: after a game on the way back (U4) now provision Lab1 and Lab2 as real Jollity media peers. Every player registers through its own
screen, retaining the real communication key that sign-up registers. Every player runs the existing tile/confirm
loop and the shared early-close confirmation barrier. Every player must tap a real round tile and finish, and its
exact finalized `Game.report` must contain two Person votes and no NotPerson vote. Confirm-only placeholder
corrections cannot satisfy this check. No transaction report stands in for a UI vote.

Ada's Humanity and Jollity still run in separate CLI hosts with separate storage. Two extra Jollity hosts supply
peer video, for four hosts during gameplay. Each peer has its own app proxy and bridge, and is retired before
the next actor. Non-play legs retain transaction-only setup peers and two hosts total. The report's topology
configuration states this distinction. Finalized UI-vote reads run concurrently; their awaited validation is recorded after all measured endpoints, never as a counted lab action.
`real-play.ts` and `media-registration.ts` export the group driver and UI registration helper, used by `journeys.ts`.
The real-play controls reject missing/duplicate peers, placeholder-only votes, a transaction registration shortcut
and an abandoned peer loop. Each peer uses the session's assigned port range; no fixed port is added.

Each UI registration counts only the registration clicks its page may have received. The shared helper reports every
input it sent or withheld (`input`); an attempt it withholds because the view changed after its guard is not a click.
In #1961's B2 run (attempt 2), the old count took such an attempt for a second click and failed Lab1 after one real
tap. Every failure of the step (no click or more than one, a row registered before the UI action, a timeout, Native
PAS requested, the update screen, a page check or click error, or a seat that never shows "You're in") throws its own
message and one line, "evidence: media registration, in observations.jsonl and the step attachment". Nothing else
goes in the message: product-lab classifies a failed step by its whole error text, and evidence words such as
"finalized", "extrinsic" or an RPC error's "WebSocket" would turn the verdict into a chain or environment failure. The
evidence goes beside it instead. Step attachments stay in CI's private report, so with `CROSS_APP_TIMINGS_DIR` set the
readable lines and the evidence are appended to `timings/observations.jsonl` (kind `media-registration`), which the
workflow uploads with every run in the `cross-app-data-<id>` artifact. The step also attaches them, as readable lines
(`mediaRegistration`) and as JSON. Recording the evidence is best effort: a write or attach that fails never replaces
the failure, and leaves one stderr line saying why, without local paths. A source guard checks that both media steps
in `journeys.ts` run through that wrapper. The evidence names the player, its peer order and account (SS58
and hex) and the registration clicks sent, then the extrinsic whose Game events name the account: block, call and
sender (the account itself, the lab's root authority, another peer, or no signer). The search prefers a Game.SignedUp
event or a sign-up call, even in an extrinsic decoded `partial`; otherwise the line says "latest Game event naming the
account", since a later event can name it too. The evidence also names the before-read (`setupRead`, best head in
fast mode) and the finalized `read` checks with their blocks, every peer's best and finalized row and screen, and each
input.

The diagnosis never hides the failure. It has one 30 s budget, capped by the step's remaining time less 3 s, and each
read in it races a 5 s timer and the run's abort, as product-lab's pause inspection does. The peers' rows and screens
are read alongside the search, so a slow search cannot leave them unread. On a stall, the end of the budget or an
abort it keeps what it read, including the latest Game event the search had found, and adds `diagnosis stopped:
<why>`; it never throws. A run that is already stopping when the helper fails passes its abort on to the runner.
`tests/media-registration.test.ts` replays the B2 sequence and holds the negative controls, among them a block read
that never answers, an abort during the search, and a guard that product-lab's `classifyFailure` gives every thrown
message the rule and layer of its first line alone.

The guarded browser's deny-all resolver also denies Chromium's randomized `.local` ICE candidates between
independent contexts. For this same-host media lab, Chromium's mDNS IP hiding is disabled so the native peers
advertise interface candidates directly. The existing non-proxied UDP policy, outside HTTP/WS denial, resolver
and deny proxy remain. `tests/media-network.test.ts` decodes native video across contexts with that
setting; its negative control retains mDNS and decodes none. Both deny an outside HTTP request. This qualifies
same-host media, not complete WebRTC wire coverage. Failed real-round qualification also reads the app's existing
debug sheet for bounded RTC/statement messages; it never exports folded payloads or signalling secrets.

Full loop: Humanity to a game and back (C6) returns after Ada's first game. Below the finalized personhood threshold, the real app shows a Candidate card
with a progress stripe and intentionally no member attendance row. The Full loop: Humanity to a game and back (C6) return records the pre-game score,
then requires a new finalized attendance for that exact game and an increased score. Its UI endpoint requires
the candidate state, the actor's owner account, that exact score and threshold in the progress stripe, the card
name and the expected next game. Stale/wrong-owner progress cannot pass. Member-return legs continue requiring
the visible attendance mark; no synthetic membership is added to Full loop: Humanity to a game and back (C6).

Finalized-vote reads start in the background when UI play finishes. The driver immediately walks the payoff and
return controls; it captures primary, return-CTA and recovery endpoints before awaiting those reads. The awaited
verification interval must start after every measured endpoint and is never a counted lab action. Read start/end
and post-measurement await start/end are recorded separately. A failed proof still fails the scenario.
For a first-game Candidate, timing uses visible progress above the pre-game score and a matching owner; the exact
score/threshold is compared to the finalized proof after the endpoint closes.

The background leg remains nine rows on one runner. Its timeout is 180 minutes (other legs: 120); the expected
wall time is approximately 95–105 minutes from the observed row/setup costs, with no extra parallel play leg.
CI prepares Chromium before recorder controls. The prepared controls require it explicitly, so missing Chromium
fails that CI step; source-only unit jobs retain their optional browser-test contract.

### Permissions returning after the entry update gate

Jollity's new-version screen during entry (U3) may briefly show before `/permissions` returns. The lab allows
access once in the initial gate wait and at most once more in the account-retention wait. It then requires the
root update gate, Ada's exact account and no enabled Register for one second, counted from the later of the
first held poll and the page's own update mark. A disappearing gate, a wrong account or an enabled Register
resets that interval. The recorded endpoint follows the recovered document's update interval, including the
second permission action in the timing evidence. `tests/update.test.ts` drives the registered step
with serialized browser callbacks and rejects repeated permissions, another account, a flashing gate, a gate
re-marked between polls and an account that is wrong for one poll.

The cross-app config is `lab/cross-app/lab.cross-app.config.ts` from the repository root. Its runtime callbacks own root `.product-lab/` state. Shared helpers are in `lab/shared/`; the private workspace checks and six-way default selector are described in [../README.md](../README.md). CI still runs the same named scenarios, shared static builds, report controls and 14-day sanitized artifacts.
