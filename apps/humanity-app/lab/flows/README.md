# Humanity into DIM2 after a merge

This lab builds **both Humanity and DIM2 from this checkout on every run**. Three newly provisioned local Paseo
players open Humanity, enter one shared DIM2 game, register, play, vote, finalize reports and receive two delivered,
unclaimed credits each. It stops at three-apps step 22, before Scarcity. The `dim2-players-ready` recipe is created in
the run: no player pool, saved player import or fixture export. Native PAS stays zero on People and Asset Hub.

Run from the repository root with Node 24 and `npm ci`:

```sh
npm run --workspace @humanity/app humanity:flow:check
npm run --workspace @humanity/app humanity:flow:prepare -- --engine locked
npm run --workspace @humanity/app humanity:e2e:flow -- --fresh
npm run --workspace @humanity/app humanity:e2e:flow -- --fresh --negative-control
node_modules/.bin/tsx apps/humanity-app/scripts/lab/flow.mts demo
node_modules/.bin/tsx apps/humanity-app/scripts/lab/flow.mts cleanup
```

The control repeats the journey through step 20, where Alice deliberately expects three credits. Only a failure of
`2 DIM2 credits to keep, not 3`, after every prior step passed and cleanup passed, qualifies it. An early failure,
missing proof, or timeout fails the control. A control demo requires `demo --failed` and remains labelled failed.

`lab.flow.config.ts` exports the lab. `session.ts` exports its sessions and chain-reader adapter; `steps.ts` registers
its sentences. `recording.ts` records actual actor/setup and custom-step spans plus page-video descriptors for the private demo input.
`run-reports.ts` resets stale run outputs only after the wrapper holds its lock, preserving prepare resource records.
`contract.ts` checks the three players and the exact scenario verdict. `guards.mjs` admits lite cards
and checks app failures. `demo.mjs` cuts a continuous timeline per actor from both app pages. `lab/shared/static-server.mjs`
serves only built files on loopback. `lab/shared/build.ts` exports the staging build profile and checks that the compiled
Humanity panel exists. `lab/shared/watched-text.ts` skips only the known document-replacement observation race. No app behavior changes are made. This folder depends on the installed
`@parity/product-lab`, both repository apps' build outputs and the root lock. The only consumer is this lab and its
wrapper. The framework allocates the ports; `PRODUCT_LAB_PORTS` and `PRODUCT_LAB_FORK_PORT_BASE` select a local
range. Public or attached chains are refused using the owned fork's validated session and loopback routes.

`lab/shared/host-ports.ts` projects a session range to exactly `{ from, to }`, the installed truAPI CLI host's strict ports
schema. The framework also attaches `source` and `note` to session ranges; those are diagnostic metadata, not
host options. The controls reproduce their rejection using the installed resolver and adapter schema, then
prove the projection accepts the bounds and excludes a future unknown key while retaining bounds validation.

`lab/shared/apps.ts` defines both source launchers with node from PATH. AppDevServer.parse validates those same declarations
in the wrapper before host acquisition or fork setup, and when loading the lab config. Absolute executable paths
are rejected offline for either app; runtime-resolved script and build-directory arguments remain portable. The
preflight follows the separate DIM2 opening's portable-launcher checks; launcher sharing remains a
follow-up, and neither implementation imports the other. Preparation, CLI checks and demos also use PATH node.

`actor-session.ts` validates the actual served proxy URL with Actor.origin before the host receives it and before
an actor is published. Each actor retains its own initial Humanity HTTP origin; product deep links remain only
in the navigation registry. Preflight checks the same actor factory, isolated origins, aliases and session keys
for both apps. Config reloads and ESM steps share one owned-flow slot, cleared only by its matching owner; an
offline reload control runs the real next step with synthetic chain reads and rejects a missing/closed owner.

