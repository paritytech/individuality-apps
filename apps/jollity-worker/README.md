# @jollity/worker

Jollity's chat worker: the second executable of the product, which the host
runs beside the app in a long-lived worker context. It owns the product's chat
surface and the work that must happen while the app is closed:

- registers the bot and the room, posts the rules on the first open, then
  keeps one card per game up to date, from the next game through sign-up to
  the results and what is left to collect (`src/card/`, `src/index.ts`);
- signs the player up from the card's Register button, with the prize-draw
  tickets the host signs (`src/signup.ts`, over `@individuality/sign-up`);
- asks the host for its game reminder, and books the player's own
  notifications for a game (`src/host.ts`, `src/index.ts`);
- registers the person for the Daily Dollar draws and posts their news in the
  room (`src/daily-dollar/`), and posts Humanity's membership news
  (`src/membership/`);
- keeps a TURN pass in host storage around a game the player is registered
  for, so the app can open its mesh at once;
- migrates the state it keeps in host storage, once per device
  (`src/migrations/`);
- sends its own telemetry to Sentry when a DSN is built in (`src/telemetry.ts`).

The worker navigates to the app by product name, not by path, because some
hosts drop the path; that is why every build must state the name it is
deployed under. Where a host draws less than the card design assumes, the
worker says so in plain text instead of faking it.

## Entry points

The bundle entry is `src/index.ts`. The package also exports `./card`
(`src/card/index.ts`), the card trees and copy, which the app imports so the
two surfaces word things the same way.

## Build

From the repository root:

```bash
NEXT_PUBLIC_NETWORK_NAME=paseo PRODUCT_DOTNS=my-game.paseo npm run build:chat
```

- `PRODUCT_DOTNS` is required: the DotNS name the build will be deployed to,
  the same one passed to bulletin-deploy. `PRODUCT_DOTNS=local` builds a
  worker that will never be deployed.
- `NEXT_PUBLIC_NETWORK_NAME` is required (`paseo`, `previewnet` or `local`).
- For a hosted network the build reads the shell only. It loads the app's
  `apps/jollity-app/.env*` files only when they select `local` and the shell
  does not set a network (`scripts/build-config.mjs`). Pass
  `NEXT_PUBLIC_SENTRY_DSN` and the network overrides
  (`NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL`,
  `NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX` and others listed in `scripts/build.mjs`)
  in the shell too.
- `DD_SCRATCH=worker` builds a worker that posts the Daily Dollar scratch
  card it draws itself (`src/daily-dollar/scratch-worker.ts`). Its ticket
  and claim are stand-ins, so the default (`none`) posts none.

The build writes `dist/index.js` (esbuild, ASCII output, since the host reads
worker code as Latin-1) and copies the card pictures it names from
`apps/jollity-app/public` into `dist/chat-intro` and `dist/chat-card`.

## How it ships

`deploy/bulletin-deploy.config.ts` declares `dist/` as the product's worker
executable (`entrypoint: "index.js"`, `includes: { chat: true }`), which is
what makes the host register the chat extension. Before it publishes, the
config checks that the bundle was built for the name being deployed
(`DEPLOY_DOMAIN`); `SKIP_WORKER_NAME_CHECK=1` skips that check. See
[`docs/deploying.md`](../../docs/deploying.md).

## Testing

From the repository root:

```bash
npm run test:chat
npm run typecheck -w @jollity/worker
```

`src/hostStack.test.ts` pins the host wire (the `@parity/truapi` codec version
and schema) that the app and the worker share.
