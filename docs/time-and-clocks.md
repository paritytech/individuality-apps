# Time and clocks

How the game keeps every player on the same beat, and which clock each piece
of code may read. This is a SPEC: where the code disagrees with it, the code
is wrong. The gaps known today are listed at the end. Each one is a bug to fix,
not an exception to live with.

A device clock that jumps mid-game must not skip or replay turns, or lose a
report. The rules below are what keeps it from doing so.

Paths are in `apps/jollity-app/` unless they name another folder.

## The four clocks

| Clock | What it is | Can it jump? | Read it through |
|---|---|---|---|
| **Game time** (the game clock) | The device clock plus the offset that the peer check sets | Only at a correction of the rules below | `source.nowSeconds()`, `chainNowMs()` (lib/chain-clock.ts) |
| **Device clock** | The wall clock with every step taken out (lib/device-clock.ts) | Never back. A forward move of the wall clock across a hidden page is kept, since a freeze looks the same | `deviceNowMs()` |
| **Monotonic clock** | `performance.now()` | No, but it stops while a page is frozen | `performance.now()` |
| **Wall clock** | `Date.now()`, the phone's own clock | Yes, at any moment: time sync, time zone, the user | `Date.now()`, allowed only where this spec says so |

Block timestamps come from the validators' synced clocks, so chain time (the
block time) matches real time to within seconds. The game clock does not read
it. The statement store and the TURN issuer judge times against their own
system clocks, which are synced too.

## Rule 1: the game runs on game time

Every decision about where the game is comes from game time or a block
number:
- which turn, stage and round;
- the countdowns to a chain event;
- the handover from the waiting room;
- the report window and the auto-confirm;
- "missed", "round finished" and the redirects.

The schedule is on chain (`game_date`, the phase durations, `report_ends`),
so every player computes the same answer from the same input.

Blocks arrive every 6 s, but a stage lasts 2 s, and a block reaches the phone
after a delay that nobody can know. So game time is the device clock plus an
offset, and the wall clock never takes part. The game window (kickoff and
`report_ends`) still comes from the chain.

**Correction** (lib/game-source.ts, lib/clock-sync.ts):
- **Start:** the offset is 0, so game time starts on the device clock. The clock is ready at once.
- **Chain gap:** the first chain value and the first block time change of a page record the gap, device time minus block time (`clock.chain_gap_ms`). It never moves the clock. Its one other reader is the TURN proof stamp below; the gap kept for it follows every live block after the first value. A local dev node with a wrong clock thus misplaces the schedule on chain and the TURN stamp, not the game clock.
- **Peer check:** over the mesh, the phone pings each peer every 2 s. A peer replies with its device time only, never its offset. A reply with a round trip over 1 s is dropped. For each peer, the phone keeps the reply with the shortest round trip in the open window.
- **Peer verdict:** 3 or more peers must reply, and more than half of them must be within 1 s of the median. A median within 250 ms of the target changes nothing. A median further off moves the clock only after the same median (within 250 ms) holds for 2 s or more.
- **Peer windows:** the first ask of the mesh before kickoff − 2 s opens the pregame window, until kickoff − 2 s. A first ask at or after kickoff − 2 s opens a late window for 20 s. On /game, a page resume and a wall step or a visible freeze each open a window for 20 s. A window that has not settled (no dead-band or applied verdict) stays open past its end time, until 3 peers agree or the game ends. After a settled window, the mesh opens no new pregame or late window for that game.
- **Speed:** every move runs the clock faster or slower than the device clock (`SPEEDS`) until it reaches the target. In the game, a clock more than 5 s behind jumps forward. At the tiles enter, a clock still more than 250 ms behind jumps forward. The shown time never moves back.
- **Freeze check** (lib/game-session.ts): the session measures the gap between two ticks on the game clock, minus each jump that no forward wall step or visible freeze explains. So a peer jump is no freeze, and it does not turn auto-confirm off.

Tests follow the same rule: every wait and timeout derives from the game's
times on chain, never a fixed duration.

## Rule 2: times another server judges are stamped from game time, and retried on the server's time

Two values leave the device carrying a time that another machine checks
against its own clock. Each is stamped from what the device knows of that
machine's clock, game time at the least, and a rejection for time is retried:
once by the statement store, within its three tries by the TURN issuer.