`local-ports.json` provides an optional local profile: fork ports 27000-27999 and lab ports 28000-29999, with
the lab window and sessions at the top of the range. It stays below the default Linux and macOS ephemeral ranges
(32768-60999 and 49152-65535), clear of 34000-35999, 48000-49999 and 44438 used by other local services. A local
launcher can load these two environment settings before prepare and run. The offline controls reject the old
52000/54000 ranges and overlapping blocks. Check every selected port with `lsof` immediately before starting:
an otherwise suitable range can already have a listener. This profile is not applied to CI: choose ranges against
the runner's actual ephemeral configuration and active listeners. An overlap warning establishes a race risk, not proof that
a collision caused a finality stall. Chain readiness remains mandatory before any session or journey starts.

In CI the flow job sets `PRODUCT_LAB_FORK_PORT_BASE=14000`, so its fork uses 14000-14999. The runner reports an ephemeral
range of 15000-65000, and the framework default 42000-42999 sat inside it: the lab warned about the overlap on every run, and
on #1982 port 42916 was already taken when the scenario opened. The other lab jobs (Humanity, Jollity, cross-app) use
10000-10999, and the lab claims its own ports in 20000-32699, so the new block shares neither. `tests/flow/ci-ports.test.ts`
checks this through the framework's own resolver, and its controls reject the old default, 10000 and a block crossing 15000.

The advisory workflow runs on pushes to `main`, manual dispatch, and same-repository PRs into `main`.
PR events are opened, reopened, synchronize and labeled. `run-dim2-flow` opts in a PR; on a labeled event,
only that label starts work. A read-only `sources` job also enables runs for this flow folder, its wrapper,
`lab.flow.config.ts`, the shared `lab/opening/session.ts`, the scenario sanitizer or the flow workflow.
Plain app or dependency changes need the label. Fork PRs never run. PRs select the positive feature only;
the wrong-credit control remains a dispatch input.

PR source detection and the journey share `humanity-dim2-flow-pr-<number>`, cancelling older work on that PR.
Main merges retain `humanity-dim2-flow-main`, and dispatches retain their separate per-ref groups, with running
work never cancelled. A newer pending run can replace an older pending run in the same group. The comment job
uses the separate shared `lab-opening-comment-<number>` group so a new push does not interrupt its writer.
The `flow` section, "DIM2 play-through", preserves both openings and links the three existing artifact names.

Every flow event uses `DIM2_FLOW_RUNNER`, defaulting to `ubuntu-24.04`; point it at an 8-vCPU runner where one is available. The job budget is
120 minutes and the build/journey step has 50 minutes. Explicit step caps sum to 105 minutes, leaving
15 minutes for setup, uploads and the comment projection. The pre-rebase local positive took about 22 minutes:
8 minutes for environment startup, 3 minutes for actors and 13 minutes for the scenario. The extra budget
covers install, prepare, both source builds, CI's import wait, cleanup and demo cutting. This sizing is an
estimate until a CI run exists. The workflow has no consumers and gates no deploy or release; it must remain
non-required. Humanity CI runs offline typecheck, unit/workflow tests, lint and feature binding plans through
the workspace `humanity:lab:check`. Flow scripts remain outside Jollity's bundle inputs.

CI bounds imported-game completion with `HUMANITY_FLOW_IMPORTED_GAME_WAIT_MS=600000`. Unset locally, the
65-minute maximum and finalized remaining-reporting-time plus processing-slack calculation are unchanged.
The optional bound is a positive integer no greater than the local maximum; invalid values fail. A timeout
while the import is still Reporting and finalized heads have advanced within the last minute throws exactly `not run: imported game in Reporting`, before any schedule
removal or cancellation. It records a failed wait, produces a non-zero journey/job exit, and emits `passed: false`
and the fixed not-run reason in sanitized results. The comment says **NOT RUN: imported game in Reporting**.
A head frozen from the start or for at least the last 60 seconds retains the explicit chain-stall failure
rather than the not-run reason, including a chain that advanced once before freezing.
Other states retain their failure diagnostics, and no storage, time or authority guard is relaxed.

