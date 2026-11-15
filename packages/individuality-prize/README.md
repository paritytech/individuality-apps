# @individuality/prize

A won prize-draw prize on the People chain: who a claim pays, the claim with
its retries and the reasons it can be refused, a claim made once the chain
would pay it, and the prize handed to the host's purse. Jollity's app, its
chat worker and its chain packages use it.

## Entry points

- `.` (`src/index.ts`), the pure rules:
  - `prizeClaimEligibility`, `CLAIM_RECOGNITIONS` (`claim-eligibility.ts`);
  - `claimWithRetry`, `CLAIM_REFUSALS`, `CLAIM_RETRY_MS` (`claim.ts`);
  - `claimWhenPayable` (`claim-when-payable.ts`);
  - `sweepPrizes`, `prizeTopUpId`, `topUpErrorOutcome` (`prize-sweep.ts`);
  - with their types (`ClaimOutcome`, `ClaimStatus`, `PayableDraw`,
    `PrizeTopUp`, `TopUpOutcome` and others).
- `./chain` (`src/chain/index.ts`): `createPrizeChain`, `claimEligibility`,
  `claimStanding`, `evaluateClaimEligibility`, `fetchPrizeBalances`,
  `prizeAssetKey`, with `PrizeChain`, `PrizeBalance`, `ScoreParticipant`. It
  is a subpath of its own so that the pure rules do not bundle the SDK and
  papi.

## Used by

`apps/jollity-app`, `apps/jollity-worker`, `@jollity/game-chain` and
`@jollity/protocol`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. Peer dependencies: `polkadot-api` and
`@parity/product-sdk-individuality`.

Rules for changing this package: [`AGENTS.md`](AGENTS.md).

## Testing

From the repository root:

```bash
npm test -w @individuality/prize
npm run typecheck -w @individuality/prize
```

`npm run test:shared` runs the tests of every `individuality-*` package.
