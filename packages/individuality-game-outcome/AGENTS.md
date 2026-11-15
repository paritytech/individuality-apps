# @individuality/game-outcome

What a game gave the player, as it lands on the People chain, before the game
settles where the chain allows it: the player's attendance (`attendance-rule.ts`,
`attendance.ts`, `attendance-watch.ts`), the settle (`settle.ts`), reads
repeated until something has arrived before it (`before-settle.ts`), and the
credits the game earned (`credits.ts`). **`/chain`** reads the credits on the
chain pair the nfts SDK reads (`readGameCredits` over `claimsChain`). Which
collectable a credit becomes, and its art, stays in the product.

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
