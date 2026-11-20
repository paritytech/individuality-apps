# Humanity scenario helpers

The lab drives the People runtime directly while Humanity remains the only app under test.
`GameRepository` supplies enrollment, shuffle, reports, date retiming and completion. New helpers
in `chain-plan.ts` and `chain.ts` add short schedules, strict Score decoding, forced attendance,
Membership ring checks, daily-draw funding and finalized claim evidence. `target.ts` admits only
an owned local copy or the local genesis chain with individuality-community v0.3.4 runtimes.

Storage reads use the flow's historical reader at an independently acquired finalized hash.
Sudo batches verify ownership and the current authority, then require inner dispatch success
and every batch item completion. Product-account derivation is checked against the host's
index-1 derivation, including its domain-separated soft junction.

`observations.ts` reads accessible copy and attendance marks. Its MutationObserver retains
transient next-game dates. A2 finalizes its setup and waits for the app to confirm the scheduled
game before installing that watch, still before gameplay. An earlier schedule-only view is a
future game awaiting the app's poll, not a finished date reappearing. The history assertion
continues to reject every old-date upcoming sample during the watch and every old date after
the next schedule finalizes. Name proofs compare Resources and DotNS against the linked identity
account; the transaction submitter is a separate product account.

Run helper tests from the repository root with Node 24 first on PATH:

```sh
cd apps/humanity-app
nice -n 10 ../../node_modules/.bin/vitest run tests/scenarios/chain-plan.test.ts tests/scenarios/chain.test.ts tests/scenarios/target.test.ts tests/scenarios/observations.test.ts --maxWorkers=1
```

Tests encode the new root calls against the committed People spec-3004000 metadata. They use
synthetic chain reads and a DOM, and start no chain, host or browser. Negative controls reject
wrong attendance counts, a wrong claim destination or extrinsic, a swallowed inner failure,
and an unexpected purse answer. Each CI run's summary records which rows passed, failed or stayed pending.

## Full and fast chain setup

`HUMANITY_SCENARIOS_SETUP` selects how the lab sets up chain state (`setup-mode.ts`). Unset, or
`full`, is the nightly's real setup and today's behaviour. CI sets `fast` for pull requests only.

