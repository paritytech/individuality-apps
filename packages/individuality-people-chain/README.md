# @individuality/people-chain

The base of the shared `packages/individuality-*` packages: the People chain
client types, what a transaction is signed with and comes back as, settling a
transaction at the best block and naming the pallet error of a failed
dispatch, and the classification of a host's failure. Both products use it,
directly or through the other shared packages.

## Entry points

`.` (`src/index.ts`):

- `PeopleApi`, `PeopleClient` (types, `client.ts`): the client a surface connects.
- `PeopleSigner`, `DispatchResult` (types, `types.ts`): what a transaction is
  signed with and what it comes back as.
- `submitToBestBlock`, `toDispatchResult`, `dispatchErrorName`,
  `isNonceRefusal`, `isTrackingStopped`, `abortError`, `TxEvent` (`submit.ts`).
- `classifyHostFailure`, `chainVerdict`, `walkTags`, `HOST_FAILURE_CLASSES`,
  `HostFailureClass`, `ChainVerdict` (`host-failure.ts`).

## Used by

`apps/jollity-app`, `apps/jollity-worker`, `@individuality/name-link`,
`@individuality/sign-up`, `@individuality/game-outcome`,
`@individuality/prize`, `@jollity/game-chain` and `@jollity/protocol`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. Peer dependencies: `polkadot-api`, `@polkadot-api/signers-common` and
`@parity/product-sdk-descriptors`, so a product hands in its own instance.

Rules for changing this package: [`AGENTS.md`](AGENTS.md).

## Testing

From the repository root:

```bash
npm test -w @individuality/people-chain
npm run typecheck -w @individuality/people-chain
```

`npm run test:shared` runs the tests of every `individuality-*` package.
