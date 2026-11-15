# Contributing

Thanks for looking. This repository is a **prototype and reference implementation** (see the
warning at the top of the [README](README.md)). It is not audited or production software. The most
useful contributions make it easier for the next person to run, understand or fork it: bug reports
with a reproduction, documentation that was wrong or missing, and fixes that stay inside the
existing design.

Everything happens in the open: GitHub issues, pull requests and discussions.

## Before you open a pull request

Open an issue first for anything that changes behaviour, the wire format between players, or what
the apps write on chain. Small, self-evident fixes (a typo, a broken link, a wrong error message) can
go straight to a pull request.

## Setup

Node 24 (`.nvmrc`), npm (not pnpm or yarn), and one install at the root:

```bash
npm ci
cp apps/jollity-app/.env.example apps/jollity-app/.env.local
```

See the [README](README.md) for what a real run needs (a People chain, a device-uniqueness backend,
a host).

## The bar

CI runs these on every pull request; run them before you push.

| Gate | Command |
| :-- | :-- |
| Lint | `npm run lint` and `npm run humanity:lint` |
| Types | `npm run typecheck` and `npm run humanity:typecheck` |
| Tests | `npm test` and `npm run humanity:test` |
| Build | `NEXT_PUBLIC_NETWORK_NAME=paseo npm run build`, `NEXT_PUBLIC_NETWORK_NAME=paseo PRODUCT_DOTNS=example.paseo npm run build:chat` and `npm run humanity:build` |

## Conventions

- **One lockfile, one SDK version.** A dependency both products use resolves to one version in
  `package-lock.json`. The `@parity/product-sdk*` packages are pinned exactly, at the root's version,
  in every manifest; they move together for both products.
- **Docs travel with the code.** A change to a flow, a threshold, a wire shape or a user-facing
  string is not complete until the doc or comment that describes it is updated in the same PR.
  [`AGENTS.md`](AGENTS.md) and each app's guide carry the working notes; they are worth reading
  before a first non-trivial change, whether or not you use a coding agent.
- **PR titles** follow Conventional Commits with a scope that names what changes
  (`fix(jollity): …`, `feat(humanity): …`); the PR title is what lands on `main`.
- **No secrets in the tree.** No seeds, keys or tokens in code, tests or fixtures beyond the
  well-known development accounts. `.env*` files are git-ignored; `.env.example` files carry empty or
  example values only.
- **Licence header on every source file.** `node scripts/oss/headers.mjs --fix` adds it.
- **Third-party notices follow the lockfile.** After a dependency change, regenerate
  `THIRD_PARTY_NOTICES.md` with `node scripts/oss/third-party.mjs` (after `npm ci`).
- **No `Co-Authored-By:` trailers** in commit messages. They fail the paritytech org's CLA check.

## Issue numbers in the code

Comments refer to issues as `#123`. Numbers from before the first public release point into the
tracker the code was developed in, which is not public; read them as labels, not links.

## Licensing

This project is licensed under GPL-3.0-or-later. By submitting a pull request you agree that your
contribution is licensed under the same terms.

## Security

Do **not** open a public issue for a suspected vulnerability. Follow
[Parity's security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md); Parity's
disclosure process and bug bounty are at <https://parity.io/bug-bounty>. See the
[Security section of the README](README.md#security) for what this code is and is not.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