The fork bundle is downloaded per run. Read-only GitHub tokens are scoped to preparation and the journey;
source builds and static servers explicitly discard them. Install, prepare, journey, cleanup, tool installation
and demo steps have bounded timeouts so common stalls leave time for evidence upload. The wrapper forces `PRODUCT_LAB_FORK_BUNDLE=fresh`; there is no Actions
cache and no release CID cache access. Prepare fetches the locked Engine and host tooling, not saved players.
The wrapper deletes the disposable fork after cleanup. Only feature-authored step names and fixed verdicts, source SHA/tree/lock digests,
resource samples, actor videos and demo cuts are artifact inputs. Wallets, raw host logs and chain databases are
excluded. JSON attachments and raw errors are excluded too; the scenario projection is written before cleanup even on failure. Demo uploads contain only MP4/WebM, VTT captions and slide PNGs, excluding private edit/command reports and their paths. Videos, demos and sanitized results are retained for 14 days. Per-process-tree RSS and free disk are
sampled every five seconds; CI also records `/usr/bin/time -v` and cgroup OOM counters. A sampled RSS maximum is
not a kernel high-water mark.

## Ported code and local choices

`UPSTREAM.json` records original and destination SHA256 digests and adaptations. Source:
[humanity-jollity-scarcity-e2e](https://github.com/paritytech/humanity-jollity-scarcity-e2e), commits
`51d40995a21513a709cce11b9669ddd29cc854ea` (one-batch fork setup and registration close after three) and
`645e7e152cbe0f7e71a29ae23da96515c80cac75` (actor video retention and per-actor demo). These copies are self-contained
and import no files outside this repository. The upstream refactor is recorded separately from this snapshot. The 23-file support closure retains gameplay, finality and vote checks, schedule and draw
retiming, and delivered credit checks. Scarcity sessions, UI and transfers are excluded. People descriptors come
from the repository's own generated package. Noble's v2 export replaces the old hash import. Full source paths include `suites/humanity/`.
The landed `c833b3d` refactor injects `OwnedGameFork` into three game helpers and renames the runner test;
`UPSTREAM.json` records those differences while retaining this copy's ownership checks.

The released CLI writes actual requests to `TRUAPI_NAVIGATIONS_LOG`. The consumer follows that file directly,
because the opening's older lock annotates only localNetwork. A real `peopl` to `dim2` opened event is mandatory;
a click alone is never navigation evidence. The weekly-game control accepts its current Register label as well
as the older Open the game wording, following the upstream driver.

The three parallel table steps are expressed as three explicit custom group steps. Product-lab 0.1.0 does
not dispatch custom sentences inside its built-in parallel table (the 0.1.1 and 0.1.2 release notes do not change this). Each group still invokes all three players
concurrently; the positive feature retains exactly 22 steps. The 14-call imported-game cancellation path has an
executor unit test with authority, receipt and finalized-state corruption controls. Nonempty imported games use
upstream's bounded cancellation recipe before the atomic setup, rather than weakening the batch's empty-game guard.
Registration is moved to close 60 seconds after all three registrations are finalized. Before voting, the complete
shuffled group, including the fourth slot, must contain exactly the three owned accounts.

Page observations skip one read only for `page.evaluate: Execution context was destroyed, most likely because
of a navigation`. A missing body reads as empty, and every other browser error stays fatal. Both the card wait
and the app-failure monitor use this rule; a skipped observation starts no action.

A lite card may be `candidate` or `devicehood` (display label Person) and must offer an enabled Register or Open
the game control. Closed-registration cards are refused. Only the existing Shown presentation control is used for
the CLI host, which has no native Pocket. No simulated membership scenario is selected.

A DIM2 `bind failed, retrying` entry is held for at most 60 seconds from its timestamp. It becomes a recorded
warning only when an independent finalized PeopleLite alias read confirms that actor's game account and the Paseo
DIM2 context within that window. A wrong context, late or unreadable alias, ambiguous actor, or any other app
failure remains fatal. A later success log is insufficient. This deliberately matches the qualified guard policy;
unit controls exercise Candidate cards and the alias exceptions. Credit proof runtime calls obtain a fresh
chainHead finalized pin, while storage and credit-root reads retain their explicit finalized hashes.

The DIM2 source launcher serves a production static export. `npm run build` invokes the same plain `next build`
as staging (Next 16.4.3, Turbopack), and `out/` is served on loopback through the host proxy. Humanity uses staging's
`VITE_DEBUG_PANEL=true` and `VITE_LOG_LEVEL=debug`, because the existing Shown control requires the panel. Both
flags and the production bundle guard are tested. The local fork disables telemetry and version-update polling.
The separate DIM2 opening uses a development server; a shared launcher would need to preserve both serving modes.

Tests live in `tests/flow/`: workflow mutations, scenario verdicts, player ownership, Candidate and bind guards,
atomic setup and retiming, and actor video segmentation. Run them with `npm run --workspace @humanity/app humanity:flow:check`. The dry runs
prove binding only; they do not qualify a fork. Qualification comes from CI runs on a fresh copy.

## Deferred follow-up

- Share the source launcher with the separate DIM2 opening when their serving requirements are aligned; its development server and
  this production static export currently have different purposes.
- Add a second ownership and Sudo-key check immediately around retiming as defence in depth. The session-level
  owned Paseo/loopback guard remains in force; the existing retime behavior is unchanged here.
- The separate opening's broad `humanity-lab.yml` path gate also includes flow-only changes. Changing that gate
  requires the opening-trigger tests. Flow-config-only changes (`lab.flow.config.ts` and `tsconfig.flow.json`) now
  skip that opening. Root manifest and lock changes remain deployment inputs.

## Storage evidence

Raw historical reads return `undefined` when a key is absent. Zero-PAS evidence records an absent
`System.Account` explicitly on both People and Asset Hub; a present record requires bigint free and reserved
balances equal to zero. RPC and decoding failures propagate, and malformed records fail. Other value queries
use the runtime metadata fallback (not an invented empty value); optional game, player and alias records stay
optional. Required game and registration records and the fresh-credit block list have explicit shape guards.
The imported-game cleanup duration is attached before balance assertions so a later failure retains its timing.
Offline controls exercise the real chain adapter with synthetic RPC replies and the actual zero-PAS step.


## Static route serving

The local source server supports both directory-index exports and Next's flat route HTML beside RSC directories.
When a route directory has no index.html, it falls back to the sibling .html file. The original directory check
returned Not found for permissions, game and results routes even though those pages had been built. Offline
controls run the actual server handler without listening, preserve binary/RSC assets and missing-file refusals,
and execute the actual navigation steps with the real registry and synthetic pages and alias reads. Restoring
the directory-shadow bug reproduces the bounded destination wait with an accelerated test clock. These controls do not establish live UI success.
Wrapper phase records retain tool basenames only; PATH node must match the wrapper's running Node version.


## Viewing the current game's payoff

The current DIM2 source exports prize-draw and chest routes, with Continue on the chest handing off to Humanity.
It has no results route. Finalized reports and votes are checked before the results step, so that step cannot
assume the transient payoff route is still active. `post-game.ts` reopens `/chest?game=<selected index>` through
that player's owned DIM2 navigation session, permits the real entry gates to run, and requires the exact game on
the chest route before reading its exit control. Home is never accepted as results. The driver stops before
Continue, retaining the two credits for the independent finalized-chain assertions that follow.
Offline controls execute the actual results group and all three credit steps, including the exact wrong-credit
mismatch. They use synthetic observations and do not establish delivered credits on a fork.


Results recovery rejects a no-identity chest even if Continue is enabled. It never counts the long-wait
notice (`chest-slow`) as results: since Jollity's chest state machine that notice also covers results still settling (10 s
after the bubble lands, or 60 s after the page opens), its Continue is the skip, and the lab waits for the claims to replace
it. Once the notice has shown, the walk's bound is 240 s from its start, past Jollity's third pending reread at about
210 s, and stays so after the notice clears. It requires either the ready chest scene or The chest with the
selected GAME #N label (matched case-insensitively for CSS uppercase) in one visible observation. That observation is attached before accepting or refusing it.
Permission re-entry taps the product's enabled Allow access once; denial or an incomplete gate still fails.

