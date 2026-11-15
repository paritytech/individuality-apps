# @individuality/daily-dollar

The Daily Dollar, the same in every product: the people-airdrop draw and a
person's standing in it (`draw.ts`), and the registry core (`registry.ts`):
the draw record, the parsing of untrusted storage, the chain standing folded
into records, the registration gate, and the registration, scratch and cancel
reducers. A product instantiates it with `createDailyDollarRegistry` over its
own record (`COMMON_RECORD_FIELDS` when it adds none) and keeps its defaults,
its planners (Jollity's notifications and chat), its storage key and store,
and the chain calls that register and claim.

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
