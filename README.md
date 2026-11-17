> [!WARNING]
> The following is a proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk and obtain legal advice as appropriate - DYOR.

Parity doesn’t deploy the code but may update it based on community feedback.

If you experience problems with any product or service that was built on or deployed from this code, you should contact the third party who deployed the code in its amended form, not Parity.

# individuality-apps

[![CI](https://github.com/paritytech/individuality-apps/actions/workflows/ci.yml/badge.svg)](https://github.com/paritytech/individuality-apps/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

Two reference apps for the People chain of the Polkadot individuality runtime. Both run inside a
Polkadot host (a Polkadot app, or a local [`truapi-host`](https://www.npmjs.com/package/@parity/truapi-host))
and are published as on-chain products through DotNS and Bulletin.

- **Jollity** is a proof-of-personhood video game: copy a gesture on camera with five strangers,
  vote on who was human, and let the chain settle the result, the prize draw and the collectables.
- **Humanity** is a membership card: a person's personhood and its standing, sign-up for the
  weekly game, and the prize draws.

They share one npm workspace and one lockfile; each product has its own scripts.

## What is in the repository

| Path | Product | What it is |
| :-- | :-- | :-- |
| `apps/jollity-app` | Jollity | The Next.js app (`@jollity/app`), a static export |
| `apps/jollity-worker` | Jollity | The chat worker the host runs beside the app (`@jollity/worker`) |
| `packages/jollity-*` | Jollity | The wire protocol, the two game engines (statement store and chain) and the collectables |
| `apps/humanity-app` | Humanity | The single-page app (`@humanity/app`) |
| `apps/humanity-worker` | Humanity | The worker that draws the membership card (`@humanity/worker`) |
| `packages/humanity-shared` | Humanity | Code both Humanity executables run |
| `packages/individuality-*`, `packages/shared-records` | both | People-chain reads, sign-up, name links, game outcomes, prizes and the records both apps exchange |
| `tools/eslint-plugin-architecture` | Jollity | Lint rules that keep the app's layers apart |
| `scripts/` | both | The deploy command, the dev host, the state-machine explorer and the licence tooling |
| `deploy/` | Jollity | The bulletin-deploy manifest the deploy command publishes the app and the worker with |
| `docs/` | Jollity | Architecture, the game flow, the host wire format, time keeping, known issues, telemetry and deploying under your own name |

Each app has its own README: [`apps/jollity-app`](apps/jollity-app/README.md),
[`apps/humanity-app`](apps/humanity-app/README.md).

## What you need to run it

The apps read and write a live People chain. To run them for real you need:

- **A People chain with the individuality runtime** and the game pallets: Paseo Next v2, previewnet,
  or a local node. Jollity picks one with `NEXT_PUBLIC_NETWORK_NAME` (`previewnet`, `paseo` or `local`).
- **A device-uniqueness backend** that issues TURN credentials for the video mesh, such as
  [`paritytech/device-uniqueness-backend-community`](https://github.com/paritytech/device-uniqueness-backend-community).
  A local network needs its URL in `NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL`.
- **A Polkadot host** to sign and to reach the chain: a Polkadot app, or `truapi-host` on your
  machine (`npm run dev:host` starts one).
- **Node 24** (`.nvmrc`).

**Product names are part of the protocol, not just defaults.** The hosts treat three DotNS
labels specially: `dim2` is the game product (its accounts sign the game; truapi's game reminders
answer only `dim2`), `peopl` is the personhood product (only a deploy under that label may register
the person's keys with the host), and `stash` is where collectables open. A deployment under another name still
plays as `dim2.<tld>` (`NETWORK_CONFIG.productAccount` in `packages/jollity-protocol/src/config.ts`),
so it needs a `context` grant from whoever owns `dim2` on that network. A fork that wants its own
game product changes that constant. Network endpoints and the identity backend come from each
network's signed Trinity stack descriptor (`packages/jollity-protocol/src/stacks/`, refreshed with
`npm run jollity:stacks`), and local runs set them in `apps/jollity-app/.env.example`.

## Quick start

```bash
git clone https://github.com/paritytech/individuality-apps.git
cd individuality-apps
npm ci
cp apps/jollity-app/.env.example apps/jollity-app/.env.local
```

| | Jollity | Humanity |
| :-- | :-- | :-- |
| In a browser | `npm run dev` | `npm run humanity:dev` |
| Hosted by a local `truapi-host` | `npm run dev:host` | `npm run humanity:dev:host` |
| Tests | `npm test` | `npm run humanity:test` |
| Typecheck | `npm run typecheck` | `npm run humanity:typecheck` |

In a plain browser there is no host to sign or to reach the chain, so the app shows what it can
without one. Next reads env files from `apps/jollity-app/` only.

## Deploying

Parity publishes this code; it does not run a deployment of it for you, and nothing in CI deploys.
Each product deploys with one command, with your own name and account:

```bash
DOMAIN=my-game.paseo DOTNS_MNEMONIC="your twelve word phrase …" npm run deploy -- jollity paseo
DOMAIN=my-card.paseo DOTNS_MNEMONIC="your twelve word phrase …" npm run deploy -- humanity paseo
```

[`DEPLOYMENT.md`](DEPLOYMENT.md) covers what you need first, the networks (previewnet and paseo
today; pcf-devnet, polkadot and any other stack once they pass the script's checks), what the
command does and its settings. [`docs/deploying.md`](docs/deploying.md) covers which product names
are protocol ids, the grants a deploy under your own name needs, and the defaults you inherit.
Error reporting is off unless you configure your own Sentry project; see
[`docs/telemetry.md`](docs/telemetry.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issue numbers in code comments (`#123`) refer to the
tracker used before this repository was published, which is not public.

## Security

This is a prototype, reference implementation, and proof-of-concept provided for research,
experimentation, and developer education only. It has not been audited — use at your own risk.

Before deploying this for real use cases, you are responsible for:

- Reviewing the code yourself — we publish a reference, not a hardened production build.
- Checking that the dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment (keys, secrets, network configuration).
- Tracking the latest commits for security fixes; older revisions are not backported.

Report vulnerabilities responsibly following [Parity's security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md) — do not open public issues for security reports. For Parity's disclosure process and Bug Bounty programme, see [parity.io/bug-bounty](https://parity.io/bug-bounty).

## License

Licensed under the **GNU General Public License v3.0 or later** — see [LICENSE](LICENSE).
Third-party components keep their own licences; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