The identity-backed bubble is mounted as soon as the player/game seed is known, before any claims. It has no
heading or game label. Claims fly into it as orbs. The screen opens it automatically when every settled claim
has flown in, after ten seconds from landing with something collected, or on the first claim after that wait.
A tap opens it earlier once something is collected; empty and early taps are ignored. Continue becomes usable
as soon as the bubble opens, before the pieces finish staging; popping pieces is optional play, so the page has
no opened marker. Jollity's 60-second backstop, armed when the chest page opens, also offers Continue on a bubble
that never opened. The lab marks its entry before the page mounts: a Continue first seen within 60 seconds of it
is recorded as `reveal: "opened"`, a later one as `"backstop-or-late"` (not a revealed chest), and a nothing
screen as `"nothing-screen"`. Credits are still asserted on chain separately. One earlier path also gives
Continue on a closed bubble: it lands before anything is read, the collection wait (10 s) shows "Taking longer
than usual", and claims then arrive. The lab waits through that notice and records when it showed
(`longWaitShownMs`, and `longWait` in the return evidence); a Continue after it is recorded as `"backstop-or-late"`,
since the bubble may never have opened. A read that misses the notice records `"opened"` just before the bubble opens
on the first claim. After a long wait, preparation stops at the first usable Continue even on an unopened bubble, so
the return may close the album before the game settles and Jollity may not mark the chest seen.
The lab reads ancestor opacity and pointer events so a hidden footer never counts as a usable exit. It uses trusted scene clicks at most once per second while
waiting, and never clicks Continue in the held-results step.

