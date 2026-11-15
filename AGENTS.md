# Working in this repository

This repository holds two products for the People chain: **Jollity** (the game) and **Humanity**
(the personhood card). They share one npm workspace, one lockfile and the shared packages below,
and nothing else. This file maps the repository and holds the rules for both. Each product's own
guide is next to its app: read it before you change that product.

| Folder | Whose | Guide |
| :-- | :-- | :-- |
| `apps/jollity-app` (`@jollity/app`), `apps/jollity-worker` (`@jollity/worker`), `packages/jollity-*` | Jollity | [`apps/jollity-app/AGENTS.md`](apps/jollity-app/AGENTS.md) |
| `scripts/`, `deploy/`, `tools/`, `docs/` | Jollity | the same |
| `apps/humanity-app` (`@humanity/app`), `apps/humanity-worker`, `packages/humanity-shared` | Humanity | [`apps/humanity-app/README.md`](apps/humanity-app/README.md) |
| `packages/shared-records` (`@individuality/shared-records`) | Both | the records one product keeps in host storage for the other to read: shape, key, lifetimes and the store over them, with no product or SDK imports; each product hands the store its own storage handle. A change runs both products' tests (`test:shared-records`). |
| `packages/individuality-*` (`@individuality/people-chain`, `name-link`, `sign-up`, `game-outcome`, `prize`, `daily-dollar`) | Both | each package's `AGENTS.md` |

Each product's glossary is the `CONTEXT.md` next to its guide:
[Jollity's](apps/jollity-app/CONTEXT.md), [Humanity's](apps/humanity-app/CONTEXT.md).

Coding agents read the `AGENTS.md` files from the repository root down to the
folder they work in, so when you start at the root, open the product's guide
yourself. A rule for one product goes in its guide, a rule for both goes here.

## Rules for both products

- **One lockfile.** npm, not pnpm or yarn, and `npm ci` at the root. A
  dependency both products use resolves to one version in
  `package-lock.json`: bump it for both, and run both products' checks.
- **One SDK.** Every manifest pins the `@parity/product-sdk*` packages
  exactly, at the root's version
  (`apps/jollity-app/lib/contracts/sdk-contract.test.ts`), and the workspace
  holds one `@parity/truapi` and one `@parity/product-sdk-host`
  (`apps/jollity-worker/src/hostStack.test.ts`). They move together, for both
  products. Re-verify on every SDK bump what the type checker cannot see:
  `packages/humanity-shared/src/chain/extension-pipeline.ts` and the signer
  wrappers that use it cast the SDK's signer to an internal call shape and
  port SDK-internal encodings (its header says how to check them), and
  `hostStack.test.ts` pins the host wire (see `docs/host-wire.md`).
- **Shared packages.** `packages/individuality-*` are packages any product
  can import, one concern each, and a product takes only the ones it needs.
  They sit between `@parity/product-sdk-individuality` and the products: the
  SDK holds the People chain's game code (the seat, the bind, the sign-up
  with its draw entries, the encodings), the packages hold what a product
  does around it, and never a second copy of it:
  - `@individuality/people-chain`: the base, the People chain client types,
    what a transaction is signed with and comes back as, and the words of a
    host's failure;
  - `@individuality/name-link`: the player's DotNS name on the prize draw,
    its PGAS deposit, and the gate a sign-up waits on;
  - `@individuality/sign-up`: one sign-up flow for any surface to run,
    around the SDK's `registerForGame`: every gate before a sign-up, the
    retries, the registration record and Jollity's draw rule, with its
    SDK-backed chain side under `/chain`;
  - `@individuality/game-outcome`: attendance, the settle, and the credits a
    game earned, as they land;
  - `@individuality/prize`: who a claim pays, the claim and its sweep into
    the host's purse, with its chain side under `/chain`.
  - `@individuality/daily-dollar`: the Daily Dollar draw model and pure
    registry core: parsing, reconciliation, registration planning and
    reducers. Each product retains its own extra record fields, planner
    defaults, storage and chain I/O; Jollity owns chat and notifications.

  They import no product's package, so any product can tie in without the
  other's code, and the products depend on them, never the reverse. Each
  entry names what it exports (no `export *`), and papi and the Parity SDKs
  are peer dependencies, so a product shares its own instance. CI runs their
  tests.
- **Root scripts.** The unprefixed ones (`dev`, `dev:host`, `build`, `test`,
  `lint`, `typecheck`, …) are Jollity's; Humanity's carry the `humanity:`
  prefix. Run them from the root. The root is CJS (`"type"` unset), so a
  standalone TypeScript script under `scripts/` must be `.mts`.
- **CI.** `.github/workflows/ci.yml` runs every check for both products on
  each pull request: licence headers and notices, then each product's lint,
  typecheck, tests and build.

## PR titles

A squash merge lands the PR title on `main`, so the title says which product a
change is for:

- **Format** `<type>(<scope>): <summary>`. The type is one of `feat`, `fix`,
  `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert` or
  `style`. The summary is imperative, written for the release-note reader.
- **The scope is required:** the folder name of the workspace the PR changes.
  - Jollity: `jollity-app`, `jollity-worker`, `jollity-collectables`,
    `jollity-game-chain`, `jollity-protocol`, `jollity-statement-core`.
  - Humanity: `humanity-app`, `humanity-worker`, `humanity-shared`.
  - A package both products use, with no product prefix: its folder name
    (`feat(shared-records): …`).
  - Several folders of one product: `jollity` or `humanity`, or the folders
    comma-separated (`fix(humanity-app,humanity-worker): …`).
  - Both products: `repo` for root config, tooling, workflows and shared
    docs; `deps` for dependency and lockfile bumps.
- Examples: `feat(humanity-app): show the draw countdown on the card`,
  `fix(jollity-worker): rebook pending Daily Dollar pushes`,
  `ci(repo): run the licence check on every workflow`.