**Statement-store expiry** (packages/jollity-statement-core, statementCommon.ts nextSlotExpiry):
- **The store clock** is game time plus a learned offset, which starts at 0. Every expiry is stamped from it: store clock plus the TTL.
- **Learning the margin:** the store's reply carries no clock: a time rejection is `invalid` with reason `alreadyExpired` and nothing else, and the node judges against its own system clock (polkadot-sdk substrate/client/statement-store submit). So the store's time is never measured, only bracketed. A game-time stamp is normally accepted, because the phone clocks and the node clock are synced. If one is rejected anyway, the app pushes the stamp ahead by a margin and retries once, then keeps the smallest margin the store accepted for the session. The store sets no upper bound on an expiry, so a margin that is too large only lengthens a statement's life.
- **When the margin is learned:** in the waiting room, after sign-up, with one calibration statement on the player's own channel, so in-game signalling never pays for a rejection. A late joiner calibrates on rejoin. The in-game one-shot retry is the fallback.
- **Rejected on both stamps:** report it as a signalling failure with its reason. Never loop. Relearn the offset only on a later time rejection.
- **One submit in flight per channel.** A newer frame for a channel waits until the channel's current submit finishes, so the page's own frames can never race on a channel (an offer and an answer to one peer can leave in the same millisecond). A `channelPriorityTooLow` on our own channel can then only mean a statement the page never sent, one from before a reload. The statement is re-stamped once above the expiry the refusal names.
- **A statement must never be born expired.** The TTL must stay above the mesh's backoff ceiling (`SUPERVISOR_TIMING.backoffMaxMs`, 20 s, lib/webrtc/supervisor-timing.ts). Stamps also never go backwards (lastExpiry stays monotonic).
- **A stale stamp teaches nothing.** A rejected stamp more than half its TTL old is stamped again with no margin pushed. The learned margins and the expiry floor survive a reload in session storage (lib/store-clock.ts).

**TURN credential proof** (lib/webrtc/ice.ts, lib/host/turn-proof.ts):
- **Stamp** (`stampSecondsOf`): the issuer's time as learned from the Date header of any of its answers; before that, the device clock minus the chain gap (true time, so a phone with a wrong clock is not refused); before any chain gap, game time; with no game clock either, the device clock.
- **Refused as outside the timestamp window:** learn the issuer's time from the response's Date header and try again with a fresh proof. A time refusal counts as retryable, inside the issue's three tries (1 s and 2 s apart, jittered, within 15 s). When the refused stamp came from the chain gap and the answer had no Date header, the next stamp skips the gap and uses game time (`issueWithProof`).

## Rule 3: waits and measurements use the monotonic or device clock

This covers timeouts, backoff, heartbeats, cooldowns, retry delays, latency
and durations. Examples are the peer TTL, the isolation grace, the auto-confirm
hard stop, the TURN cache and the health ladder.

A clock jump may stretch or shorten one of these waits, but it must never
decide a game phase. If a wait guards a game deadline, the deadline comes from
Rule 1, and the wait only paces the checks.

## Rule 4: stamps saved across reloads use the wall clock, coarsely

No monotonic clock survives a reload, so a stamp saved in session, local or
host storage is a wall-clock value. These stamps may only gate coarse, forgiving
windows measured in minutes, such as the host-reload cap, the remembered game,
the last-seen marker and a late game-log upload. They must never decide a game
phase. Each one is listed in the inventory below.

## Rule 5: animation and telemetry are free, and inert

Animation frames, render timing, telemetry timestamps, log stamps and debug
views may read any clock. Their value never flows into a decision.

## Rule 6: a time handed to the OS is on the wall clock

The OS fires alarms and notifications on the wall clock, so a time handed to
the host for one is game time converted at the moment of the call:
`Date.now()` plus the game time left. The host keeps a calendar entry for
every time it has not seen exactly, so the first ask for a game fixes the time
in a record the app and the chat share, and every later ask for that game
sends the recorded time. A game that moves gets a new time. The app never
decides anything with it.

## Enforcement