| | Full (nightly, dispatch, local) | Fast (pull requests) |
| --- | --- | --- |
| Lab setup transactions | Each waits for finality (executor `finalized`) | Each waits for inclusion (executor `checkpoint`) |
| Finality | Per transaction | One checkpoint per setup run: before the first When or Then step (a `BeforeStep` hook), and inside a step before the app must show a lab write (member fixture, forced attendance, draw, next schedule) |
| Setup reads between lab rounds | Finalized head | Best head (`ScenarioChain.setupRead`) |
| Assertions and app-facing reads | Finalized head | Finalized head |
| Member (A4, A5, A6) | Two real games (A4 a third), the app's `Score.register` | One root batch (threshold, phases, a game open for registration, the players' funding), Ada's real sign-up, one root batch of `Score.force_set_attendance` on the indices just below that game; the app's `Score.register` and ring inclusion stay real. A4 keeps the game for its real miss; A5 and A6 cancel it in the same batch |
| A5's third attended game | A real game | One more forced mark |
| A real game (A2, A3, A4's miss) | Schedule, funding, sign-ups, shuffle, reports one after another, the date retime | Funding folded into the schedule's batch, sign-ups and reports in parallel, no retime |
| Imported-game drain | One finalized call per schedule, then the cancellation | One root batch of every `remove_scheduled_game` and the `cancel_game`, then the checkpoint and a finalized idle check. With no imported game (a schedule may be promoted meanwhile) or a game past Shuffle, the sequential drain runs |
| A6 draw window | Registration +60 s, draw +240 s | Registration +15 s, draw +90 s |

The fast setup never writes raw storage (`System.set_storage`), never sends `Score.register` for
the app, and A3 keeps its real games and promotion. The member fixture checks the record it leaves
(`assertAttendance` against the record after the real sign-up, `reached_personhood`, still
`NotRecognized` before the app registers) and fails the step otherwise. The Game pallet's report
path in A4-A6 is covered by the full setup only.

**What if an inclusion-only block is lost.** A setup transaction is signed at the finalized head
and resolves when a best block includes it. If a best-block reorg drops that block, the transaction
goes back to the pool and is usually included again in a later block, so its effect arrives late.
If it is not (its nonce, era or call became invalid), its finality watcher fails, the executor
records the failure, and every later submission and the next checkpoint throw: the step fails
loudly, it does not pass on state the chain lost. A setup read at the best head may see state from
the lost fork; it decides only which setup call to send next, and every result the app is asked to
show is read again at the finalized head after the checkpoint. The node's records note best-block
losses on Bulletin (8-9 Oct: signing at the best block lost 9 of 505 stores, signing at the
finalized head lost none), which is why the lab still signs at the finalized head and waits for
finality before every app check. A copy's best and finalized heads differ by about three relay
blocks, so a lost inclusion costs a retry, not a wrong pass.

**Unpinned reads.** polkadot-api's typed reads accept a block hash only while its chainHead
subscription pins it. `GameRepository`'s polled waits read at a finalized hash from plain RPC, which
can already be unpinned: A4 failed that way in run 2, attempt 3 (`BlockNotPinnedError`,
chainHead.ts:138, in "Completed game processing"). `ScenarioChain` gives the repository a connection
whose waits poll again on the newest head after an unpinned read (`unpinnedTolerant`), and the
draw's winner read and the full setup's funding and retime retry the same way (`retryUnpinned`;
the retime only before its transaction was sent; each retry pauses 1 s, and an abort ends the pause
at once). `ScenarioChain.read` uses plain RPC storage reads and is not affected.

**Known limits of the fast setup.** Both fail red, never green:

- A4 keeps the member fixture's game for Ada's real miss, and that game plays 600 s
  (`memberGameSeconds`) after it is scheduled. Ada's recognition and membership waits (up to 600 s
  each), the "Not now" dismissal and the grace step all come before the lab forces the game's
  shuffle. If they take more than about nine minutes, the game leaves Registration with only Ada
  signed up and the miss step fails. Run 3 measured A4's whole Given block at 209 s.
- The one-batch drain plans from a best-head read. If the imported game moves past Shuffle between
  that read and the batch's block, about one inclusion round, `cancel_game` fails, `batch_all`
  reverts and the leg fails instead of falling back to the sequential drain. The failed batch also
  stops the run's executor (every later submission refuses), so a fallback in the same run would
  not be safe.

## The scenarios

`lab.scenarios.config.ts` exposes only Humanity, with the existing opening assertions and the
new `steps.ts`. Every scenario starts with a dedicated imported-game drain, before creating Ada.
The session takes locality from the framework-resolved `context.offer`; product-lab 0.1.0's
running Paseo environment omits its own offer (the 0.1.1 and 0.1.2 release notes do not change this). The target guard still requires local exactly
true, an owned network, schema 1 and owned session data, with no fallback to true.
That admission step has its own 75-minute outer timeout and a default three-minute reporting
wait (`HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS=180000`). It verifies that the chain is idle.
Scheduling inside gameplay never repeats the imported-state wait. Only known transient import-state refusals record
`not run: imported game drain: ...`. Ownership, endpoint, signing connection, sudo-key,
invalid-clock and finality-stall faults remain failures; unknown errors also fail. There is no Jollity app session in the Humanity-only config. The opt-in cross-app config also starts a bounded, timestamped sign-up console history before opening either app; see `../cross-app/README.md`. Ada uses a fresh attested host identity;
the two lab players are fresh signing accounts. A command containing several scenarios retires
the previous Ada's host before creating the next one.

