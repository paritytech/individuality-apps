# @individuality/name-link

The player's name on the prize draw wheel: the DotNS reader (`dotns-names.ts`),
`linkName` (look up, fund in PGAS or the native deposit with the host's
allowance, sign as the root, store, note, verify; `link.ts`), and the gate a
sign-up waits on (`name-gate.ts`). The sign-up (`@individuality/sign-up`) takes
the gate; the Jollity app reads names off it for the wheel.

Rules, as for every `packages/individuality-*` package (root `AGENTS.md`,
"Shared packages"):

- **No product's package.** Nothing here imports `@jollity/*` or `@humanity/*`:
  the products depend on these packages, never the reverse.
- **Framework-free and host-free.** No React, and no call into the host SDK
  (its types at most). What only a product can reach comes in as arguments,
  and the product keeps its own words.
- **A named surface.** `index.ts` names what it exports, never `export *`:
  a helper only this package uses stays out of it.
- **Peers, not copies.** papi and the Parity SDKs are peer dependencies, so
  a product hands in its own instance; only pure libraries are dependencies.
- **Every importer's checks.** CI (`.github/workflows/ci.yml`) runs both
  products' checks on every pull request. Before you push, run the tests of
  every product that imports the package (`npm test` for Jollity,
  `npm run humanity:test` for Humanity).
