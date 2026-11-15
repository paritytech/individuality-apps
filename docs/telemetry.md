# Telemetry (Jollity)

Jollity can report errors, journeys, metrics and per-game logs to a [Sentry](https://sentry.io)
project. **Nothing is sent unless the deployer configures their own project.** The code has no
built-in DSN, organisation or project; a build without a DSN makes every telemetry call a no-op.
Humanity has its own switch and its own guide: [`apps/humanity-app/docs/telemetry.md`](../apps/humanity-app/docs/telemetry.md).
The full list of metrics is in [`apps/jollity-app/docs/metrics.md`](../apps/jollity-app/docs/metrics.md).

## Turning it on

All settings are build-time environment variables, read when you run `npm run build` (the app) and
`npm run build:chat` (the chat worker, which reports on its own). On `previewnet` and `paseo` the
worker build reads them from the shell only, not from `apps/jollity-app/.env.local`: a DSN placed
there reaches the app but not the worker, so export it in the shell for both builds.

| Variable | Default | What it does |
| :-- | :-- | :-- |
| `NEXT_PUBLIC_SENTRY_DSN` | empty: off | Your project's DSN. Set it to send anything at all. |
| `NEXT_PUBLIC_SENTRY_DSN_TEST` | empty | A second project's DSN. Pages and workers served from `localhost` or a loopback address report there instead, so development traffic stays out of your production project. A page served from any other origin always uses the production DSN. |
| `NEXT_PUBLIC_SENTRY_TAG` | empty | Adds a `test.tag` to events, metrics and log records, so scripted runs can be filtered out. It does nothing else. |
| `NEXT_PUBLIC_TELEMETRY_LOGS` | on | `0` sends game logs as events with an attachment instead of Sentry log items. |
| `NEXT_PUBLIC_APP_VERSION` | `package.json` version | The release is `jollity@<this>`, for the app and the worker alike. |
| `NEXT_PUBLIC_DEBUG_LOGS` | on | The on-device debug log. `0` turns off the log, its hidden sheet (five taps at the top of the screen, or Cmd/Ctrl+D), and with them the log-line breadcrumbs and the game logs below. |

## What is sent

When a DSN is set:

- **Errors and failures**, with the page, the host kind, the game index, and the player's own
  account address and username (the app as Sentry's user, the worker on its events). At most a few
  events of one kind per page session. There is no switch to leave the player's identity out while
  telemetry is on; Humanity has one (`VITE_SENTRY_SEND_IDENTITY`).
- **Journeys** (sign-up, joining a game, the game itself, the payoff) as transactions with their
  timings.
- **Metrics**: video link quality per round, frame smoothness and connection funnel steps. A link
  is named by `rtc.pair`, a short hash of the game, the round and the two players' accounts, and a
  peer by `rtc.peer`, its index in the game; neither carries another player's account. Anyone who
  knows a game's roster can recompute a pair id.
- **Debug log lines** as breadcrumbs, and the device's log of each game as **game logs**, sent in
  batches after the game and keyed to the player's account (or a device id before there is one).
  These lines name co-players by account address. Connection candidates are logged without
  addresses or ports, but the line that reports a change of the device's own local address carries
  the player's own private IP addresses.

In the app, anything shaped like a 12-word recovery phrase is redacted from messages, exceptions,
breadcrumbs, extras, tags and span data before it leaves the device
(`apps/jollity-app/lib/debug/scrub.ts`). The worker's own sender does not run that scrub; it masks
only keys named like auth, secret, credential or password. Account addresses are public on chain,
but together with usernames, device and network details they are personal data in many
jurisdictions: as the deployer, you are the controller of what you collect, and your privacy notice
should say so.

## Where it lives

- `apps/jollity-app/lib/telemetry/` — the only importer of `@sentry/react`; `init.ts` starts it.
- `apps/jollity-app/lib/journeys/` — journeys and per-round link metrics.
- `apps/jollity-app/lib/debug/` — the debug log, its scrub, and what it hands to telemetry.
- `apps/jollity-worker/src/telemetry.ts` — the worker's own small sender (no SDK).