| Tag | Feature | What it checks |
| --- | --- | --- |
| A1 | `a1-registration.feature` | Transaction registration appears in Humanity, including after reload |
| A2 | `a2-next-game.feature` | GameEnded, post-game state, the next scheduled date, and a continuous date watch |
| A3 | `a3-promotion.feature` | Two real attended games, automatic personhood registration, promotion and the full name on both chains |
| A4 | `a4-suspension.feature` | Three-game member setup, a real missed game, caution, and a forced second miss causing suspension |
| A5 | `a5-attendance.feature` | Three five-mark patterns, compared with the entire eight-bit chain history and rendered row |
| A6 | `a6-daily-dollar.feature` | A funded single-winner draw, finalized claim, Unsupported tripwire and account-0 balance increase |

The A5 examples count the member setup's three real games: each row has six attended and two
missed marks. The five-character pattern remains the suffix being written. The two-game
promotion threshold is configured to three on the owned lab chain. After A2 schedules on an idle chain, the runtime creates Game.Game in Registration immediately,
so it requires finalized Registration and the registration-open UI with the correct date.
Tests reject a wrong chain date, a wrong UI date, upcoming UI, and upcoming-only history.
It also accepts `no-game` immediately after GameEnded:
that is the source's result after GameEnded with no later schedule. Scheduling steps say
“playing in”, because registration must already be open when Humanity first checks it. A1
plays in 480 seconds, leaving a 420-second registration phase. A3 attaches Included Membership
evidence before waiting up to 600 seconds for the name field. Its confirm tap waits for the
armed hint and a page-clock condition 550 ms past observing it; the app ignores confirms inside
500 ms. A4 accepts only the deadline
forms `Play today to keep it.` and `Play tomorrow to keep it.`, never the no-deadline fallback.
After A2's next schedule finalizes, any old-date sample fails regardless of its mode; the
attached finalization timestamp uses the same Unix-millisecond clock as the page samples.

The pinned CLI host does not support the Coinage purse. A6's final step remains exactly
`Ada's Coinage purse grows by the prize within 60 seconds`, pending with reason
`host coinage purse unsupported`. The Unsupported tripwire runs before the balance assertion.
A supported host must fail that tripwire, prompting the purse assertions to be enabled.
The expected current result is the claimed prize remaining on product account zero.

`pending-purse.ts` restores Cucumber's pending return for that one custom sentence. The pinned
framework discards custom-step return values, so the bridge is installed at the bundled
Cucumber definition boundary. A direct in-process run refuses this terminal step instead of
reporting a false pass. `report-contract.ts` accepts the A6 result only when every earlier
step and represented hook passed, the last step is pending, and its exact reason was attached.

## Failure evidence and running-copy follow-up

The bundled runner installs a Cucumber AfterStep hook before the framework closes the page.
A failed step, including an outer timeout or a reused opening step, gets a PNG through
PageFrameCapture and the report's binary attachment API, plus visible text, URL, dialogs, card
markers and a finalized Game.Game chain read. A cheap accessibility snapshot is attached when
the adapter exposes it. The app console comes first (`humanity-failure-console`): every page's
console lines and uncaught errors, kept in memory per actor and `context-N/page-M`, cleared for each
new Ada, and sanitized when recorded (`lab/shared/console-history.ts`). Sanitizing removes:

- a whole line that names a mnemonic, seed phrase, secret key, private key, password, passphrase or SURI,
  checked after control characters are removed;
- a run of 12 or more English BIP-39 words, in any case, with at most 8 characters other than letters and
  whitespace between two words (commas, quotes, brackets, numbering, `<br>`); whitespace never counts, so
  pretty-printed JSON is caught;
- a URL's path (kept only as `/`, `/<asset>` or `/<path>`, as in the network evidence), user info, query
  and fragment, also for scheme-less `//host` URLs; `file:` URLs whole; and the query after any `?name=`;
- local paths that start a token under `/Users`, `/home`, `/private`, `/tmp`, `/var`, `/opt`, `/root`,
  `/Volumes`, `/nix`, `/run`, `/srv`, `/mnt`, `/usr`, `/etc`, `/Library`, `/System`, `/Applications`,
  `/workspace`, `/github`, `/__w`, `/runner` and `/builds` (any case, also percent-encoded), `~/`, `~name/`
  and Windows drives; a root name inside a relative path (`GET /api/users/…`) is kept;
