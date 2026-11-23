<p align="center">
  <img src="assets/app-icon.png" alt="Humanity" width="200" height="200" />
</p>

# Humanity

The Humanity Prizes SPA — personhood card, weekly game, and daily-dollar prize over the
Individuality People-chain runtime, running as a product inside a Polkadot host (the Polkadot app
on a phone or desktop, or a web host). A person sees
their Membership card and where they stand on the road to Membership, claims a username, and
scratches a daily ticket for a chance at a dollar. It reads the chain and signs through a host (a
Polkadot app, or a local `truapi-host` for development), so a dev run needs both.

Humanity shares this repository, its npm workspace and its lockfile with Jollity, the weekly game
it hands players to.

| Package | Port | What it is |
| :-- | :-- | :-- |
| `apps/humanity-app` | 5183 | The SPA (`@humanity/app`), with Humanity's scripts, deploy manifests, docs and assets. |
| `apps/humanity-worker` | — | The headless worker (`@humanity/worker`) that draws the Pocket card, the product's second executable. |
| `packages/humanity-shared` | — | Framework-free host, chain and domain code both executables run (`@humanity/shared`), and the `.papi` chain descriptors. |

## Prerequisites

- Node `>= 24` (see [`.nvmrc`](../../.nvmrc)), npm

## Install

```sh
npm ci
```

Run it at the repository root: it covers both products' workspaces. `@humanity/shared`'s
`postinstall` regenerates papi descriptors from the committed metadata (no network needed).

## Scripts

Run everything from the repository root. The unprefixed root scripts (`dev`, `dev:host`, `build`,
`test`, `lint`, `typecheck`) are Jollity's; Humanity's carry the `humanity:` prefix:

| Script | What it does |
| :-- | :-- |
| `npm run humanity:dev` | The SPA on <http://localhost:5183/>, with no signing host |
| `npm run humanity:dev:host` | The SPA hosted by a local `truapi-host` ([below](#hosted-against-the-real-chain)) |
| `npm run humanity:build` | Builds the app, then the worker |
| `npm run humanity:test` | Every Humanity workspace's tests |
| `npm run humanity:lint` | Every Humanity workspace's lint |
| `npm run humanity:typecheck` | Every Humanity workspace's typecheck |
| `npm run humanity:setup` | Builds and deploys ([`scripts/setup.ts`](scripts/setup.ts), [Deploy your own](#deploy-your-own)) |
| `npm run humanity:dotns:resolve` | Reads a name's DotNS records |
| `npm run humanity:pocket:faces` / `:publish` | The Pocket card faces and records ([`POCKET.md`](../humanity-worker/POCKET.md)) |

Anything else runs on its workspace: `npm run format -w @humanity/app`,
`npm run papi:update -w @humanity/shared`.

### Conventions

- A change that adds, re-keys or re-gates a query the home reads updates
  [`docs/data-flow.md`](docs/data-flow.md) in the same change.
- One lockfile for both products. A package both use resolves to one version
  (`apps/jollity-worker/src/hostStack.test.ts` fails on a second copy of `@parity/truapi` or
  `@parity/product-sdk-host`), so a shared dependency is bumped for both, and both products'
  checks run.
- `@parity/product-sdk*` packages are pinned exactly, at the root's version, in every manifest
  (`apps/jollity-app/lib/contracts/sdk-contract.test.ts`). Bump them together, for both products.
- Humanity's scripts, deploy manifests, docs and assets live in `apps/humanity-app` (`scripts/`,
  `deploy/`, `docs/`, `assets/`).

## Run

```sh
npm run humanity:dev       # http://localhost:5183/
```

That serves the app against the live chain with no signing host, which is enough for the shell and
the read-only screens. For the full product — identity, chain reads and signing — run it against a
local host, below.

### Hosted, against the real chain

Runs the SPA as a real product in a plain browser tab, signing as a local testnet identity, with
the [`truapi-host` CLI](https://github.com/paritytech/trinity-user-agents#install-the-cli)
(prebuilt, self-updating). Install the version equal to `@parity/truapi` in `package-lock.json`:
the CLI ships in the same release as that library and the two speak one wire codec, so a skew
fails pairing. `npm run humanity:dev:host` warns when the installed CLI's major.minor differs. The
username claim needs the unwatermarked signing calls added in
[trinity-user-agents#731](https://github.com/paritytech/trinity-user-agents/pull/731), which the SPA
makes on the truAPI client directly — the shared lockfile resolves one `@parity/truapi`, the copy
`@parity/product-sdk-host` also resolves to (`apps/jollity-worker/src/hostStack.test.ts` fails on a
second), so the SPA and the SDK never hold two clients:

```sh
export TRUAPI_HOST_VERSION=$(node -p "require('./package-lock.json').packages['node_modules/@parity/truapi'].version")
curl -fsSL https://raw.githubusercontent.com/paritytech/trinity-user-agents/main/scripts/truapi-host-installer.sh | bash
export TRUAPI_HOST_NO_UPDATE=1
npm run humanity:dev:host                              # paseo-next-v2, product `peopl.paseo`
npm run humanity:dev:host -- --network previewnet      # previewnet, product `peopl.testnet`
```

[`scripts/dev-host.mjs`](scripts/dev-host.mjs) starts `truapi-host dev` — a signing host on loopback that waits for its
signer and then runs the Vite dev server with `VITE_NETWORK` set to match. `vite dev` injects the
host's `bootstrap.js` into `index.html`, which parks a `MessagePort` on `window.__HOST_API_PORT__` —
the same thing native hosts inject — so the SDK talks to the host for identity, chain reads and
signing exactly as it would inside a web host or the mobile apps. The tag is dev-only and never part of a
build. Ctrl-C stops both.

The host wants the full DotNS name as product id (`peopl.testnet` / `peopl.paseo`); the SPA keeps the
bare `VITE_DOTNS_PRODUCT_LABEL=peopl` and adds the network's suffix itself, so both agree. That name
is also the id the person's ring-VRF keys derive from, so the app owns those keys here exactly as it
does inside a phone: when the host holds none for a ring yet, the app registers its own
(`personhood-ring-key.ts`), and the card reads Membership straight off the ring. See [`STATES.md`](STATES.md).

The signer identity lives in the repo, in the git-ignored `apps/humanity-app/.truapi-host/` (passed to the CLI as
`--base-path`). The first run creates a lite person for it — about a minute with no output at the
default log level (`TRUAPI_HOST_LOG=debug` shows it registering the username and waiting for the
ring) — and prints `Paired with <name>.NN`; every later run reuses it. Delete `.truapi-host/` for a
fresh person. `HOST_SESSION=<name>` is a second, independent one (`.truapi-host/<name>/`), and its
person is named after the slot; `HOST_USERNAME` overrides the name if the identity backend reports
it taken. Confirmations are approved automatically.

To run as an identity that already exists — the one your phone holds, say — pass its mnemonic the
way the CLI expects and skip the throwaway person. Use a testnet-only identity: the phrase sits in
your shell and the host's local state.

```sh
HOST_CLI_SIGNER_MNEMONIC="…" HOST_SESSION=phone npm run humanity:dev:host -- --network paseo-next-v2
```

The CLI finds that identity's lite person (owned by its `peopl.<tld>/0` account), pairs with its username, and the card
reads the phone's `peopl.<tld>` keys as its own — verified on paseo-next-v2, where a phone-made
person resolves as a Member. Older CLIs pinned their reserved keys to `peopl.dot`, so a phone-made
person paired nameless and the card reported the account unavailable.

A person the CLI creates is a `peopl.<tld>` Devicehood like one made by a phone, and the card reads
it off the ring by key. People created by an older CLI hold `peopl.dot` keys the key read will not
find; delete their `.truapi-host/<slot>/` and onboard fresh. To make a local person a Member, run a
Membership faucet for the same network, where the network offers one, with the mnemonic from
`.truapi-host/<slot>/…/accounts.json` — a faucet that derives the same `//peopl.<tld>//index_bytes(0)`
the app registers makes the card flip on the next load.

Several instances run side by side — another session, another network: each run takes the first
free host/app port pair from 9955/5183 upward and points its bridge at its own host (`HOST_PORT` /
`APP_PORT` pin them). `VITE_HOST_BRIDGE_URL=off npm run humanity:dev` runs plain dev without the bridge.

#### With the worker

`HOST_WORKER=1 npm run humanity:dev:host` also runs the worker (`apps/humanity-worker`): its vite in watch mode
(`vite build --watch --outDir dist-dev`, `VITE_NETWORK` matching) rebuilds
`apps/humanity-worker/dist-dev/index.js` on every change, and the launcher passes it to the host as
`truapi-host dev --worker-bundle`. Released CLIs reject that flag until
[trinity-user-agents#1061](https://github.com/paritytech/trinity-user-agents/pull/1061) lands, so the worker
is off by default; turn it on with a source build of that PR (`make headless install` in a
trinity-user-agents checkout).

### Debug panel

The app has a "state" debug panel: the card's chain reads, the host calls and log lines, a scenario
override for the card, Sentry probes, and buttons that send the person's own transactions early
(personhood registration, alias binding, DotNS name claim, Daily Dollar registration and claim,
clearing expired reservations). It signs only as the user's own host accounts; it holds no keys of
its own. It is gated at build time by `VITE_DEBUG_PANEL`
([`packages/humanity-shared/src/config/debug-panel.ts`](../../packages/humanity-shared/src/config/debug-panel.ts)):

- unset: present in `npm run humanity:dev`, absent from a production build;
- `true`: built into any build, a deployed one included;
- `false`: left out of every build.

When it is off, the panel, its `/debug` and `/status` routes and its stylesheet fold out of the
bundle. When it is in, it opens with `Cmd`/`Ctrl`+`D`, or five quick taps in the top third of the
screen.

## Build and check

For the dedicated username flow, see [claiming a username against a local host](docs/username-claim-headless.md).

```sh
npm run humanity:build       # production build of the two shipped packages: the SPA, then the worker
npm run humanity:typecheck
npm run humanity:test
npm run humanity:lint
```

To autofix lint, run `format` on the workspace: `npm run format -w @humanity/app`
(or `@humanity/worker`, `@humanity/shared`).

## Configuration

Copy `apps/humanity-app/.env.example` to `apps/humanity-app/.env.local` to override the defaults
(network, WS endpoint, product label, log level, debug panel, Sentry DSN, deploy settings). Every
variable has a working default on the hosted networks. Selecting `local` requires the four chain variables below.

`VITE_NETWORK` names the hosted networks `paseo-next-v2` (the default) and `previewnet`. Jollity
calls the first one `paseo` (`NEXT_PUBLIC_NETWORK_NAME`): it is the same network, with DotNS
names under `.paseo`; previewnet's are under `.testnet`.

Error reporting is off unless you build with your own `VITE_SENTRY_DSN`; usernames and account
addresses stay out of reports unless you also set `VITE_SENTRY_SEND_IDENTITY=true`. What the app
reports, per user story, and what it does not yet: [`docs/telemetry.md`](docs/telemetry.md).

### A reset previewnet

Previewnet's genesis rotates on every reset, and `packages/humanity-shared/src/chain/networks.ts`
carries the hashes of the last one it was checked against. To build for a reset previewnet
before that table is updated, set `VITE_PEOPLE_GENESIS_HASH` and `VITE_ASSET_HUB_GENESIS_HASH`
(`0x` and 64 hex characters each). They replace the hosted network's hashes and keep its
endpoints; a malformed value is reported and ignored, and both are ignored for `local`.

### Local chains

Set `VITE_NETWORK=local` explicitly to use your own People chain and Asset Hub. Empty or absent
`VITE_NETWORK` still selects `paseo-next-v2`; `previewnet` is unchanged. Local uses PAS with
10 decimals and the `.testnet` DotNS suffix (`peopl.testnet`, `dim2.testnet`).
The existing username parser already strips `.testnet`.

Both executables require these build variables:

| Variable | Value |
| :-- | :-- |
| `VITE_LOCAL_PEOPLE_WS_URL` | People chain `ws://` or `wss://` URL |
| `VITE_LOCAL_PEOPLE_GENESIS_HASH` | People chain block-zero hash |
| `VITE_LOCAL_ASSET_HUB_WS_URL` | Asset Hub `ws://` or `wss://` URL |
| `VITE_LOCAL_ASSET_HUB_GENESIS_HASH` | Asset Hub block-zero hash |

URLs must have a host and no credentials or fragment. Hashes must be `0x` followed by exactly
64 hexadecimal characters. Values are trimmed and genesis hex is stored in lowercase.
Missing or malformed values stop Vite config resolution with an error naming the variable,
and network resolution applies the same checks.
Unit tests pin a hosted network and skip the config check in Vite test mode. Build and development
modes still validate local settings. The local People endpoint always comes from
`VITE_LOCAL_PEOPLE_WS_URL`; `VITE_PEOPLE_WS_URL` is ignored on local. Local variables are ignored on the hosted networks.

The app and worker both read env files from `apps/humanity-app`, including `.env.local`, so
`npm run humanity:build` uses the same file settings for both executables. Exported shell variables
take precedence. The app uses the same directory for `npm run humanity:dev`.
This selects chains; it does not start nodes, configure a host, or provide compatible runtime
metadata. Use a host configured for the same chain hashes and `.testnet` product names.

Local is for builds and development. `npm run humanity:setup` rejects it because `DEPLOY_TARGETS`
has no local Bulletin or DotNS deployment environment. The existing `humanity:dev:host` launcher
supports the two hosted networks only; start a host configured for local chains separately.

Local covers Humanity only.

## States

[`CONTEXT.md`](CONTEXT.md) is the glossary: the words to use for the states a
person moves through. [`STATES.md`](STATES.md) is the model behind it — the
two roads to Membership, the runtime write behind every transition, and what
this app has to read to see each one.

## Chain

| | |
| :-- | :-- |
| Network | Paseo Next V2 People (`Paseo People Next`) |
| WS | `wss://paseo-people-next-system-rpc.polkadot.io` |
| Genesis | `0x4a2b5b737de1da59e209b0000a876ec2fa20035dc34fd292a848da32d255ad48` |
| Token | `PAS`, 10 decimals |

Chain types are **generated, never hand-written**, and `@humanity/shared` owns them.
`packages/humanity-shared/.papi/metadata/people.scale` is committed; `.papi/descriptors/` is generated and
git-ignored. After a runtime upgrade run `npm run papi:update --workspace @humanity/shared` and
commit the refreshed metadata — stale descriptors typecheck clean but fail at runtime with
`Incompatible runtime entry Storage(...)`.

What the home reads, in what order, and what it shows while it waits: [`docs/data-flow.md`](docs/data-flow.md).

## Deploy your own

Humanity is published on chain as a product: a DotNS name whose records point at the app and the
worker on Bulletin, plus a product manifest. `npm run humanity:setup`
([`scripts/setup.ts`](scripts/setup.ts)) builds both executables and publishes them through the
[`bulletin-deploy`](https://www.npmjs.com/package/bulletin-deploy) CLI, manifest included. You need:

- **Your own DotNS name** on the target network: a bare label (`DOTNS_LABEL`), served as
  `<label>.testnet` on previewnet or `<label>.paseo` on paseo-next-v2.
- **Your own signing account**: the 12- or 24-word phrase of the account that owns that name and
  holds a balance on the network's Asset Hub (`DOTNS_MNEMONIC`, or `MNEMONIC`). Keep it in the
  git-ignored `apps/humanity-app/.env` or export it; never commit it. Setup refuses to deploy without
  it rather than let `bulletin-deploy` fall back to its public dev phrase.
- **`bulletin-deploy >= 0.25.0`** on `PATH`. The root's `npm run deploy -- humanity <network>`
  ([`DEPLOYMENT.md`](../../DEPLOYMENT.md)) runs setup with a pinned 0.25.0 there; to run setup
  directly, `npm install -g bulletin-deploy@0.25.0` first. v0.25.0 added `DotNS.connect({ env })`,
  which the Pocket card step connects with; v0.19.0 added the manifest's `trustedProducts` grants.

```sh
DOMAIN=mylabel.testnet DOTNS_MNEMONIC="…" npm run deploy -- humanity previewnet    # from the root
npm run humanity:setup -- --env preview --dry-run    # the plan, no chain touched, no secret needed
DOTNS_LABEL=mylabel DOTNS_MNEMONIC="…" npm run humanity:setup -- --env preview
```

| Variable | What it sets |
| :-- | :-- |
| `DOTNS_LABEL` | The bare label the deploy is served under and, unless `--product-label` says otherwise, the product the bundles act for. Required for a deploy; a `--dry-run` plans for `peopl` without it. |
| `DOTNS_MNEMONIC` / `MNEMONIC` | The phrase that owns the name and signs the deploy. Required for a deploy. |
| `BULLETIN_ENV` | `preview` or `paseo-next-v2`; empty follows `VITE_NETWORK`. |
| `BULLETIN_DEPLOY_PUBLISH` | `true` to also list the name in the Publisher registry; neither target has one today. |
| `HUMANITY_TRUSTED_PRODUCTS` | Cross-product grants in the manifest; empty grants none ([Product manifest](#product-manifest)). |
| `HUMANITY_STACK_LINK_PREVIEW`, `HUMANITY_STACK_LINK_PASEO_NEXT_V2` | The network's Trinity stack descriptor link that the TLD and gateway are checked against; paseo-next-v2 has no default, so that check is skipped unless you set it. `HUMANITY_SETUP_SKIP_STACK_CHECK=1` skips it everywhere. |
| `VITE_*` | The build's configuration ([`.env.example`](.env.example)); `VITE_SENTRY_DSN` turns on error reporting to your own Sentry project ([`docs/telemetry.md`](docs/telemetry.md)). |

`--product-label <label>` serves the bundles under one name while they act for another: a preview or
staging name that must read the same product account as your main name. `--build-only` and
`--skip-build` split the build from the upload; `--help` lists the rest.

The app's version in `apps/humanity-app/package.json` is the `appVersion` the app and worker
records carry, so bump it to move the on-chain version.

### Product manifest

[`deploy/bulletin-deploy.config.ts`](deploy/bulletin-deploy.config.ts) is the product manifest. Passing it via `--config` makes the
deploy write the name, icon, and `app.<name>` executable records instead of a bare contenthash,
which is what recent hosts resolve a product from. `npm run humanity:setup` passes it automatically, along
with the full `<label>.<tld>` positional domain and a matching `DEPLOY_DOMAIN` — the CLI compares
the two verbatim and aborts on any mismatch. Use `--no-manifest` for a contenthash-only deploy.

The manifest also carries `trustedProducts`, the cross-product grants a host honours without a
prompt, read from `HUMANITY_TRUSTED_PRODUCTS` at deploy time. Unset, a deploy grants nothing. The
format is a JSON object from a bare product label to its grants:

```sh
HUMANITY_TRUSTED_PRODUCTS='{"dim2":["context","storage"]}'
```

`context` lets that product act as this product's account — sign as it, prove with its ring-VRF
keys — which is what lets a lite person sign up for the weekly game from the game SPA in one tap
(see [`docs/cross-product-game-signing.md`](docs/cross-product-game-signing.md)). `storage` lets it
read this product's host storage. Grant only products whose names you own or trust on that network:
whoever owns a label there controls what it runs. Hosts read the grants from the on-chain root
manifest, so they take effect on the next deploy of each network (on paseo, the release name gets them
through a Humanity release; its `manifest` scope copies only the grants) and need a host on truapi 0.17
or newer. Keys are bare labels — never `dim2.paseo`.

The app icon exists twice, on purpose. `apps/humanity-app/deploy/icon.png` is the **square** one the manifest
publishes: hosts apply their own platform mask (iOS squircle, Android adaptive), so a pre-rounded
icon would be masked twice. `apps/humanity-app/assets/app-icon.png` is the same artwork **pre-masked** as a squircle,
for the surfaces that render it raw — this README's header, and
`apps/humanity-app/src/assets/icon.png` (the same squircle at 256px) as the browser-tab favicon.
Replacing the artwork means replacing all three.

The manifest lives in `deploy/` rather than the app's root on purpose: bulletin-deploy
auto-discovers a config by walking up from the build directory, and every deploy here passes it
explicitly through `npm run humanity:setup`, so an implicit discovery would only ever be a second, silent
path to the same file. Its `appVersion` is read from `apps/humanity-app/package.json`, so a version
bump is what moves the on-chain version.

`peopl` is the RFC-0022 governance-reserved personhood id, so it is claimed through DotNS's
`registerReserved` path: only an account that already owns the name, or is whitelisted for reserved
labels on that network, can bind it. The build compiles the deploy's label into
`VITE_DOTNS_PRODUCT_LABEL`, so the product account the host signs with is
`//product//<label>.<tld>/0` — `.testnet` on previewnet and `.paseo` on paseo-next-v2 are two
different accounts. The person keys the card reads are `//peopl.<tld>//index_bytes(0|1)`, the
personhood id one tree over, and only a product whose label is `peopl` registers those keys. A
deploy under any other name is a different product to the host: it does not register those keys,
and acting as the person's identity account needs a `peopl` context grant
([below](#identity-account-peopl0)).

### Identity account (`peopl/0`)

A person's identity account is account 0 of the personhood product, `//product//peopl.<tld>/0`
([RFC-0028](https://github.com/paritytech/trinity-user-agents/blob/021ead4b337a369ad1ab63509269ef5887981ffc/docs/rfcs/0028-personhood-identity-account.md)).
It owns both DotNS usernames (lite `name.NN` and membership `name`) and signs the lite reservation,
the consumer registration and the `register_name` claim. Humanity is `peopl.<tld>`, so it signs as
that account's owner with no grant and no host prompt; other products need a `peopl` context grant.
An earlier `uid.<tld>` identity product is retired, with no fallback and no migration.

## Worker

The product ships **two executables**. The second is a headless worker whose one job is drawing
the Humanity **Pocket card** ([`src/pocket-card.ts`](../humanity-worker/src/pocket-card.ts)): it reads
the person's card exactly as the app does and hands the host the face to draw.

The Daily Dollar no longer runs here. Its chat lines and background registration live in
Jollity's chat worker, and so do the Daily Dollar pushes. While it is open the app still
registers for open draws.

It lives in [`apps/humanity-worker/src`](../humanity-worker/src) (entry `main.ts`) and is
built by `apps/humanity-worker/vite.config.ts` into `apps/humanity-worker/dist/index.js`: one
ASCII-only ESM file, because the host loads the `entrypoint` by path and reads worker JS as
Latin-1. Build it alone with `npm run build -w @humanity/worker`; `npm run humanity:build` builds it right after the
app, so every build proves it bundles.

It reaches a device only as the **manifest's `worker` executable** (`includes.pocket`, with `includes.chat` false), so only
`npm run humanity:setup` ships it, and `--no-manifest` deploys the app without it. The worker runs in a hidden WebView
with no UI, which is why it is its own package: `apps/humanity-worker/eslint.config.mjs` bans React and
every `components/`, `pages/` and `hooks/` import, and the only workspace it may depend on is
`@humanity/shared`.

The app keeps one record per account in host key-value storage, `daily-dollar:<account>`, holding
a `DrawRecord` per draw
([`@individuality/daily-dollar`](../../packages/individuality-daily-dollar/src/registry.ts))
— registration attempts, outcome, scheduled notification ids, when the ticket was scratched. The
debug panel renders it — the place to look when a notification failed to schedule or a draw was
never registered.

The draw model and registry core are shared with Jollity through
`@individuality/daily-dollar`. Humanity's defaults, storage adapter and chain
orchestration stay in `@humanity/shared`.

### What the two executables share

`packages/humanity-shared` (`@humanity/shared`) is the code both of them run: the host and truAPI calls,
the chain reads and writes, the papi descriptors under `.papi`, the domain rules (including the
Daily Dollar registry and sweep), config, logging, host storage, and identity. Import it by file:
`@humanity/shared/chain/host-api.ts`,
`@humanity/shared/airdrops/domain/daily-dollar-registry.ts`.

Nothing framework-shaped belongs there: no React, no react-query, no components, screens or
navigation. Its own ESLint config enforces that, so a hook or a `useQuery` wrapper stays in
`apps/humanity-app/src` behind the `@shared/*` alias, and only the framework-free half moves down
into the package the worker can also load.