The copied post-game helper follows the same current UI, including a bubble that opens automatically. Its
separate return action takes the footer's Continue into the album, then the album's Continue out to Humanity.
The album's button is scoped explicitly because the underlying footer also says Continue. A refused host
hand-off may restore that album control; only fresh host navigation evidence proves a return. Preparation
rejects an already-closing album, identity loss and restart screens. Both walkers wait through the long-wait notice
and never take its skip; at the deadline the error says the skip was offered.

The existing 180-second bound covers entry and opening, clips scene input to at most one second and the
remaining budget, and reports the last unmet condition and opening-attempt count on timeout. A mounted scene
alone still cannot pass. Offline controls execute today's real DIM2 frame loop and pure screen reducer with
drawing stand-ins: an empty bubble stays shut through three simulated minutes and taps; arriving claims can
open it by a tap, on settlement, or after the collection wait. Continue is proved before final staging.
These controls do not establish live canvas, host navigation or chain success.

Before recovery navigation, the flow attaches the current path, native navigation records involving that actor's
DIM2, and front-door/reload entries since its first observed payoff view. This build's log is the existing debug
UI's current-page ring, not the copied reader's obsolete IndexedDB store. Messages and payload fields are strictly
projected before attachment; arbitrary text, query arguments, secrets and machine paths are discarded. The current
ring has a250-entry cap and does not recover earlier-page host storage. app.self_reload, app.self_reload_away_ms
and app.self_reload_suppressed are Sentry metrics, not devLog tags; the telemetry-disabled source profile marks
those unavailable rather than inventing empty metric evidence. No raw debug export is published.


The pre-recovery path and documentSignals are read in one page evaluation after the debug sheet opens. Signals
include finite performance.timeOrigin and its comparison with the payoff timestamp, numeric navigation type
(0 unavailable/unknown,1 navigate,2 reload,3 back_forward), self-reload stamps since payoff (count/latest),
postGame presence, crash-reload integer, and the full current UI ring count/oldest timestamp. New signal values
are numbers/booleans only. Unavailable/invalid values have explicit flags and -1 sentinels; no storage text,
URL/query, identity or navigation-entry payload is exported. The UI ring's date is reconstructed from its local
time-of-day stamp; earlier-page storage remains outside its coverage. A permission re-prompt is evidence of a
lost stored grant, not routine noise. See the diagnostic-run hand-back for the classification table.


## Registration and gameplay readiness