- email addresses;
- the rest of an `authorization`, `cookie` or `set-cookie` line, bearer values and JWTs;
- the value after a token, auth, API key, access key, private key, client secret, secret, session id, sid,
  JWT, DSN, sig, signature, entropy, seed, sk, OTP or PIN name, quoted or not (escaped quotes included), in
  JSON or not; after a colon, one bare lowercase word of up to 16 letters is kept (`signature: expected`,
  `token: missing`);
- the value after a bare `key` or `session` name at a word start (not `list-key` or `public_key`), only when
  it looks like a credential: 8 or more characters with a letter and a digit, or 16 or more characters
  (`storage key: Game.Game` and `session=12` are kept);
- every hex run of 32 or more characters, even glued to letters or `_`. That includes block and
  transaction hashes, hex public keys and H160 addresses. All-decimal numbers are kept;
- encoded runs of 80 or more characters, and of 40 to 79 that mix upper and lower case, such as 32-byte
  base64 or base58 keys (SS58 addresses, 46 to 50 base58 characters, are kept).

Every rule that can start inside a long word has a left anchor, so a 20,000-character line is sanitized in
about a millisecond. A line longer than that is cut before sanitizing, loses its partial last token, and
says how many characters were not scanned. IP addresses, numbers, codes and ordinary sentences are kept.
Bounds: 500 characters a line, 200 lines a page (the first 20 and the newest kept), 16 pages, and 48,000
bytes for the whole attachment. An app that logs its own refusal, such as
`username upgrade failed; code="lite-owner-unavailable"`, is then named in the report instead of only
a timeout.

Known limits. These secret shapes are kept: hex written in groups (`abab abab …`) or bytes as a decimal
list; camelCase compound names such as `miniSecret:` or `seedHex=`; a two-part `eyJ…` token; a path
segment of a relative path (`GET /invite/<token>`) or of a scheme-less `host:port/path`; a Windows UNC
path; a mnemonic with a misspelled word; and one lowercase word of up to 16 letters after a colon
(`secret: hunterhunter`). These are removed though they are evidence: hex hashes and keys (above), and
camelCase names of 40 or more characters (`<blob N chars>`). Loopback URLs keep host and port and gain a
trailing `/`.

Capture is bounded; unavailable pages and capture errors are explicit gaps, and diagnostics
preserve the original result. A pending purse step remains pending without a failure capture.

A3 follows the source's host-name convention. `MemberCard.memberDisplayName` trims the supplied
primary username; `linkedCardIdentity` preserves a host suffix when present and preserves its
absence. The pinned host's unsuffixed lite name therefore becomes an unsuffixed member name.
The scenario checks that exact card name and independently proves the bare label's Resources
owner, Consumers full username and Asset Hub DotNS entry on chain.

Scenario reporting admits the exact scheduled game already in Reporting only after checking
its player count and all three distinct indexed accounts at one finalized block. Otherwise it
forces shuffle. An inner dispatch failure is accepted only if the dispatch block proves that
same Reporting game and group, followed by an independent finalized check. Any other state,
game or group fails. Both force-first and deadline-first orders have offline tests.

A3 waits for Recognized, Included Membership and the enabled name-choice control within a
shared 600-second budget before clicking. The final button wait also covers the app's pending
membership-root gate. The A2 mutation callback remains anonymous under tsx's keepNames transform;
the regression check sweeps every scenarios browser callback for unavailable __name calls.

