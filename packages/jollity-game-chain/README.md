# @jollity/game-chain

Answers Jollity's `GameEngine` (the interface in `@jollity/protocol`) from the
Game and Score pallets of the People chain, through
`@parity/product-sdk-individuality` and its descriptors. Each engine method
maps an SDK read, or a storage read over papi where the SDK has none, onto the
pallet-shaped data the protocol carries. The package also holds the round
timing and the round state machine. It knows nothing about statements; those
are `@jollity/statement-core`'s.

## Entry points

- `.` (`src/index.ts`), the chain side:
  - `createPeopleClient` (from a WebSocket URL) and
    `createPeopleClientFromProvider` (from a papi `JsonRpcProvider`), with
    `PeopleApi`, `PeopleClient`, `WsConnectionStatus`, `PREVIEW_PEOPLE_WS`;
  - `createChainEngine`, the `GameEngine` over a People client;
  - `fetchAirdropDraw`, `fetchAirdropDraws`: the prize draws in the shape the
    draw screen reads;
  - `bindTx`, `withCustomExtensions`, `withExtrinsicLogging` (`chain/tx.ts`);
  - `commKeysFromEntropy`, `COMM_ENTROPY_CONTEXT`: the signalling encryption
    key from host-derived entropy (`keys/entropy.ts`);
  - everything in `./game` below.
- `./game` (`src/game/index.ts`), the pure half with no papi or descriptors in
  its import graph: the timing constants (`HOST_FULL_CYCLE`, `ROUND_GAP`,
  `PRE_CONNECTION_TIME`, `CONNECTION_STAGE_DURATION` and others) and the
  round state machine (`calculateSnapshot`, `hostSeat`, `roundDuration`,
  `roundStart`, `gameDuration`, `turnsInRound`, `turnsPerRound`). Screens
  import values from here so they do not bundle the chain client; types can
  come from either entry.
- `./engine` (`src/engine.ts`): `createChainEngine` alone.

The apps never derive keys from a mnemonic; they use the host's product accounts
and entropy (`src/keys/entropy.ts`).

## Used by

`apps/jollity-app`, `apps/jollity-worker`, and the root scripts (`scripts/*.mts`
and `scripts/lib/`).

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm.

## Testing

From the repository root:

```bash
npm run test:game-chain
npm run typecheck -w @jollity/game-chain
```

`npm run test:engines` and `npm run typecheck:engines` cover this package and
`@jollity/statement-core` together.
