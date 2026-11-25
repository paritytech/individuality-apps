<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working on Jollity

Guidance for coding agents (and humans) changing Jollity (`dim2`): this app,
the chat worker in `apps/jollity-worker`, the `packages/jollity-*` packages,
and the root folders only Jollity uses (`scripts/`, `deploy/`, `tools/`,
`docs/`). The repository is shared
with Humanity; the root [`AGENTS.md`](../../AGENTS.md) maps it and holds the
rules for both products.

**Paths in this file.** `app/`, `components/`, `lib/` and `public/`
are folders of this app, `apps/jollity-app`. Every other path is from the
repository root. Run the commands from the repository root unless a block
says otherwise.

**Env files.** Next reads `.env*` from this folder only, so local settings go
in `apps/jollity-app/.env.local`, never at the repository root. Start from
`cp apps/jollity-app/.env.example apps/jollity-app/.env.local`: it sets
`NEXT_PUBLIC_NETWORK_NAME`, without which every page answers 500.

# How we talk to the chain — dependency order

The product must be **fully buildable on `@parity/product-sdk` and truapi**.
Every chain interaction (read, write, signer, origin, proof) is sourced in this
order; treat direct polkadot-api as an escape hatch only.

1. **`@parity/product-sdk-*`** (host, individuality, tx, keys, …). Sources:
   github.com/paritytech/product-sdk. If the SDK does it, use the SDK — don't
   reimplement it.
2. **truapi** — the host runtime (github.com/paritytech/truapi). For host
   capabilities product-sdk doesn't expose (e.g.
   `truApi.signing.createTransaction`).
3. **`polkadot-api` (papi) — ESCAPE HATCH ONLY.** It is the substrate the SDK
   rides (`fromPapi`), not something app code should reach for. Use it directly
   only where product-sdk/truapi don't reach yet, justify it in the module
   header, and open an issue upstream to fold it back into the SDK. Building our own
   wrapper on papi is a rare, deliberate exception.

See [CONTEXT.md](CONTEXT.md) (top) for the full rationale.

Everything below is read by every agent: Codex reads this file directly, and Claude Code reads it through this folder's CLAUDE.md (`@AGENTS.md`). Add Jollity's guidance here, never to CLAUDE.md. A rule for the whole repository goes in the root AGENTS.md.

# Jollity — structure and conventions

Jollity is shaped as APP + WORKER + CHAIN LOGIC — the two on-chain
executables plus the engine packages they compose — in the repository's one
npm workspace:

```
apps/jollity-app/       ① APP, @jollity/app — Next.js (App Router), static-exported to out/
├── app/  components/  lib/    the app
│     lib/engine.ts            the ENGINE SEAM: the only value import of
│                              @jollity/game-chain; builds the GameEngine
│                              (the chain over papi)
│     lib/game-source.ts       the ONE doorway to chain state: written against
│                              protocol's GameEngine. HOST-ONLY app: in a host
│                              container, reads AND signing go through
│                              product-sdk (getHostProvider + accounts
│                              provider's product-account signer); dev override
│                              NEXT_PUBLIC_PEOPLE_WS = read-only WS view; else
│                              the page shows the "open in the Polkadot app"
│                              gate. Time-gated UI must use
│                              source.nowSeconds() (the device clock, checked
│                              against the peers), never Date.now().
│     lib/host/                the HOST's doorways: identity.ts (the
│                              permissioned name), navigate.ts (leaving for
│                              another product), storage.ts (host storage),
│                              sign-up.ts (what the host does for a sign-up:
│                              the account, its draw tickets, and peopl's
│                              keys dim2 proves with under its grant),
│                              game-reminder.ts
│                              (the next-game reminder of the host),
│                              game-registration.ts (the record of the sign-up
│                              either surface has on its way, read and
│                              written), prize-topup.ts (the top-up of the CASH
│                              purse from the game account after a claim).
│                              With lib/permissions.ts these are the
│                              only modules that touch product-sdk.
│     lib/draw/wheel/          THE PRIZE DRAW: proto/ is the wheel scene,
│                              plain JavaScript you edit in place
│                              (proto/README.md); mount.ts runs it on the
│                              chain's tickets + target, rule.ts checks it
│                              lands on the chain's winners
│     lib/draw/hold/           THE WAY ON FROM THE DRAW: hold anywhere and
│                              the draw is gathered into the collectables'
│                              bubble (scene.ts), carried on to /collectables
│                              (lib/collectables-scene/carry.ts); look.ts looks
│                              round the wheel before the hold
└── scripts/                   the bakes (bake-*.mjs: cash-wordmark, draw-coin,
                               prize-ticket, signup-ring)

apps/jollity-worker/    ② CHAT, @jollity/worker: the chat extension the
│                              host runs under QuickJS
├── src/                       index, state, renderer, host (the SDK doorway),
│                              chain (the reads), signup (Register, with the
│                              prize draw)
├── src/card/                  the card it posts, also @jollity/worker/card
├── src/migrations/            one-off rewrites of the stored state, numbered
│                              NNN-<name>.ts, each run once per phone at boot
└── scripts/build.mjs          own esbuild build to apps/jollity-worker/dist/index.js

packages/
├── individuality-*/           shared, for any product to tie in (root AGENTS.md), no product's
│                              package: people-chain (the base), name-link (the
│                              DotNS name and its gate), sign-up (the gates and the
│                              one sign-up flow lib/game-source.ts runs,
│                              /chain), game-outcome (attendance, the settle, the
│                              credits, /chain), prize (the claim and its sweep,
│                              /chain)
├── jollity-protocol/          @jollity/protocol — the wire contract (GameView …)
│                              the app and the chat both import
├── shared-records/            @individuality/shared-records — what Jollity and
│                              Humanity share (the game registration record)
├── jollity-collectables/      @jollity/collectables — the collectables read: which item
│                              each claim mints and its art, shared by /collectables of
│                              the app and the results card of the chat
├── jollity-statement-core/    ③ @jollity/statement-core — statement-store engine
│   └── src/                   statement.ts, rpc.ts, store.ts, transport.ts,
│                              statementCommon.ts, statementTransport.ts (+ *.test.ts)
└── jollity-game-chain/        ③ @jollity/game-chain — Game pallet engine
    └── src/                   engine.ts over @parity/product-sdk-individuality,
                               chain/  game/  keys/  (+ *.test.ts)

deploy/                 bulletin-deploy manifest (app + worker executables)
└── bulletin-deploy.config.ts  + icon.png
scripts/                the root's tools, run from the repository root
├── dev-host.mjs               `npm run dev:host` — the app inside a local truapi-host
├── deploy.mjs                 `npm run deploy` — build and publish either product (DEPLOYMENT.md)
└── explore.mts                `npm run explore` — the state-machine explorer
```

## The two executables

The deploy manifest (`deploy/bulletin-deploy.config.ts`) ships both: the app
(`apps/jollity-app/out/`, from `npm run build` — Next `output: "export"`) and the chat
in `apps/jollity-worker/dist/`, which `NEXT_PUBLIC_NETWORK_NAME=<network>
PRODUCT_DOTNS=<name> npm run build:chat` builds. The chat build hard-fails
without either. The name is what its buttons navigate to, and the manifest
verifies it matches the deploy target, as the header of the build script
explains with the iOS silent no-op story. The network is what the worker reads
the player and the People genesis from, through the same table in
@jollity/protocol the app uses. The worker reads the chain itself in
`apps/jollity-worker/src/chain.ts`, over the individuality SDK. Register signs up
from the chat in `apps/jollity-worker/src/signup.ts`, with the engine of
`@jollity/game-chain/engine` over the unsafe API of that client, which keeps
the descriptors out of the worker bundle, and with the signer, the draw
tickets and the lite proof of the host. The worker hands the app the tutorial
flag, and the app hands back what the player has seen of the results, and
that their report landed, as `jollity.seen`, both in `lib/worker-bridge.ts`.
A player whose report landed and who did not pass reads "You played but
didn't pass." on the card, never that they missed the game. The sign-up
either surface has on its way, or has just ended, is kept under
`jollity.registration`
(`GAME_REGISTRATION_KEY` and `GameRegistration` in
`packages/shared-records`, @individuality/shared-records: registering,
sent, registered or failed, with the game and the surface). The chat writes it
from `apps/jollity-worker/src/signup.ts` and the app from the sign-up of
`lib/game-source.ts`, whose status watch reads it through
`lib/host/game-registration.ts` and shows a sign-up of the chat on the home in
place of Register (issue 694). Humanity reads the same record through the
storage grant of `deploy/constants.ts` (issue 1316), and writes the record of
its own sign-ups to its own storage, which `lib/host/game-registration.ts`
reads too (`peopl.<tld>`, or `NEXT_PUBLIC_HUMANITY_STORAGE_LABEL`), keeping the
latest. The communication key a sign-up registers is kept the same way, under
`individuality.communication-key`, before the sign-up goes out
(`lib/host/communication-key.ts`). That is why the records live in the package
both products share and not in protocol: a change there runs both products' CI.
The cards are the chat design
in `apps/jollity-worker/src/card/`. The chat and the app each depend on protocol,
and the chat never imports the app.