`registration.ts` waits up to 180 seconds for the current actor's enabled lite registration control or finalized
registration. An earlier Open observation can precede DIM2's asynchronous redirect to its permission gate. The
wait handles that gate with one enabled Allow access attempt, rechecks the view and finalized game guard before
input, and attempts registration at most once. After a click, including an ambiguous timeout, only finalized
Game.Players registered=true completes it. An existing Joining or Saving your seat state is observed without a
second registration click. Native PAS requests, app failures and cancellation remain fatal. Timeout evidence
names the actor and the last safe UI state; the error says which condition never became ready.

The gameplay loop gives an unreadable tile verdict and a disabled Confirm votes with all verdicts decided up to
15 seconds to resolve, using `ui-readiness.ts`. It never taps an unreadable tile, arms a disabled confirm or adds
a fixed startup delay. The existing condition polls, report deadline and gesture spacing remain in force.
Offline controls run the real registration group and serialized gameplay DOM reader with delayed, permanently
blocked and changed-before-input views. Restoring the old checks makes those controls fail. These are synthetic
controls; the next complete fork run is still required.


## Browser navigation event evidence

`navigation-capture.ts` installs passive Navigation API navigate and window pagehide listeners with one page
evaluation per actor after step 12 observes payoff, then again immediately after step 19 reopens the chest.
Listeners never intercept/cancel navigation or change the UI. They write only `product-lab:dim2-navigation:v1`
in sessionStorage, at most 64 rows, with a dropped-row count. Reinstalling in the same document/phase adds no
listener or duplicate install row. Missing APIs, blocked storage, invalid data and failed writes are explicit
coverage flags. A replacement document preserves the key but needs the second installation for new events.

Rows contain numbers and booleans only: kind (0 install, 1 navigate, 2 pagehide), epoch at and document origin,
phase (1 payoff, 2 reopen), destination/current path class (0 other/unknown/foreign origin, 1 root, 2 chest,
3 prize-draw), navigationType (0 unknown, 1 push, 2 replace, 3 reload, 4 traverse), userInitiated, hashChange,
persisted, sameOrigin and navigationAvailable. No raw URL, query, identity, error text or storage payload is
returned. The existing atomic N2 path/document snapshot is unchanged; its step-19 attachment gains the trail
beside documentSignals. That extra read is separate from the unchanged N2 evaluation: compare origin with
documentSignals.timeOrigin before pairing observations. A final trail is attached when the results wait exits, including on timeout.

Read the trail with the existing N2 document signals and host rows. A missing, malformed, unwritable, unavailable
or evicted trail is indeterminate; absence of an event only has meaning within a recorded coverage interval. Listeners do not survive a document
replacement; do not attribute events in the gap before installation or after a later document loses coverage.

| Valid evidence in the captured interval | Mechanical reading |
|---|---|
| A navigate to same-origin root before pagehide, push/replace and not user initiated | Page script started it. Next's MPA fallback can be triggered by bad harness response headers; inspect the HTTP response before assigning a product cause. Read navigation kind/userInitiated/hashChange too. |
| Pagehide with no preceding navigate, after an available listener install | Browser started the document load: host or environment; this capture does not split those two. |
| Phase 2 navigate toward chest, then root/pagehide | The reopened held chest was sent on or navigated away again; event order, kind and document origin show the path. |
| Phase 2 stays at root with no navigate/pagehide through the final snapshot | The held chest was not sent on during that observed interval. This says nothing about a transition before listener installation. |

The capture alone does not assign cause. The MIME diagnosis below applies to f2668a89. VM
serialized-callback controls use real EventTargets and isolated document realms; the actual step-12 loader also
executes the serialized callback. Actual results-step controls verify install ordering and a final snapshot on
timeout. Existing identity, credit, deadline and wrong-credit checks remain unchanged.


## Static-export media types

Next's non-prefetched static-export navigations fetch route `.txt` RSC payloads. They must have a text/plain (or
text/x-component) content type; application/octet-stream makes the client fall back to a full document load.
`lab/shared/static-server.mjs` serves them as text/plain; charset=utf-8, including index.txt and segment-prefetch payloads.
The retained-export sweep also adds the actually present GIF, ICO, gzip, source-map JSON, OTF and video/YAML
media types. Existing script, JSON, CSS, SVG, WASM and WOFF2 types remain unchanged. Raw TypeScript worker assets
are not executable JavaScript; their missing build transformation is a separate low and the generic fallback
remains. No speculative mapping is added for absent webmanifest or other extensions.

