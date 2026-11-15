# @individuality/prize

A won prize-draw prize: who `Game.claim_airdrop` pays (`claim-eligibility.ts`),
the claim with its retries and the reasons a claim is refused for (`claim.ts`), a claim
made once the chain would pay it (`claim-when-payable.ts`), and the prize
handed to the host's purse (`prize-sweep.ts`). **`/chain`** is the claim on the
People chain: eligibility, `claimPrize` and the prize balances
(`createPrizeChain`).

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
