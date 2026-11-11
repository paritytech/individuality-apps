# Telemetry: what Sentry sees

Humanity can report to a Sentry project of the deployer's choosing, so that
when a person does not get what they came for — a username, Membership,
today's dollar — the deployer learns it from the product and not from the
person. **Nothing is sent unless the deployer builds with their own
`VITE_SENTRY_DSN`** ([Turning it on](#turning-it-on)).

The unit of reporting is a **flow**: one thing a person (or the worker on
their behalf) is trying to get done, end to end, sent as one transaction with
the duration they waited and every host call, chain read and transaction it
took, and a failure filed under the story it broke.

The code is in `packages/humanity-shared/src/telemetry/`:

| File | Does |
| :-- | :-- |
| `sentry.ts` | `initTelemetry(surface)`, called first thing by both executables. No DSN, no client: a build without `VITE_SENTRY_DSN`, `vite dev` without one, and every test send nothing. |
| `flow.ts` | `runFlow(name, fn, { attributes, outcome })`: the transaction. `flow.stage(name)` / `flow.step(name, fn)`: its children. `childSpan` is how the seams below attach. |
| `host-session.ts` | Reads the Pocket host's `__trinityHostTelemetry` bootstrap and tags every event and transaction with `host.session_id` (and `open.source`), the id the host's own `host.*` events carry. No host, no tag. |
| `sentry-sink.ts` | The LogTape sink. Records below `error` are breadcrumbs; `error` and `fatal` records are the events, grouped by category and message **template**. |
| `app-context.ts` | `setIdentityContext`, `setCardContext`, `setDebugContext`: the card's standing as last shown (and, only with `VITE_SENTRY_SEND_IDENTITY=true`, whose card it is), on every event. Written by `use-humanity-card.ts` and the debug override when the state changes. |
| `redact.ts` | Keeps usernames and account addresses out of reports unless the deployer opts in: blanks identity-keyed log properties and scrubs SS58 addresses and `name.NN` usernames from every text before sending. |

Four seams report without any flow knowing about them: every host (truAPI)
call made through `chain/host-api.ts` is a `host.call` span under the flow
in flight (`host-call-log.ts`); the first chain client of a launch is a
`chain.connect` span (`connection.ts`, `host-bridge` or `ws`, a cache hit
opens nothing); every chain read wrapped in `tracedRead(name, …)`
(`chain-read.ts`) is a `chain.read` span named by storage item or helper —
`finalized.pin`, `Score.Participants`, `ring.standing` — because papi reads
have no common choke point and each one worth a line is named where it is
made; and every transaction submitted through `watchTransactionSubmission`
is a `sign` span (call to broadcast) and a `settle` span (broadcast to the
settle decision), with the tx hash and the status the caller got.

## The rule for failures

**A failure is declared once, by the `logger.error` line the flow module
already writes, and the sink files it.** `runFlow` only sets the status and
`flow.outcome`; it never captures. So:

- Adding a flow is `runFlow` around the function plus `flow.stage(...)` at
  its phases. Nothing else to wire.
- A failure that is not logged at `error` is a failed transaction with no
  issue. Log it, with the decoded `detail` the chain modules already carry.
- Interpolated values go in properties, not in the template, or every value
  is its own issue. `"Score.register stopped ({kind}): {detail}"` is one
  issue with `log.kind` and `log.detail` tags; `"stopped: refused by 5Fxx…"`
  would be one issue per person.

## What is tracked

Tags on everything: `surface` (`app` / `worker`), `product` (the DotNS label
the build acts for), `release`
(`humanity-app@<version>+<sha>` for the app, `humanity-worker@<version>+<sha>`
for the worker; slashes are invalid in Sentry releases), `environment` (`previewnet` /
`paseo-next-v2` / `dev`). Inside the Pocket host also `host.session_id` and
`open.source` (`pocket_card`, `deeplink` or `other`): search the first to see
the host's side and this product's side of one launch together.

| User story | Flow | Where | Stages | `flow.outcome` (not-ok in bold) |
| :-- | :-- | :-- | :-- | :-- |
| I open the app and see my card | `card.load` | `card-load.ts`: opened in `main.tsx` dated from the script start (`performance.timeOrigin`), narrated by `use-humanity-user-id.ts`, `use-game-account.ts` and `use-humanity-card.ts`, ended by the commit that draws the live card; one per launch, always sampled; refetches report nothing (`game.account`, `card.cached`: a stored snapshot was on screen during the wait) | `boot` (script start → React mount), `identity` (host user id), `game-account` (host derivation), `read` (`chain.connect`, `finalized.pin`, every `chain.read`, host ring-key calls; the first read aborted by the query re-keying stays inside it), `render` (read landed → card committed) | card state kind; **`account-unavailable`** (host holds no identity, or the name has no account), **thrown** |
| My tap on the Pocket card to the card shown | `pocket.open` | `card-load.ts`, beside `card.load` and only when the host sent `openedAtEpochMs` (a plausible time, under five minutes old) and the page is not a reload or back/forward: dated from the tap, ended with `card.load` and its outcome; always sampled; no stages or children of its own (the host's side is its `host.*` events, the rest is `card.load`, both on `host.session_id`) | none | the card state kind as `card.load`; **`abandoned`** (the page went hidden after it had been shown, before the card showed: a person who stopped waiting; a page the host created hidden is not abandoned until it has been shown; `card.load` runs on) |
| I finish Membership | `membership.promotion` | `use-auto-register-personhood.ts` → `register-personhood.ts`, automatic and the debug panel's manual run (`source`) | `candidate`, `eligibility`, `list-key`, `register-key`, `sign`, `submit`, `broadcast` | `registered` (+ `tx.confirmed`), `not-ready`, `not-personhood-product`; **`unsupported-host`**, **`refused`**, **`failed`**, **`no-candidate`**, **`threw`** |
| I claim my username | `username.claim` | `upgrade-lite-username.ts` (`method`, `username.choice`) | `setup`, `accounts`, `preflight`, `sign`, `verify`, `submit` | `included`; **`unknown`**, **error code**: `invalid-username`, `pending`, `account-missing`, `signing`, `timeout`, `finalized-error` |
| My username is mine in dotNS too | `username.dotns` | `claim-dotns-name.ts` (`source`; `dotns.lite` and `dotns.label` only with the identity opt-in), from the card's automatic path (`use-dotns-name-claim.ts`) and the debug panel's manual run | `accounts`, `setup`, `preflight`, `proof`, `revision`, `submit` | `included` (+ `tx.hash`), `already-registered`; **`unknown`**, **`failed`** (error code: `invalid-label`, `host-missing`, `not-lite-owner`, `account-already-registered`, `ring-not-synced`, `proof`, `signing`, `timeout`, `finalized-error`), **`threw`** |
| Stale reservations ahead of me are cleared | `username.reservation-cleanup` | `clear-expired-reservations.ts` (`reservation.queue`, `reservation.expired_ahead`), from the claim page's availability check (`use-username-availability.ts`) | `read`, `accounts`, `submit` | `nothing`, `cleared`; **`failed`** |
| I'm registered for today's draw | `daily-dollar.registration` | `register-draws.ts`, from the app's 30 s retry loop (`source`, `draws.count`, `chunks.count`) | `setup`, `alias`, `build`, `submit` (one `sign`/`settle` pair per chunk) | `finalized`; **`unknown`**, **`failed`**, **error code**: `account-missing`, `signing`, `timeout` |
| I scratch and the prize lands | `daily-dollar.claim` | `claim-draw-prize.ts`, from the scratch screen's auto-claim and the retry CTA | `setup`, `alias`, `submit` | `included`; **`included-unawarded`** (included, no `PrizeClaimed` event), **`unknown`**, **error code** |
| My prize moves into my wallet | `coinage.top-up` | `coinage-top-up.ts` (`account.index`, `amount`): the post-claim sweep and the stranded-prize sweep | the `payment.topUp` host call | `ok`; **thrown** |
| I press "Run a flow" in the debug panel | `debug.probe` | `DebugSentry.tsx` (`source: debug-panel`) | `first`, `second` | `ok` |
| My Pocket card shows my real standing | `pocket.render` | `pocket-card.ts`, the worker's own read on each draw | chain reads | face state kind; **floor face** (read failed, placeholder drawn) |

Plus, outside any flow: every uncaught throw and unhandled rejection in
either executable (`globalHandlersIntegration`), a React render crash
(`AppErrorBoundary`, filed as the exception with the component stack), and
every `logger.error` anywhere — the pocket renderer's registration among
them.

## Trying it on a device

The debug panel's **sentry** section (`DebugSentry.tsx`) shows whether the
build reports (DSN present), its environment, release and flow sample rate,
and has one button per path to Sentry: **Log an error** (`logger.error`,
the sink), **Throw uncaught** (the global handlers) and **Run a flow** (a
`debug.probe` transaction, sampled like any flow). Each send is listed
below the buttons with the event id and the ingest's HTTP status; search
the id in Sentry to see the event with its contexts.

## Reading it

- **Performance → Transactions**, filter `op:flow`. p50/p95 per story; the
  `sign` and `settle` children say whether the time went to the host (a
  person looking at a signing prompt) or the chain.
- **Issues**: one per failure template. `log.category` and `log.kind` tags
  split a template by cause; the trace link opens the flow it happened in,
  breadcrumbs are the log lines before it.
- A flow with status `internal_error` and no issue in its trace is a failure
  nobody logged at `error`. That is the gap to close.

## What an event carries

- Tags on everything: `environment` (`dev` or the network), `release`,
  `surface` (`app` / `worker`), `product`, `product.subname`, plus the
  device and connection as the app reads them on the device (`device.ts`:
  `device.os`, `device.engine`, `device.model`, `net.type`, …); the SDK sends
  no User-Agent header. Inside the Pocket host also `host.session_id` (a
  random id per page the host opens, not a person) and `open.source`
  (`host-session.ts`).
- Tags on an issue: `log.category` and one `log.<key>` per property of the
  log call (`log.error`, `log.detail`, `log.txHash`, …), the message and its
  template under the `log` context.
- Contexts from `app-context.ts`, searchable, with `card.kind` and
  `debug.scenario` doubled as tags:
  - `identity`: `kind` (`lite` / `upgraded`).
  - `card`: every field of the card state (`kind`, and per kind `score`,
    `personhoodThreshold`, `gamesRemaining`, `activeWeeks`, `misses`,
    `allowedMisses`, `window`, `reason`, …); or `kind: account-unavailable`.
  - `debug`: the forced `scenario`, only while the debug panel overrides the
    card. A tester's `caution` card is not a real one.
- Breadcrumbs: the last 60 log lines below `error`.
- Transaction hashes, as span attributes (`tx.hash`) and log tags
  (`log.txHash`): they are what finds a failed submission on chain, and a
  hash leads to the account that signed it.
- Sampling: every error. `card.load` and `pocket.open` are always sent:
  one per launch, and they are the durations we need every sample of. Every
  other flow at
  `VITE_SENTRY_TRACES_SAMPLE_RATE` (default 0.1, one flow in ten); the
  Sentry quota is per event, and flows far outnumber errors.
- Never: cookies, headers, query strings, request bodies, the SDK's user
  record (`dataCollection` is all off), console/fetch/XHR breadcrumbs.

### Usernames and addresses: off unless you opt in

By default a report says what went wrong and in which standing, not who it
happened to. Unless the build sets `VITE_SENTRY_SEND_IDENTITY=true`:

- `app-context.ts` sets no `username` tag, and the `identity` and `card`
  contexts carry only the fields listed above.
- `sentry-sink.ts` replaces the value of every log property whose key names a
  person (`account`, `owner`, `name`, `label`, `lite`, `candidate`,
  `claimant`, `who`, …) with `[redacted]`, in its `log.<key>` tag and in the
  rendered line.
- `redact.ts` rewrites every message, exception value, breadcrumb, tag and
  span attribute before it is sent, replacing SS58 addresses with
  `[address]` and `name.NN` usernames with `[username]`. This is pattern
  matching: it covers the shapes this app produces, not every possible one.
- The `username.dotns` flow leaves out its `dotns.lite` / `dotns.label`
  attributes.

With `VITE_SENTRY_SEND_IDENTITY=true` all of that is sent as it is: the
`username` tag; `identity` with `primaryUsername` and `username`; `card` with
`accountAddress`, `ownerAccount`, `gameAccount`, `participantKey` and
`primaryUsername`; and log lines with their values. Turn it on only if your
privacy notice covers it.

Sentry also records the client IP address of every report unless the project
is set not to (Sentry project settings, "Prevent Storing of IP Addresses").
The app cannot switch that off from the client.

## What is not tracked yet

Known and deliberate for this first cut; each is a flow or a log line away:

| Story | Why not yet | How |
| :-- | :-- | :-- |
| Username availability checks | Reads only; a failed check is retried by the person and never blocks | Log at `error` after the retry fails too |
| Pocket card refresh reads after the first | Only the first draw is a flow | Attribute on the same flow, or sample |
| Web vitals / page load | `browserTracingIntegration` left out for bundle size; `card.load`'s `boot` stage already covers script start → React mount | Add it if first-paint or resource timing becomes a question; +~15 KB gz |
| Chain reads outside the card (`current-game-data.ts`, `airdrop-standing`, `ring-membership.ts` internals) | Only the card read names its reads; the ring helpers report as one `ring.standing` / `devicehood.probe` span each | `tracedRead` at the call site when a flow there is slow for no visible reason |

## Turning it on

Everything is build-time configuration. The `VITE_*` variables come from
`apps/humanity-app/.env*` or the shell, and both the app and the worker read
them. The `SENTRY_*` upload variables are read from the build's process
environment only: export them, or build through `npm run humanity:setup`, which
loads the app's env files into the build's environment.

| Variable | Effect | Default |
| :-- | :-- | :-- |
| `VITE_SENTRY_DSN` | Your Sentry project's DSN. Unset or empty: no client is created and nothing is sent. | unset |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | Share of flow transactions kept, 0..1. Errors are never sampled; the decision is per trace, so a sampled flow keeps all its children. | `0.1` |
| `VITE_SENTRY_SEND_IDENTITY` | `true` to include usernames and account addresses ([above](#usernames-and-addresses-off-unless-you-opt-in)). | off |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | Upload the app's source maps to your project ([below](#source-maps-for-the-app)). All three or none. | no upload |

- Deploy environments are told apart by the `environment` tag (the network)
  and builds by `release`; two names that serve the same bundle share both.
- Cost: the SDK adds about 35 KB gzipped to each published bundle, whether or
  not a DSN is set.
- Egress: reports go to your DSN's ingest origin over HTTPS from the host's
  WebView, and nowhere else. A host that blocks it loses reports; the SDK
  fails silently.

## Source maps for the app

The app builds hidden source maps and injects a debug ID into each JavaScript
chunk. Sentry uses that ID to associate a frame with its uploaded map, including
when a host serves the app from a local URL. The SDK's release still comes from
`app-release.mjs`; the upload uses the same name, with no `dist`.

Uploads run only when all three build environment variables are nonempty:
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`. The token is a build
credential; never prefix it with `VITE_`. Keep the existing `VITE_SENTRY_DSN`
for runtime reporting. Build telemetry is disabled in the plugin and, when uploading, in its CLI
(`SENTRY_CLI_NO_TELEMETRY=1`). The plugin does not create or finalize releases
or associate commits.

Every `.map` is removed from the resolved output directory after the upload,
including when uploads are disabled. Hidden maps emit no `sourceMappingURL`
comments. A failed upload fails the build; it must be retried before publishing.
A build without upload credentials succeeds and still strips its maps, so errors
from that build need its maps uploaded separately to show original source lines.
Upload the maps from the exact build before publishing its `dist`.

Supply these variables to the app's build step. Keep credentials out of
untrusted pull-request builds.

The worker has its own build configuration and is not covered by this
pipeline: it builds plain source maps (`sourcemap: true` in
`apps/humanity-worker/vite.config.ts`), which stay in its `dist/` and are
published with it, and nothing uploads them.
