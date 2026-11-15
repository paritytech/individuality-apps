# @individuality/sign-up

Signing a player up for a People chain game, the same from every surface, on
the product SDK's game registration (`@parity/product-sdk-individuality`). The
SDK decides the seat and its route, binds the free seat and files the sign-up
with its draw entries (`readGameSeat`, `holdsLiteKey`, `bindGameSeat`,
`registerForGame`); this package is what a product does around those, and
reimplements none of them:

- the seat: the name link on top of the SDK's seat (`seat.ts`), what the
  deposit route is short of (`funds.ts`), and the flow's own bind deadline and
  read ordering (`free-seat.ts`);
- the gates before a sign-up goes: the game reminder (`reminder.ts`), a
  sign-up another surface has on its way (the game registration record of
  `@individuality/shared-records`, which the flow also writes of its own
  sign-up), and the name link, whose gate comes from
  `@individuality/name-link`;
- Jollity's draw rule: a player this game cannot make a member signs up
  without a ticket (`draw-ticket.ts`, #167), which the SDK has no rule for;
- the retry policy and the words of a failure (`signup-retry.ts`,
  `signup-failure.ts`), what the flow asks of the chain (`sign-up-types.ts`),
  and the communication identifier (`communication-key.ts`);
- **the sign-up itself** (`sign-up-flow.ts`, `createSignUpFlow`): one tap,
  seen through every gate in order until it lands or registration closes. A
  surface ties in by handing in its chain and the SDK's
  `GameRegistrationCapabilities` (the game account, its signer, the
  submission, the ticket signer and the personhood keys;
  `hostGameRegistrationCapabilities` of the SDK's `/host` entry builds them),
  and what it keeps of its own (telemetry, a log, the name gate, the game
  reminder and the registration record are all optional), and words the
  flow's `phase()` itself.
- **`/chain`**: `signUpFlowChain(client, { tld })`, the SDK's registration in
  the shape the flow reads, with the draw rule and the ticket check
  (`verifyVrf`, the capability the SDK takes and does not ship) on top. Its
  own subpath, so a screen that only reads a gate does not bundle papi and the
  SDK's chain code.

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