Controls replay the retained RSC requests through real owned loopback HTTP listeners and execute the installed
Next client's response-acceptance gate. Removing the txt entry restores octet-stream and MPA fallback. This is a
harness MIME fix, with full router/browser/fork qualification still required; the navigation-event initiator alone
does not establish a product bug. The reviewed N2 and navigation capture code are unchanged.


On 2026-11-04, round 13 addresses the step-2 Reporting import refusal at 73ec2936. The cleanup snapshots the
import and schedules, removes only those schedules with the existing finalized runtime calls, then polls the
same imported game's finalized state before the unchanged cancellation guard. Reporting advances through
PlayerProcess and disappears under block hooks after report_ends (or earlier when attendance is settled);
Timestamp supplies the runtime clock, and no player call is required. No time, game storage or runtime is edited.
The budget is the finalized remaining reporting time plus 180 seconds of processing/finality slack, capped at
65 minutes; PlayerProcess and imported Cancelling get 180 seconds. Polling stops as soon as the guard accepts.
Timeout names stalled finality, chain time still before report_ends, or incomplete runtime processing, with the
last finalized head, state and times. Replacement games are refused, and only Registration or Shuffle can be
cancelled. The owned-fork, endpoint, Sudo authority and final empty-state checks remain mandatory.

Step 2 has a 75-minute outer bound; other custom steps retain 15 minutes. The advisory journey and job bounds
are 120 and 180 minutes to accommodate a full imported reporting window plus the existing flow and cleanup.
External qualifier preemption is unchanged and may end a long wait earlier. Fifteen new offline controls use
synthetic finalized observations, cover advancing/early/stuck states, cancellation, malformed time, replacement
games and authority refusals. Restoring the parent helper and disabling only the wait both reproduce the exact
original Reporting error and fail the advancing control. No live completion or full-flow pass is claimed.


On 2026-11-04, round 14 supersedes round 13's remove-first cleanup. Step 2 waits for an import past Shuffle
before removing any schedule. A replacement is handed to step 3 only in empty Registration (next_player_index
and pending_attendance both zero), at imported index plus one, with a game_date from the original schedule
snapshot. Other replacements refuse with the mismatched condition. With no promotion, only the original
schedules are removed. The completion bound, finalized reads, timeout reasons and exact cancellation guard
remain unchanged; promotion is checked again during removals and final verification.

The next live attempt at 73ec2936 reached step 3 with an already promoted empty #308 and failed its inner
atomic dispatch. The lost receipt prevents identifying the live DispatchError conclusively. Pinned pallet
semantics reproduce Game.InvalidGameState at set_game_phases after cancel_game: cancellation always stores
Cancelling, even for an empty game. Merely moving the phase call earlier still conflicts with scheduling over
that game (Game.InvalidGameSetup). The current schedule vector already excludes the consumed promotion date.

Step 3 now removes remaining schedules and cancels the validated empty game in one cleanup batch, waits at
finalized heads for absence (180 seconds, with abort and unexpected-game/schedule refusals), rereads authority
and state, then submits one provisioning batch. Provisioning requires absence. An idle fork still needs only
one batch. A failed batch never triggers a retry or fallback. Decoded receipt failures are projected to safe
variant names and attached to the step as atomicSetupFailure before the executor throws and private run cleanup
can delete its journal. Error messages include the decoded name, with no deleted-journal path.

Offline validation passes: 199 flow controls in 26 files, flow typecheck/check/lint and both binding plans,
Humanity lint/typecheck and actionlint using PATH Node 24.22.0. Controls cover both promotion timings, planner
compatibility, all hand-off refusals, completion/cancellation timeouts, split setup, already configured phases,
and inner/outer error attachment survival. Restoring the old step-3 implementation reproduces the original
inner-dispatch failure; restoring remove-first order makes the mid-loop control remove two schedules instead
of one. Disabling the completion wait, dropping hand-off acceptance and dropping the failure attachment each
fail their targeted controls. No live completion or full-flow pass is claimed; independent review and fresh
qualification remain pending. No framework, product behavior, dependency, runtime or qualifier was changed.