**The app's hosted network table comes from Trinity stack descriptors.** The
TLD, the People and Asset Hub endpoints, the TURN issuer and paseo's genesis in
`NETWORK_CONFIG` of @jollity/protocol are plain values generated into
`packages/jollity-protocol/src/stacks.generated.ts` from the signed descriptor
copies in `packages/jollity-protocol/src/stacks/`, and never typed into the
table. The copies are the source of truth: `stacks.test.ts` verifies each
against the key its link pins and the generated module against what the copies
decode to. The bundles carry the plain values only and fetch nothing.
`npm run jollity:stacks` refreshes the copies and regenerates (`-- --check`
only compares; exit 2 means something moved): run it when a network resets. A
descriptor that lacks a value the app uses fails the script and the tests by
name, with no fallback. The descriptor names the TURN issuer but not its route,
which stays `TURN_ISSUE_PATH` of `turn-pass.ts`. The copies of network values in
tooling (`scripts/lib/host-slot.mjs`, the live bots, the deploy matrix) are not
covered yet and are tracked in #2004.

## The two engines — hard rules

- **They never import each other.** statement-core knows nothing about papi
  descriptors or the Game pallet; game-chain knows nothing about statements.
  The app composes them: game-chain's engine for the chain, statement-core's
  client for statements, proved through the host (`lib/host/statement-store.ts`).
  `keypairStatementProver` is a local prover, used by statement-core's tests.
- **statement-core** is chain-agnostic and descriptor-free: everything runs
  over an injected transport (`StatementRpcTransport`) and an injected store
  (`StatementStoreLike` / `ResolveStore`). In hosted mode,
  `getStatementStore` from `@parity/product-sdk-host` satisfies that seam
  structurally, but the app passes its own store, which proves as the player
  (`lib/host/statement-store.ts`, CONTEXT.md §5); standalone mode uses
  `nodeStatementStore(rpc, prover)`.
- **game-chain** reads the chain through `@parity/product-sdk-individuality`
  and types it with `@parity/product-sdk-descriptors`, both pinned to one exact
  version in every package.json that uses them. A runtime upgrade is an SDK
  release, and the pins move together, never one alone. What stays in the
  package is what the SDK does not do yet, and each module header names the
  gap it fills.
- `statement.ts` keeps the statement wire format byte-compatible with the
  discontinued native Polkadot-app game clients (CONTEXT.md §5); the
  signalling policy in `statementTransport.ts` is this repository's own (one
  desc per generation, coalesced candidate slot, gen gating, submit
  backpressure).
  Don't "simplify" either without reading their module headers first.

## Architecture rules

**0. WHAT WE BUILD ON — the dependency order.** The product must be fully
buildable on `@parity/product-sdk` and truapi. Every chain interaction (read,
write, signer, origin, proof) is sourced in order: **product-sdk** first
(if the SDK does it, use it — don't reimplement), **truapi** next (the host
runtime, for host capabilities the SDK doesn't expose, e.g.
`truApi.signing.createTransaction`), and **`polkadot-api` (papi) only as an
escape hatch** — it is the substrate the SDK rides (`fromPapi`), and the chain
`GameEngine` is where it legitimately lives. App code outside that engine that
reaches for papi is debt: justify it in the module header. Full rationale in
CONTEXT.md (top) and at the top of this file.

Then eight rules. They are not style preferences — each one was paid for.

**1. ONE DOORWAY TO THE CHAIN.** `lib/engine.ts` is the only module in the
app that value-imports `@jollity/game-chain`: it builds the `GameEngine` (the
chain over papi), and `lib/game-source.ts` reads it through
`./engine` and `@jollity/protocol`. Nothing else may hold a papi client, a
descriptor, or an extrinsic. Verify with:

```bash
cd apps/jollity-app
grep -rn 'from "@jollity/game-chain"' app lib components | grep -v 'import type'
# → lib/engine.ts, and nothing else
```

**2. VALUES FROM THE PURE SUBPATH, TYPES FROM THE BARREL.** The package
barrel re-exports `chain/client`, so importing *any value* through it pulls
polkadot-api and the generated descriptors into that bundle. Game math comes
from the pure `@jollity/game-chain/game`, which holds the constants and the
state machine. The group arithmetic, `numberOfGroups` and `groupSeats`, comes
from the SDK. Types come from the barrel as `import type`, which is erased at
compile and costs nothing.

**3. THE VIEW OWNS ITS CONTRACT.** A screen declares the shape it needs
(`PrizeDrawView` in `lib/draw/prize-draw.ts`) and the doorway
IMPORTS it. Never the other way round. This is what makes a second source —
a mock, a bridge, a different chain — a compile-checked exercise instead of
an imitation of whatever `game-source` happened to return.

**4. NO PALLET VOCABULARY IN A VIEW CONTRACT.** Narrow it at the doorway. The
airdrop pallet has eight lifecycle states; the ceremony branches on three, so
the contract carries `DrawPhase` (`waiting | drawn | over`) and `drawPhase()`
does the mapping. A pallet rename is then a compile error in one function
instead of a silent UI behaviour change.

**5. HOST CAPABILITIES GO BEHIND A DOORWAY TOO.** `lib/host/identity.ts`
(the permissioned name: `requestLogin` → `getUserId`), `lib/host/navigate.ts`
(`navigateTo`, browser fallback), `lib/permissions.ts`, `lib/host/storage.ts`
(host storage, where `lib/worker-bridge.ts` and `lib/collectables-picks.ts` keep
their keys), `lib/host/sign-up.ts` (the sign-up's host capabilities: the
draw tickets and peopl's personhood keys), `lib/host/game-reminder.ts` (the next-game reminder of the host,
which the chat keeps through `apps/jollity-worker/src/host.ts`), `lib/host/game-registration.ts`
(the record of the sign-up either surface has on its way, in host storage),
`lib/host/prize-topup.ts` (the top-up of the CASH purse from the game account
a claimed prize is paid into, which the chat does through `apps/jollity-worker/src/host.ts`),
`lib/collectable-art.ts` (preimages), and `lib/game-source.ts` (the one doorway
to chain state, which reads and signs through product-sdk). Screens and
components never import `@parity/product-sdk-host`.

**6. ANIMATION LOGIC IS FRAMEWORK-FREE; COMPONENTS ONLY FEED IT PARAMS.**
Every scene keeps its brains in `lib/` with no React import at all —
`lib/collectables-scene/engine.ts`, `lib/draw/wheel/mount.ts`, `lib/draw/hold/*`,
`lib/pocket/*`, `lib/coin3d/*`, `lib/wrapping/*`, `lib/game-session.ts` — and the component is a host that
passes props and forwards gestures. It is why a scene can be ported, tuned
and tested apart from React, and why the prize draw's wheel can run as a
plain-JavaScript scene (`lib/draw/wheel/proto/`).

**7. TIME COMES FROM THE SOURCE.** Every countdown and phase test uses
`source.nowSeconds()`, never `Date.now()`. The game clock starts on the device
time, and only the peer check moves it. The chain does not move it, so a local
dev node with a wrong clock gives a wrong game clock.
The full rule set (which clock each kind of code may read, how
the peer check corrects the game clock, and how server-judged stamps retry) is
**docs/time-and-clocks.md**. Read it before touching any clock read.