A4 and the attendance poll dismiss an actually open urgent caution sheet through its normal
Not this week button. Run 4's captures established that member setup had instead left Ada on
the name-claim screen.
After the promotion's Not now and the Member label check, setup now waits for that claim screen,
uses its own Not now control, and asserts humanity-home is visible before proceeding.
These heading, back and home waits share one 600-second budget, including ring-root readiness.
A5 records whether a sheet was dismissed, including false before a poll that might time out.
The wrong-count control requests nine attended games in an eight-mark row, which no prefix of the history can produce. Readiness polls the complete finalized byte, streak, summary and game anchors for up to 45 seconds. It records the last row on a timeout, which remains a real failure and cannot qualify the control. The correct expectation and the wrong count are applied only after readiness. The control is tested
through the actual attendance step against the app's rendered row; the strict report classifier
still rejects a timeout as the wrong failure reason.

The runtime removes a draw with zero registrants when registration closes. A6 now records each
draw-state transition and, if the event disappears, the prior state plus indexed cancellation
evidence. The app already auto-registers from the home; the later scratch navigation alone is
not its registration trigger. The old member setup left the home route, unmounting its background
registration hook. Returning
to the home keeps that hook active. Scheduling and registration proof behavior are unchanged;
A6 still requires running-copy qualification.

## Browser outbound policy and evidence

`network.ts` wraps the pinned Playwright adapter at the scenario session's browser launch.
Every new context installs its request, completion, failure and service-worker listeners,
HTTP routes and passive native WebSocket observation before creating a page. No WebSocket
routing is installed. Context and page routeWebSocket calls are refused, because Playwright
routing replaces the native constructor and leaves binaryType inherited; the pinned host
captures its own prototype setter during bootstrap and cannot initialize a client without it.
Service workers are blocked; the framework's CDP observer holds dedicated workers. The original adapter page's
`networkEvidence()` is sampled after every step and in the After hook, preserving its
before-navigation flag, worker coverage and gaps. An unfamiliar browser adapter is refused.

Only exact localhost, 127.0.0.1 and IPv6 loopback hosts are allowed. There are **no allowed
outside hosts**. Outside HTTP requests are aborted by the context route. Native outside WebSockets are
blocked by the resolver and deny proxy and classified as blocked by the passive observer.
Any sent or received frame on such a socket increments outsideSocketFrameViolations; it is
a violation rather than a successful denial. Only byte counts, never payloads, are retained.
Sentry envelope POSTs are answered in-process with 200 and never forwarded. Sentry preflights
are answered locally too. The sink recognizes ingest.sentry.io regional ingest host patterns,
including the regional host shape found in the outbound study's served bundles, without
keeping a DSN key or project id. It records only host and envelope byte size. This config
opens only workspace Humanity; its build already sets VITE_SENTRY_DSN empty. No Jollity or
UID app is launched and no telemetry setting or application behavior was changed.

A loopback HTTP deny proxy is the browser-level backstop, covering HTTPS CONNECT and literal
IP requests as well as HTTP. Chromium receives that proxy, loopback bypasses, a fail-closed
host resolver, disabled background networking/QUIC and disabled non-proxied WebRTC UDP.
All proxy requests are denied without forwarding, including Chromium background requests.
Rejected proxy targets retain their syntax class (absolute, CONNECT authority, origin,
asterisk or unrecognized), scheme when present and canonical authority only. Origin-form
has no scheme in its request target; its sanitized Host authority is labelled as a host-field
hint. No raw target path, query, credentials or header value is saved. A CONNECT target has
no raw scheme either; it remains grouped under HTTPS in the host counts.
The headless control additionally runs inside a loopback-only operating-system sandbox, so
mutating a browser guard cannot let its fixtures contact an outside server.

Under `--video` the guard builds each context with the pinned adapter's own context options and
page watch, so each actor's page records to `<PRODUCT_LAB_RECORDINGS_DIR>/videos/` and the run's
recording links it, as in the opening. The service-worker block is applied after those options;
routes, proxy and resolver rules are unchanged. `tests/scenarios/network-video.test.ts` proves the
file and link, with a recording-off control.

