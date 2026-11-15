# Deploying your own copy

Both products are published on chain: a DotNS name whose records point at the
app and the worker on Bulletin, plus a product manifest the host reads. Anyone
may build and deploy them. This page is for someone doing that, and covers
what the code fixes, what a deployer chooses, and what a deploy under a name
of your own keeps and loses.

Read it with [known-issues.md](known-issues.md) (host workarounds and the
minimum host versions) and [host-wire.md](host-wire.md) (which host to run
against).

## Product names are protocol ids

The names the code uses are product ids the hosts and the chain treat
specially, not branding. A product account derives from
`//product//<id>.<tld>/<index>`, so the id decides whose account signs.

| Id | Hard-coded in | What depends on it |
| :-- | :-- | :-- |
| `dim2` | `NETWORK_CONFIG.productAccount` in `packages/jollity-protocol/src/config.ts`; `candidateProductDomain` in `packages/humanity-shared/src/chain/networks.ts` | The account Jollity plays, signs up and reports with, on every build. Humanity reads the same account. The host's game service (reminders of the next game) answers only a product whose label is `dim2` (`isGameProduct` in `apps/jollity-worker/src/state.ts`). |
| `peopl` | `personhoodProduct()` in `packages/jollity-protocol/src/config.ts`; `PERSONHOOD_LABEL` in `packages/humanity-shared/src/identity/product-domain.ts` | The personhood product. Its account 0 is the person's identity account, its lite and full keys prove a person, and only a deploy whose label is `peopl` may register those keys with the host. The Jollity worker's Daily Dollar registers as `peopl`'s account 1 (`apps/jollity-worker/src/daily-dollar/worker.ts`). |
| `stash` | `stashProduct()` in `packages/jollity-protocol/src/config.ts` and `apps/jollity-app/lib/host/stash-picks.ts` | The collectibles product whose storage Jollity reads for the player's picks, and which the chat card opens. |

`dim2` and `peopl` are reserved product ids in the Polkadot app, which
derives its built-in accounts from them. `peopl` is also a reserved DotNS
label: only its owner, or an account whitelisted for reserved labels, can
bind it (see Humanity's README).

A Jollity build therefore always plays as `dim2.<tld>`, whatever name it is
served under. `NEXT_PUBLIC_PRODUCT_DOTNS` (app) and `PRODUCT_DOTNS` (worker)
name the deploy, not the account: the app uses it as a log label and as its
key in the stale-build version file, and the worker bakes it in so the chat
card's buttons can navigate to the app by name.

### A deploy under another name

A build served as `my-game.<tld>` asks the host for `dim2.<tld>`'s account. The
host refuses another product's account (`PermissionDenied`) unless that
product's manifest grants the caller `context`. The only sign in the app is a
debug-log line (`warnOnForeignProduct` in `apps/jollity-app/lib/game-source.ts`):
reads work, and the sign-up and the report fail.

So such a deploy needs grants from the owners of the products it touches, in
their manifests, keyed by your bare label:

| From | Grant | For |
| :-- | :-- | :-- |
| `dim2`'s owner | `context` | playing: the sign-up, the report and the signalling statements |
| `peopl`'s owner | `context` | the free seat of a lite person, the draw entries of a recognized person, and the Daily Dollar in the chat |
| `peopl`'s owner | `storage` | reading the sign-ups Humanity's home made (`apps/jollity-app/lib/host/game-registration.ts`) |
| `stash`'s owner | `storage` | reading the player's picks |

The grants from `peopl`'s owner are the `HUMANITY_TRUSTED_PRODUCTS` of their
Humanity deploy, which grants nothing unless the deployer lists a product
(for the game: `'{"dim2":["context","storage"]}'`).

It loses, whatever it is granted:

- the host's game reminders, which exist only for `dim2`;
- the Humanity card's play button, which opens `dim2.<tld>` (`dim2Url` in
  `packages/humanity-shared/src/chain/networks.ts`).

A fork that wants a game account of its own changes
`NETWORK_CONFIG.productAccount` and Humanity's `PRODUCT_IDS.dim2`. Its players
start without the lite invites and scores that sit on `dim2`'s account, and
get no host reminders.

### Humanity under another name