**8. OVERLAYS STAY ON THEIR SCREEN; THE LAYERING IS THE DISCIPLINE.** The
hologram picker is a component of `/collectables`, not a route — an opened
collectable opens it in place and it flies back into that piece on close. Two
WebGL contexts therefore live on one page, which is fine, but only because
of how the layers are built: the picker's stage is STATIC and never
transformed (a transform on the wrapper rasterizes both canvases and poisons
the wrapping layer's rect math, which measures its canvas), exactly one
element moves (the hero `<img>`, on the engine's spring), and it is pinned
pre-paint in `useLayoutEffect` with `visibility:hidden` so StrictMode's
second run cannot measure the first run's transform. The inspected piece hides
its own art while the hero stands in for it. Break any of those and the
symptom is "the zoom is broken", three layers away from the cause.

**What the lint rule enforces, and where it stops.** `no-device-clock` (the
in-repo ESLint plugin, tools/eslint-plugin-architecture) flags `Date.now` in
any position — a call, a reference handed to `useState`, a `= Date.now`
default, `globalThis.Date.now`, `window.Date.now`, `Date["now"]()` — plus a
zero-argument `new Date()`. It runs on `app/` and `components/` and on the
`lib/` modules that DRIVE timed UI (`lib/game-session.ts`, `lib/home-gate.ts`,
`lib/use-*.ts`, `lib/*/use-*.ts`). It deliberately does NOT run on `lib/` as a
whole: that is where the clocks themselves live (`lib/device-clock.ts`, the
chain anchor, the waits of time rule 3, the reload stamps of time rule 4),
and a blanket ban
there would flag the code that defines the source clock. The remaining `lib/`
reads are governed by docs/time-and-clocks.md's inventory, not by silence.

## State machines — the house rule

Anything with real stages that changes on events (a game phase, a retry loop
with several outcomes, an outbox, a connection's life) is a state machine,
and every one of them is built and tested the same way. This holds for every
agent and every person working in this repo. Keep it simple: the full
treatment is for real machines only.

1. **What counts.** A machine has about three or more states, or more than
   one kind of command. A single flag, a latch, a gate or a timer guard is
   not a machine: keep it as plain code with direct or property tests, and
   do not wrap it in a reducer.
2. **Shape: a pure reducer.** A `start()` (or `empty()`) value, plus
   `step(state, event) => { state, commands }`. The reducer does no I/O and
   reads no clock: time arrives as an event field, and side effects leave as
   commands that a thin host runs. The reducer is the authority: the host
   keeps no second copy of its state and runs every command it emits. A
   reducer the app does not obey is not done.
3. **Tests: the framework.** Each machine gets a
   `lib/state-machines/<name>.definition.ts` and a `<name>.model.test.ts`
   on `lib/state-machines/framework` (its README is the manual): an
   independent reference model written from the rules, not copied from the
   code; the state × event table written out by hand, never generated from
   the model; named invariants tied to the rule they protect; witnesses for
   every transition; and a regression for every bug it ever had. Run it with
   `npm run test:state-machines`.
4. **Moving existing code.** A PR that extracts a machine from existing code
   changes no behaviour, and proves it with a differential test against a
   verbatim copy of main's code, with the main commit SHA it was copied from
   named next to it. That copy is a migration proof: delete it in
   a follow-up once the PR has merged, so later changes are not made twice.
5. **New code follows the rule from its first PR.** A change to an existing
   machine that is not yet in this shape updates its tests in the framework
   in the same PR, or names the follow-up issue that will.
7. **Pure calculations are not machines.** A function of its inputs with no
   stored state (a status word, a gate, notice copy) gets plain or property
   tests instead of a model.

No state-machine library (XState or similar) is used. The reducer shape
and the framework are the shared convention.

## Working on UI

1. Start the server with `NEXT_PUBLIC_NETWORK_NAME=paseo npm run dev`: without
   the network every page answers 500.
2. **A screen renders from ONE view value.** If a state cannot be expressed as
   a value, the page is holding logic that belongs in `lib/`.
3. **Use the screen primitives** in `components/ui/screen.tsx` (`Body`,
   `MessageScreen`). The type scale lives there once.
4. Verify with `npm run typecheck && npm run lint`, then look at the screen
   in a browser.

## Working on the game itself

The game screen is the one place where chain state, WebRTC and a real clock
all meet.

- **`lib/game-session.ts` is the brains** — the connect phase (read off the
  snapshot's pre-connect window, never a timer), the state machine ticking on
  `calculateSnapshot`, per-turn votes with cycle-end auto-rejection, the
  confirm stage's majority prediction, auto-confirm, the mesh, the
  round gap, report submission. `app/game/page.tsx` is pure rendering
  over the view it returns. Logic changes go in the session; only pixels go in
  the page.
- **The real timing is the pallet's**: `HOST_FULL_CYCLE` is 12s (2s intro +
  8s play + 2s ending). A round is `HOST_FULL_CYCLE × max_group_size`, the
  game's own group cap, with ONE TURN PER SEAT. Six seats over two rounds give
  12 turns. A `ROUND_GAP` of 7s sits between two rounds, so the game plays
  151s (`roundStart`, `gameDuration`). A group with fewer players than turns
  WRAPS AROUND its own seats: turn t is hosted by seat `t mod n`
  (`hostSeat` in `packages/jollity-game-chain/src/game/stateMachine.ts`), so a group of 4 plays A B C D A B and
  no turn goes to an empty seat. Seats follow the chain's shuffle, so the
  extra turns fall on the lowest seats (recognized players first), and a host
  never hosts twice in a row. A group of one keeps its empty seats' turns with
  no host. The constants live in
  `packages/jollity-game-chain/src/game/constants.ts`. The STAGE LENGTHS (2 + 8 + 2)
  match the discontinued native Polkadot-app game clients; the turn count
  does not (they played one turn per player and stretched each turn to fill
  the round). With the native clients gone, a mixed group cannot occur.
- **Choreography lives in `components/game/animations.ts`** — the FLIP driver
  (`natural` / `parked` / `intro` poses) and the verdict commit. Three rules:
  the host intro fires on the intro stage ALONE (every turn, pads included), a
  non-votable tile never turns (`flippable` gates the gesture AND the
  rotation), and the auto-reject cue reads `stageRemaining`, never a delay
  measured at the stage's start. The cue commits nothing. `sealTurn`
  auto-rejects the undecided at the turn change.
- **The PLAY STAGE carries no copy.** The tiles move-in carries none either,
  and the confirm stage carries one title. A round holds the tiles, the turn
  pill bar and the two intro headlines. Both ride the grid:
  `useGridChoreography` measures and publishes `--game-hero`,
  `--game-hint-top`, `--game-hint-lift` and `--game-host-cx`, so nothing over
  the grid measures anything itself. The hero is ONE TILE at `HERO_SCALE`
  (grid size in low power mode), never a fraction of the stage.
- **The FINAL WAIT runs inside `/game`.** One shared waiting room
  (`components/waiting-room/`, logic in `lib/waiting-room.ts`) renders on both
  routes. The home hands over at `handoverAt(gameAt)`, T-64
  (`CONNECTION_STAGE_DURATION`), with the digits at `1:01`. On `/game` the
  session's `screen` is `final-waiting`: the dial turns one `DIAL_WINDOW`
  (60s) from T-63 to `00` at T-3 (`DIAL_ENDS_BEFORE`), and shows `00` for one
  second. The room goes out over the end of that second. Then, for the last
  `TILES_ENTER_SECONDS` (2), the screen is `tiles-enter`, and the tiles move
  in from the sides with no copy and no badge. Turn 1 starts at T-0. The mesh
  forms behind the dial for the whole connection stage.
- **The HINT PILLS are the round's only copy** (`components/game/hints.tsx`).
  One pill shape, four uses. `useHintCue` runs the three-pill tutorial on the
  game's FIRST turn alone. Pill one names the host by role: the page passes
  `gestureLabel`, "Copy gesture" for a player and "Show gesture" for the host.
  Pill two, "Tap to Identify Humans", arms the tile press through
  `useTeachSignal`. Pill three, "No tap means it's a bot", stays until the run
  ends or a tap hides it. A tap on a visible pill hides it, and the tutorial's
  next pill still comes on its timer. Two pills never share the screen. A
  vacant host slot replaces the tutorial — the no-host pill is the only cue
  then.
- **The ROUND GAP is the ROTATION SCREEN**, never a "Round N" lockup. The
  snapshot is `between-rounds` for `ROUND_GAP` (7s). For the first
  `GAP_LEAVE_SECONDS` (1) the last group leaves toward the sides, then the
  next group moves in with its real link badges (`ConnectStatus`), and the
  line reads "New players joining in N".
- **The CONFIRM STAGE is the VOTE SCREEN.** It is a screen of its own: a
  scroll column with the title "Check your choices!" and a two-column grid of
  every co-player (`coPlayers`, never padded), under a docked CTA. Each tile is
  the shared `FinalTile` with `negativeFace="photo"` and the player's snapshot.
  A tap changes the verdict through `voteFor`. The CTA fills over
  `AUTO_CONFIRM_SEC` (7), and a tap collapses the count.
- **The BAN is the session's, not the tile's.** The eye chip calls `s.ban`, and
  the session files the ban under the member's ACCOUNT, never the slot — a slot
  holds a different person next round. It casts the reject at once, and
  `openTurn` casts it again for every later turn. A banned tile draws the
  banned face and takes no feed, no gesture and no cue.
- **Signalling is the statement store** (`source.signalling` →
  `statementTransport`). Without it `useMesh` stays dark.
- **Late join** (lib/late-join.ts, #699): a registered player who missed the
  waiting room joins a running game at any turn. The home hands them to /game
  while turns remain, the same way it hands back a
  player who reloaded or relaunched. After the last turn, the home shows the
  next game. It goes with a vote
  default: a co-player you never shared a turn with gets `Person` from you
  instead of `NotPerson` (#520), so the people a latecomer never saw are not
  charged for their absence. A co-player's phone casts no vote on a latecomer
  for the turns before it first sees them, and one who DID share a turn with
  them but never saw them on video files `NotPerson` (#445).
- **The prize's unit is a build setting.** `NEXT_PUBLIC_PRIZE_UNIT` (default
  `CASH`, lib/draw/prize-unit.ts) is the word after the amount on the draw's
  coin and chip, its result line and the line of its automatic claim. The prize asset's own
  symbol (`pUSD` on paseo) stays on the draw data but is never shown.
- **Never fake a game outcome in the UI.** `won`, `passed` and the report are
  authoritative from the source; the screens play the ceremony and never
  decide the result.
- **The prize draw is a plain-JavaScript scene.** `lib/draw/wheel/proto/` is
  the code you edit, in place (`lib/draw/wheel/proto/README.md`). Changes made for this app
  are marked `JOLLITY:` (the chain's tickets and target in place of a hashed
  seed), its CSS is scoped under `#app`, and the app's own overrides are in
  `lib/draw/wheel/stage.css`. The wheel plays only a draw `rule.ts` can
  reproduce from storage; anything else (you are not in the draw, the entries
  are cleared) gets the chain's result in words, and the reason in the debug
  sheet.
- **Low power mode** (`lib/low-power.ts`) is a lighter path for slow phones,
  and a reload turns it off. It is one on/off mode that lives in memory only.
  The "Low power" toggle of the debug sheet turns it on and off, and
  `?lowpower=1` turns it on for one load. Read it with `useLowPower()` in
  React code and `getLowPower()` in other code. Each low power layer mounts
  only in the mode, and full mode does not keep a hidden copy. A costly full
  mode layer does not mount in low power, and its ticker does not start.
  The device probe (`lib/device-probe.ts`) renders the real tiles at a
  near-zero opacity (`PROBE_OPACITY`) for 2.5 s from T-20 on the dial.
  Every player gets a verdict before the game. If the dial gives none
  (a late join, a reload, a hidden page), `/game` holds the player on the
  probe screen (`device-probe-screen`) while the probe runs. The session, the
  camera and the mesh run under it. A p95 frame time under
  `PROBE_BORDERLINE_FROM_MS` keeps full mode. A p95 of `PROBE_WEAK_FROM_MS`
  or more turns low power mode on. A p95 between the two asks for a second
  sample. A page that hides mid-sample retries when it shows again. After
  `PROBE_MAX_ATTEMPTS` hidden samples, or a sample with no frames, low power
  mode comes on with the reason `probe-no-verdict`. Each sample stops after
  `PROBE_SAMPLE_LIMIT_MS`. Every telemetry point and event carries the
  `lowpower` and `probe` scope tags. A probe with samples sends
  `ui.probe_frame_ms`, `ui.probe_frame_median_ms` and `ui.probe_frames` with
  `probe.version` (5: the rules of 4, plus the probe screen, the retries and
  the sample limit), `probe.stage` (`countdown` or `late`) and
  `probe.attempts`. Every point and event also carries `lowpower.reason`
  (probe-weak, probe-weak-confirmed, probe-no-verdict, debug-menu, url,
  manual, none).

## Running tests

```bash
npm run test:statement-core    # statement-core only
npm run test:game-chain        # game-chain only
npm run test:engines           # both
npm run test:protocol          # the protocol
npm run test:chat              # the chat: host stack drift guard, renderer, call sequence, the card and the migrations
npm run typecheck:engines      # tsc --noEmit for both engine packages
npm run typecheck              # the app and the chat
npm run build                  # the Next app (also type-checks app code)
npm run build:chat             # the chat, which needs PRODUCT_DOTNS and NEXT_PUBLIC_NETWORK_NAME as above
```

Each package also runs standalone: `npm test -w @jollity/game-chain`.
To run one chat test, pass its name through the workspace, as in
`npm test -w @jollity/worker -- -t "<name>"`. `npx vitest` from the root skips the
chat config and fails with `__BOT_ICON__ is not defined`.

## Sentry telemetry

Failures on a player's phone reach the deployer's Sentry project without the
player's help, when a deployment turns telemetry on.

- **One doorway: lib/telemetry/** is the only code that imports
  @sentry/react (the lib/host rule). Everything else calls startJourney,
  reportFailure, setPlayer, setGameIndex and sendGameLog, and none of them
  throws because of Sentry. lib/journeys/ (app open, and the game trace across
  /game, /prize-draw and /collectables) is written against those, with no
  Sentry of its own. Verify: in apps/jollity-app, grep -rn '@sentry/react' app
  lib components, minus lib/telemetry/, prints nothing.
- **Configuration** is the deployer's: no DSN, no telemetry. The variables and
  what is sent are in [`docs/telemetry.md`](../../docs/telemetry.md).
- **Telemetry's host grant is a warm-up, never a delivery gate.** The app asks
  once per open, stores no answer, and keeps sending through the bounded retry
  queue whether the answer is yes, no, late or absent. Sentry's ingest host is
  not in REMOTE_DOMAINS and the game's jollity.permissions.v2 flag is untouched.
  The transport uses window.fetch, so the host's per-domain rule still applies.
- **Attributes are text.** Custom span attributes from the JS SDK are stored
  string-typed; only span.duration aggregates as a number. A new interval is a
  new step (add it to JOURNEYS in lib/telemetry/journeys.ts), a new category is
  a text attribute. No key or value may contain auth, secret, credential or
  password (Sentry's default masking blanks them): add every new literal to
  lib/telemetry/masking.test.ts, or to a masking-<lane>.test.ts of its own.
- **devLog lines are breadcrumbs, never events.** A failure is a reportFailure
  kind from the catalogue in lib/telemetry/failures.ts; isExpected decides
  which count as the player's own "no".
- **Tests:** the telemetry and journey tests read the network name at import,
  so run them as NEXT_PUBLIC_NETWORK_NAME=paseo npm run test:lib.
- **Numbers go through the metrics doorway, never span attributes.** Custom
  span attributes are string-typed in Sentry: a raw number or boolean lands as
  NULL, so attributes stay strings and are for filtering
  and counting. Anything to aggregate (RTT, fps, frame time) is a metric
  (lib/telemetry/metrics.ts → the tracemetrics dataset, where p50/p95 work)
  or a span's own duration. Each metric has ONE fixed unit, listed in the
  metrics.ts header; a query with another unit returns nothing.
- **Metrics share the event delivery queue.** A slow answer changes nothing;
  failures retry, offline work waits for the browser's online signal, and only
  QUEUE_CAP pressure displaces metrics before events.
- **useScene comes from lib/telemetry/use-scene**, not the index, which stays
  free of React for the framework-free lib modules that import it.

## Gotchas (all hit in practice)

- This app's `tsconfig.json` keeps `target: ES2022` (the engines use bigint
  literals) and excludes only its own `scripts/`. `tsc` still follows imports
  into `packages/jollity-*` and `apps/jollity-worker/src`, and it includes
  `deploy/`, so `npm run typecheck` checks those too.
- When the app starts importing the engines, add them to
  `transpilePackages` in next.config.ts (their `main` points at TS source).
- `apps/jollity-worker/dist/index.js` is untracked and gitignored. A deploy runs
  `npm run build:chat`, and a local run needs
  `NEXT_PUBLIC_NETWORK_NAME=paseo PRODUCT_DOTNS=<name> npm run build:chat` first.