- **An allowlist lint rule:** `architecture/no-device-clock` (the in-repo ESLint plugin, tools/eslint-plugin-architecture) flags `Date.now` in any position and a zero-argument `new Date()` across `app/`, `components/` and the `lib/` modules that drive timed UI (`lib/game-session.ts`, `lib/home-gate.ts`, `lib/draw/draw-screen.ts`, `lib/use-*.ts`, `lib/*/use-*.ts`, as `eslint.config.mjs` lists them). Each tolerated read is an allowlist entry keyed on the line's TEXT, with the rule it falls under. A stale entry is reported too, so `npm run lint` fails on it; an entry for a file that was deleted or moved out of the rule's scope is never checked. `performance.now()` is not flagged — Rule 3 and Rule 5 already allow it. `lib/` as a whole is out of scope on purpose: it is where the clocks themselves live. (The rule's messages call `Date.now()` the device clock; this page calls it the wall clock and keeps "device clock" for `deviceNowMs()`.)

## Inventory

The lint rule's allowlist, `tools/eslint-plugin-architecture/allowlist.mjs`,
lists every tolerated clock read in the modules the rule covers, each with
the rule it falls under. This section names the ones that matter outside it.

**On game time already:** the report window, the time left until
`report_ends`, the missed-report check, the auto-confirm last call, the "past
its close" redirect, `toStart` and its boundary timers when a live source
exists (lib/game-session.ts), registration open and the derived status
(lib/game-source.ts), and the countdown when a source exists
(lib/use-game-status.ts).

**The waiting-room dial** (components/waiting-room/, components/countdown/waiting-dial.tsx) gets the time left only from the `nowMs` clock that the route injects, never from `Date.now`. On both routes that is the game clock in ms with the chain kickoff; on the home page, before a source exists, it is the device clock. On `/game` the session gives it as `sessionNowMs()`, and `toStart` reads the same clock. So a correction makes the seconds tick slower or faster, and the shown time never moves back.

**Rule 1 debt to fix** (the first two are marked as Rule 1 debt in the
allowlist): these game decisions can still read the wall clock.
- **lib/game-session.ts, the local `nowSeconds()`** (`Date.now() / 1000`):
  the session's clock when no live source exists, and the fallback of
  `sessionNowMs()` before the game clock is registered. It is also read while
  a source exists: by `gameClockLead`, which feeds the kickoff the session
  times against (`gameAt`) and the tiles-enter time (`enterAt`), by
  `lastGroupLeaving`, which picks the round whose group the grid shows over
  the gap, and by the `enterAt` boundary timer.
- **lib/use-game-status.ts:** the initial `now`, and the tick's fallback when
  no source exists.
- **components/game/animations.ts, `useTilesEnter`:** the tiles-enter offset
  from `startAt`, read against `Date.now()`. The allowlist files it as
  animation (it sets a CSS delay and decides no phase), but it places the
  tiles in time against the wall clock.

**Rule 3 debt:** some waits still read the wall clock, so a jump stretches or
shortens them: the path-probe cooldown (lib/webrtc/use-path-mode.ts), the TURN
warm-up's default `nowMs` (lib/webrtc/use-turn-warmup.ts), the debug sheet's
tap window (components/debug/use-debug-sheet.ts) and the camera's timeouts
(lib/camera.ts). One of them decides something: the away latch
(lib/game-session.ts `awayLatchNowMs`) measures how long the page was hidden
on the wall clock, and a long enough absence turns auto-confirm off.

**Rule 2:**
- **Statement-store expiry:** conforms. The store clock (packages/jollity-statement-core storeClock.ts, wired by lib/store-clock.ts) stamps every expiry, and lib/store-calibration.ts calibrates it in the waiting room and on a late join.
- **TURN proof:** conforms.

**Rule 4 stamps:**
- the host-reload budget (lib/self-reload.ts);
- the resume-reload candidate, `armedAt` in session storage, 10 minutes (lib/resume-reload.ts);
- the chain-lost streak, `{ count, at }` in host storage, 30 minutes (lib/chain-lost-streak.ts);
- the store clock's expiry floor in session storage (lib/store-clock.ts), which comes from the game clock;
- a persisted telemetry rate-limit deadline in local storage (lib/telemetry/init.ts);
- the remembered game (lib/post-game.ts);
- `lastSeenAt` (lib/telemetry/session-record.ts);
- the debug log's entry times and the late-upload check (lib/debug/log-store.ts, lib/telemetry/game-log.ts);
- the baked-coin cache (lib/draw/wheel/baked-coin.ts);
- the expiry of the TURN credentials kept across a reload (lib/webrtc/ice.ts `hydrateCache`, `expiresAtWallMs`). A clock set back between the save and the reload keeps dead credentials for that long.

**Rule 6:**
- **Debt:** the host reminder of the next game, asked by the app (lib/game-source.ts `remindOfGame`, and the sign-up's reminder) and by the chat (apps/jollity-worker/src/index.ts `keepReminder`), hands the host `joinAtMs(game_date)` (packages/individuality-sign-up/src/reminder.ts): the chain's play time less 60 s, in ms, with no conversion. It is right while the phone's clock is.
- **Conforms:** the chat's notifications convert with the chain offset of each poll, or with the last stored offset when the clock read fails (apps/jollity-worker/src/chain.ts `readGame`). A poll with neither books nothing.

**Rules 3 and 5:** the waits (Rule 3) and the animation, telemetry and debug reads (Rule 5) spread across lib/webrtc, lib/camera.ts, the scenes and lib/telemetry. Those under the lint rule's scope are allowlist entries.