The private run folder holds requests-ada-N.jsonl, sentry-envelopes.jsonl and
network-summary.json until normal session cleanup. The report attachments marked
humanity-scenario-network retain sanitized request records, host counts, per-tag attempted,
blocked, allowed, locally handled and pending totals, plus the framework page record and gaps.
Extract these attachments for each tag, including a failing tag and A5-control. Outbound
attempts include locally handled Sentry and the proxy's background observations. Counts are
observations at each layer; if a context request reaches the proxy, both may appear. Do not
treat the sum as deduplicated wire connections. Setup attempts have tag unassigned. A5's
outline examples have separate Ada ids under their shared tag.

Records contain timestamps, tag/actor/app, a page id, origin, finite path class, method,
status, sanitized failure code and body byte counts when available. URL credentials, query
strings, bodies and headers are never retained. Headers are excluded from byte totals;
aborted requests and worker socket payload bytes may be unavailable. Native host, chain and app
server traffic, DNS and browser internals are not fully observed. The summary always marks
full coverage false. Requests after the last After-hook snapshot, including actor stop and
browser shutdown, remain denied but are retained only in the run folder deleted by cleanup;
proxy requests while a previous actor stops can carry the next tag. Loopback redirects to
outside can appear as pending plus a proxy denial. SharedWorker requests may appear only as
deny-proxy records on page browser. A zero allowed count is not a statement that no request was attempted
or that nothing left the machine; make no such claim from this evidence.

The actual identity channel is TCP, not a custom browser protocol or DotNS hostname. The
framework starts the signing host with --frame-listen 127.0.0.1:<allocated-port>, reads its
http://127.0.0.1:<port>/bootstrap.js, and serves the bootstrap through its same-origin app
proxy. The host bootstrap supplies the corresponding ws://127.0.0.1:<port> URL; the shared
container opens its binary SCALE transport and exposes __HOST_API_CLIENT__ and the legacy
MessagePort. account.getUserId and connection status travel through that channel. Run 6 used
app port 40001 and bridge port 42010. No *.localhost host is used by this scenario, so the
exact-loopback resolver and outside-host policy are unchanged.

The primary offline browser control reads the locked host version's container.js from the existing
nightly host cache, serves it as bootstrap.js on loopback, and requires __HOST_API_CLIENT__,
no page error, one socket and a binary frame at its local frame sink. No cached file is
modified or downloaded. The full container, not only a transport-shaped mock, exercises the
host lockdown. A supporting control bundles the installed createHostConnection implementation
and exchanges a real handshake and getUserId response with a synthetic loopback frame server.
Both fail when raw WebSocket routing is reintroduced. Another control serves a service worker,
tries registration and reloads; no controller or unexpected service-worker event may appear.
Allowing the service worker must fail it. These are loopback fixtures, not an actual signing
host or live scenario qualification.

## Commands

From the repository root, with Node 24 first on PATH, reuse the shared nightly cache's existing
fork bundle and keep the fork directory inside the worktree. The fork bundle must never be
downloaded again. A new run copy's template.partial is the framework saving its network
template, not a bundle download. Watch bundle names only: *.tar.gz, fork-bundle*.partial,
fork-bundle*.incoming and fork-bundle-*.curl.log. A broad *.partial watcher is incorrect. A fresh worktree cache would require that download; do not use one.
The pinned product-lab 0.1.2 honours `PRODUCT_LAB_FORK_BUNDLE=keep` (0.1.0 ignored it). As a second guard,
the scenarios config calls the opening config's shared `keepBundle()` shim before defining the
lab: it blocks Engine bundle asset reads, including the manifest range read that precedes a
background fetch or staging. Keep the variable set for every run. If the cached bundle is
missing or a run would download it, stop and hand back.

```sh
export PRODUCT_LAB_CACHE_DIR="$HOME/.cache/e2e-nightly"
export PRODUCT_LAB_FORK_BUNDLE=keep
export HUMANITY_SCENARIOS_FORK_DIRECTORY="$PWD/apps/humanity-app/.product-lab/scenarios-engine"
export HUMANITY_SCENARIOS_IMPORTED_GAME_WAIT_MS=180000
nice -n 10 node_modules/.bin/product-lab test --config apps/humanity-app/lab.scenarios.config.ts --tags '@A1' --own-lab
```