`npm run humanity:setup` deploys under `DOTNS_LABEL`. A label other than
`peopl` is a different product to the host: it reads the person's keys but
does not register them, and acting as the person's identity account needs a
`peopl` context grant. See
[`apps/humanity-app/README.md`](../apps/humanity-app/README.md#deploy-your-own).

## Network defaults you inherit

The network table names Parity's test networks. Jollity calls them `paseo`
and `previewnet` (`NEXT_PUBLIC_NETWORK_NAME`); Humanity calls the same ones
`paseo-next-v2` and `previewnet` (`VITE_NETWORK`). Their DotNS names end in
`.paseo` and `.testnet`. `local` is a third choice in both, with every
endpoint supplied by you (each app's `.env.example`).

- **Identity and TURN backend.** Every hosted Jollity build sends the
  player's personhood proof to the network's device-uniqueness backend for
  TURN credentials: `https://identity.dotspark.app` on paseo and
  `https://identity-previewnet.dotspark.app` on previewnet
  (`packages/jollity-protocol/src/config.ts`). Set
  `NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL` to use another for both the app
  and the worker. Without TURN, players connect only on one LAN.
- **The sign-up account index.** Jollity signs up with `dim2`'s account 1,
  because the lite invites and scores on these networks sit on it
  (`signupAccountIndex()`). `NEXT_PUBLIC_SIGNUP_ACCOUNT_INDEX` changes it, and
  Humanity must read the same index (`VITE_GAME_ACCOUNT_INDEX`, default 1).
- **DotNS contracts.** The name link reads and writes through two CREATE3
  contract addresses pinned in `packages/individuality-name-link/src/dotns-names.ts`
  (`DOTNS_CONTRACTS`), the same on both networks. Another network needs its
  own.
- **Genesis fallbacks.** Jollity carries paseo's genesis hashes for a host
  whose chain discovery answers nothing, and relies on discovery on
  previewnet, whose genesis changes on every reset;
  `NEXT_PUBLIC_PEOPLE_GENESIS` and `NEXT_PUBLIC_ASSET_HUB_GENESIS` override
  them. Humanity carries both networks' hashes; after a previewnet reset set
  `VITE_PEOPLE_GENESIS_HASH` and `VITE_ASSET_HUB_GENESIS_HASH` until
  `packages/humanity-shared/src/chain/networks.ts` is updated.
- **Telemetry** is off unless you set a Sentry DSN; see
  [telemetry.md](telemetry.md).

## Deploying Jollity

Build both executables, then publish them with the manifest
[`deploy/bulletin-deploy.config.ts`](../deploy/bulletin-deploy.config.ts):

```sh
DOMAIN=my-game.testnet DOTNS_MNEMONIC="…" npm run deploy:previewnet
DOMAIN=my-game.paseo   DOTNS_MNEMONIC="…" npm run deploy:paseo
```

The deploy script refuses to run without a deploy phrase (rather than let
bulletin-deploy fall back to its public dev account, which anyone could use
to repoint your name) and pins bulletin-deploy 0.25.0. The phrase must own
the name and hold a balance on the network's Asset Hub. Never commit it.

- **Grants.** `DEPLOY_TRUSTED_PRODUCTS` lists the products your manifest lets
  read your storage or act in your context, as JSON from a bare label to
  `storage` and `context` (`deploy/constants.ts`). Unset, a deploy grants
  nothing. Humanity reads Jollity's sign-up record from `dim2`'s storage, so
  the owner of `dim2` grants `{"peopl":["storage"]}`. Name only products whose
  owners you trust: a grant lets them act as your product.
- **The worker's name check.** The manifest refuses to publish when the
  worker bundle was not built for the name you deploy to, since the chat
  card's buttons would open the wrong product, or do nothing on iOS. Build
  the worker with the same name:
  `NEXT_PUBLIC_NETWORK_NAME=<network> PRODUCT_DOTNS=<name>.<tld> npm run build:chat`.
  Hosted worker builds read their settings from the shell only, never from
  `apps/jollity-app/.env*`. `SKIP_WORKER_NAME_CHECK=1` publishes anyway.

### The stale-build switch

`NEXT_PUBLIC_VERSION_URL` (off by default) points the app at a JSON version
file. When the file names a newer build for this deploy's
`NEXT_PUBLIC_PRODUCT_DOTNS`, an older build shows its players an update
screen instead of letting them into a game (`apps/jollity-app/lib/home-gate.ts`;
`apps/jollity-app/lib/release/stale-build.ts` describes the file). It fails open: no URL, a refused grant, a network error or an
unreadable file never blocks anyone. It is still a remote switch that can
lock players out of a build, so point it only at a file you control, and set
`NEXT_PUBLIC_APP_VERSION` and `NEXT_PUBLIC_BUILD_TIME` at build time, or
every answer is "unknown".

## Deploying Humanity

`npm run humanity:setup` builds the app and the worker and publishes them
with the manifest. Its README has the variables and the flags
([Deploy your own](../apps/humanity-app/README.md#deploy-your-own)). Two
notes on the tool:

- **The stack check.** Setup checks the network's TLD and gateway against a
  Trinity stack descriptor (`HUMANITY_STACK_LINK_PREVIEW`,
  `HUMANITY_STACK_LINK_PASEO_NEXT_V2`). paseo-next-v2 has no default link, so
  that check is skipped there unless you set one;
  `HUMANITY_SETUP_SKIP_STACK_CHECK=1` skips it everywhere.
- **The Pocket card record.** bulletin-deploy drops the worker record's
  `pocket` field, so setup re-writes it after every deploy
  (`apps/humanity-app/scripts/publish-pocket-cards.mts`, also
  `npm run humanity:pocket:publish`). A plain `bulletin-deploy` run leaves the
  Humanity card on the app's placeholder.

## Minimum host versions

A player's host must speak the wire of the lockfile's `@parity/truapi`, and
some features need newer hosts still. The table is in
[known-issues.md](known-issues.md#minimum-host-versions).

## What each product needs from the other

The two products deploy separately but are not independent:

- **Jollity needs Humanity** for the person: `peopl`'s lite key (the free
  seat), its full key (a recognized person's draw entries), its account 1
  (the Daily Dollar in Jollity's chat), and its storage (the sign-ups
  Humanity's home made). Each needs a grant in Humanity's manifest.
- **Humanity needs Jollity** for the game: it reads the game, the seat and
  the score on `dim2`'s account, reads Jollity's sign-up record from `dim2`'s
  storage, and sends players to `dim2.<tld>` to play.
- **Both need the host** to treat the ids as above: `dim2` for game
  reminders, `peopl` for the person's keys and the Humanity card the host
  pins to every Pocket.

The records one product keeps in host storage for the other are defined
once, in `packages/shared-records`.