## Custom-step demo recording

The 2026-11-04 CI probe passed 22/22 journey steps, with a 27 min 25 s build/journey step, but made no demo.
In product-lab 0.1.0, generic feature recordings began with declarative action/assertion run events. This
feature has identity setup followed by custom Cucumber steps, so browser recording created the six page videos
without creating the feature `recording.json` the cutter expects. Product-lab 0.1.2's recorder follows custom
steps and may save its own recording of this feature beside the app's; the cutter takes only the app-owned
record (`humanity-dim2-custom-flow`), so a run still gives exactly three actor demos.

The app now keeps `flow-capture.json` privately in the current run's recording directory. It measures actor
creation and each custom-step body's wall-clock start/end, and obtains every page's real filename/opening time
from `PageFrameCapture.video` while the page is open. Before wrapper cleanup, those spans are matched to the
actual scenario report and selected feature. `RunRecording.from` validates the private feature record used by
the existing cutter. Verdicts come from the report; missing/mismatched timings, unknown verdicts or absent app
videos refuse recording. No filenames, successful assertions, frames or chain evidence are invented.

Product-lab 0.1.2 makes a demo of held stills and places each step's still only inside its video: a step
ending on the video's last instant is refused. The flow therefore notes when session cleanup begins (every page,
so every video, is still open then) and gives each video that time as `closedAt`, a measured lower bound on its
end. `demo.mjs` runs each actor's last page to that close instead of cutting it at the last step, and the
stitched recording carries the stitched end. A run that never reached cleanup keeps no `closedAt`, and a close
before the last step is refused, so the last step's still is never invented.

The feature is `@isolated`. Product-lab 0.1.2 restores its starting state after the scenario by closing the
populated session and opening an empty one. Closing that empty session must not overwrite the measured
manifest. `FlowCapture.closing` writes only after an actor started in that capture. The regression in
`tests/flow/recording.test.mts` replays this lifecycle and still plans all three demos. Missing timings in an
actual actor run remain a refusal.

The private manifest and record are excluded by the video-only upload paths. The uploaded scenario projection
still omits errors, transactions and attachments. Demo cutting remains advisory. The step summary, fixed
`demo-status.json` and PR section explicitly distinguish **Demo: produced** from **Demo: not produced**, even
when all journey steps passed. A successful cut without an uploaded artifact also says not produced.
Offline controls reproduce six raw videos with no feature record, execute the wrapper's real finally block,
then validate three actor edit records through the installed store and demo planner. They use video/editor
stand-ins and establish metadata/planning correctness, not a new CI media cut.

The shared post-game UI walker also accepts an optional `onControl` observer on `returnFromDim2`. It reports
the page-clock-compatible wall mark immediately before a successful trusted exit control, with its path and
name. The cross-app C4 lab uses the last such control before the host navigation for its separate hand-back
CTA timer. Earlier chest/claim steps remain part of the game-end journey rather than being labelled navigation
latency. Without the observer, existing callers keep their behavior and evidence shape.


### Imported schedule race adaptation

The vendored imported-game drain handles a schedule consumed between a finalized read and dispatch. Only a decoded
`Game.NoSuchGameScheduled` with absence proven at the receipt block is accepted. An empty Registration promotion
must still match a snapshotted date; populated and unrelated replacements fail. The incremental patch against the
previously adapted vendored file is recorded in `patches/humanity-jollity-scarcity-e2e/manifest.json`, and the
updated file digest is in `UPSTREAM.json`. No application or framework code changes.

Shared helpers and the imported `upstream/` tree now live in the private root lab workspace. Paths above beginning `lab/shared/` are repository-relative. See [the shared lab guide](../../../../lab/README.md); this flow, its features and its tests remain in Humanity.

The existing `post-game.ts` entry now re-exports `lab/shared/post-game.ts` at the repository
root, so the flow and Jollity-only scenarios use the same chest observation and walk.
The flow API, return controls and test cases are unchanged.