Replace `@A1` with `@A2`, `@A3`, `@A4`, `@A5` or `@A6`. At each provider start, the scenarios
config checks the marked complete cached Paseo bundle and existing prepared Engine, then allocates
a new run directory and a private empty seed directory below HUMANITY_SCENARIOS_FORK_DIRECTORY.
The full copy re-forks from the cached bundle; it cannot resume an earlier command or adopt a
shared first-boot seed. Existing copies and the bundle are retained. No fork directory is made
by lint/check/config import. A5's three examples share that command's fresh copy and run serially.
Use the Full copy only; no light-layout bite is configured. Never add `--keep`, `--refresh` or
`--update-runtime`. Missing or damaged cached bundles and automatic tooling preparation are
refused before the fork starts. The original keepBundle asset guard remains installed.
The pending A6 step makes the raw command exit
nonzero. Inspect its `product-lab-test.json` with:

```sh
nice -n 10 node_modules/.bin/tsx apps/humanity-app/scripts/lab/scenarios-report.mts a6 <report-directory>/product-lab-test.json
```

The import reporting wait accepts a positive whole number of milliseconds up to 3900000.
Use the three-minute bound above in a short slot. Its dedicated first step keeps import
admission separate from promotion and member setup. A refusal is never a successful scenario:
the raw run stays nonzero. `scenarios-report.mts` classifies every case before deciding the
report result. A real failure in any case or hook wins with exit 1, regardless of case order.
Exit 2 means every non-passing case is a qualifying admission refusal, with later product
steps skipped and all represented hooks passed. Do not turn that exit into a pass or treat a skipped setup as product evidence.

A6 is not a complete pass. This check distinguishes its explicit pending purse from a failed
chain leg, missing tripwire, failed hook or skipped setup. Use `passed` for A1-A5 reports.

Before allocating a fresh copy, the provider uses bounded read-only process inspection to find
command lines referencing older run-* folders below the configured parent. It refuses with
those PIDs and their TCP listening ports. It never stops them or opens recovering process
registries. An unavailable process inspector is a refusal; unavailable listener information is
reported alongside the known PIDs. Close the previous owned run through its normal lifecycle
and verify it is stopped before retrying.

## Removing old copies

After sealing the run's reports and confirming its processes are stopped, list the retained
copies from the repository root:

```sh
ls -d apps/humanity-app/.product-lab/scenarios-engine/run-*
```

Choose one exact owned run folder. Type its literal path in both commands below, replacing the
example run-Ab12Cd with the actual folder name. The first command must report no open files;
verify the run's nodes are stopped before deleting its state. An inspection error is not proof
that the folder is unused; resolve it before cleanup. The deletion is intentionally a
literal relative path: never use variables, command substitution, wildcards, find -exec or xargs
for removal. Never target the parent, cached bundle, Engine workspace or another run.

```sh
nice -n 10 lsof +D apps/humanity-app/.product-lab/scenarios-engine/run-Ab12Cd
rm -rf -- apps/humanity-app/.product-lab/scenarios-engine/run-Ab12Cd
```

This cleanup is manual; a fresh start neither kills older nodes nor removes their evidence or
state. It does not remove the legacy paseo-copy folder retained from earlier runs.

## Negative control

The negative control is opt-in:

```sh
nice -n 10 node_modules/.bin/product-lab test --config apps/humanity-app/lab.scenarios.config.ts --negative-control --tags '@A5-control' --own-lab
nice -n 10 node_modules/.bin/tsx apps/humanity-app/scripts/lab/scenarios-report.mts negative <report-directory>/product-lab-test.json
```

It must fail only at `Ada sees the attendance row:` with
`Attendance row differs from finalized chain record`. The complete command list, CI proposal,
source reads and raw offline logs are retained in the job report.

## CI

`.github/workflows/humanity-lab.yml` runs these commands as parallel legs beside the opening, each
on its own runner and fresh copy: A1+A2, A3, A4, one leg per A5 example and A6. A5-control runs
only by dispatch (`a5_control`). A3 runs again since the lab host moved to `@parity/truapi@0.31.0`, the
first release with trinity-user-agents#1974. A leg given a `skip` reason is still planned but not run,
with that reason in the run and the lab comment.
Pull requests take the fast setup; dispatched runs the full one.
One setup job looks up the published bundle's asset (`scripts/lab/scenarios-ci.mts bundle-lookup`:
the release API's required `sha256:` digest, without reading the archive), downloads it only
when no cache entry holds that asset, verifies the retained tarball's SHA-256 before extraction,
and pins the verified installation by manifest SHA-256 (`bundle-pin`). Network failures, timeouts,
HTTP 5xx and 429 restart the whole download, at most three attempts with two-second pauses.
Each attempt uses a fresh exclusive temporary file; failed files are removed. Other HTTP 4xx
and SHA-256 mismatches fail immediately. Retry logs name only the attempt and a fixed reason. A changed download is
refused with a request to re-run. Reports still read bite time from the installed manifest.
The asset cache keys and pin JSON format are unchanged; upload-time/size fallback keys are no longer accepted. Every leg
restores exactly that asset's entry and verifies the pin (`bundle-install`); a leg whose restore
misses re-fetches and uses the bundle only if its manifest is the pin. The entries stay for re-runs
and later pushes; the cleanup prunes the ref's entries for older assets. `.github/README.md`
describes the legs, their bundle, metrics and the comment.

## Future local chain

The same steps admit the owned previewnet genesis session with v0.3.4 People and Asset Hub code.
After local Humanity support and the local environment land, change only the environment
selection and feature tags, and `build.ts` settings to `VITE_NETWORK=local` with that environment's
endpoints and genesis values. Do not reuse the public previewnet genesis. The environment must
pin both runtimes to `paritytech/individuality-community@v0.3.4`; the admission guard checks their
code hashes. The current config enables only the Paseo copy.

The pinned framework's `coverage` output counts declarative sentences only. Keep that raw report
and run `scripts/lab/scenarios-bindings.mts <coverage.json>` through tsx: it resolves each of its
custom uses against the actual definitions, rejecting missing and ambiguous bindings. This
supplement does not rewrite coverage or treat an unbound sentence as covered.

The cross-app session optionally owns a loopback version-file server when `CROSS_APP_UPDATE_LAB=1`.
`cross-app/version-file.ts` documents its update-only build URL and port 49791; teardown closes it and each actor
resets it. Ordinary scenarios do not start it. The network adapter's `localPage(url)` exposes only an already
observed, guarded loopback page to the lab's CDP lifecycle driver. It never adopts another browser or changes the
network policy. Cross-app lifecycle and version-file unit tests cover suspended timers, public/wrong-page refusal,
real HTTP file promotion/reset and a wrong-path response. See `../cross-app/README.md` for the simulation limits.


### Cross-app promotion handoff

When the sequential imported-game drain proves that a snapshotted schedule became an empty Registration game,
`ScenarioChain.drainImportedGames` completes that handoff with a separate cleanup batch and a finalized idle
assertion. The batch removes remaining schedules before cancelling the promoted game. It never schedules over
the promotion or accepts a populated replacement. The cross-app session additionally writes a restricted receipt
projection before transaction validation; Humanity-only sessions retain their existing executor and journal.

For cross-app gameplay only, the session can provision two additional Jollity media peers. Their product-account
addresses are checked against their independent hosts, each app has its own bridge proxy, and each host/app is
stopped before the next actor. Ada's separate Humanity/Jollity hosts and storage are retained. Other scenario
paths do not provision these peers. The same browser network guard applies to all four hosts.

The shared chain, session, network, fresh-copy and observation helpers now live in the repository root `lab/shared/`. Humanity-only steps and A1-A6 features remain here. Cross-app features and tests moved to [the root lab](../../../../lab/README.md).
