# @jollity/protocol

What every part of Jollity agrees on: the game engine interface, the networks
and the product names a build plays under, the host storage keys the app and
the chat worker share, and the TURN pass. The Jollity app, its chat worker and
the other `@jollity/*` packages import it.

## Entry points

`.` (`src/index.ts`):

- `engine.ts`: the `GameEngine` interface the app reads the Game pallet
  through, and the pallet-shaped data it returns (`PalletGame`,
  `PalletGameState`, `PalletPlayer`, `PalletDraw`, `ReportVote` and others),
  plus `statePlayerCount` and `EngineSigner`. `@jollity/game-chain` implements
  it.
- `config.ts`: the networks a build can target (`NetworkName`: `paseo`,
  `previewnet`, `local`) and their defaults (`NETWORK_CONFIG`), with
  `network()`, `networkName()`, `productAccount()`, `personhoodProduct()`,
  `stashProduct()`, `signupAccountIndex()`, `deviceUniquenessBackendUrl()`,
  `chainGenesis()`, `assetHubNetwork()` and `localNetwork()`. The network comes
  from `NEXT_PUBLIC_NETWORK_NAME`, which has no default.
- `turn-pass.ts`: the TURN credential proof and pass (`buildTurnProof`,
  `redeemTurnProof`, `turnPassFor`, `turnPassLeftMs`, `TURN_ISSUE_PATH`,
  `turnPassKey` and their types).
- Shared storage keys and words: `HOST_REMINDER_KEY`, `CAMERA_KEY`,
  `PLAYER_NAME_KEY`, `claimRefusalWords`.
- `COMMUNICATION_ENTROPY_CONTEXT` and the `GameStatus` type, defined in
  `index.ts`.

## Product names are protocol ids

`NETWORK_CONFIG[*].productAccount` is `"dim2"`: every build plays as the
product account of `dim2.<tld>`, whatever name it is served under, and
`personhoodProduct()` and `stashProduct()` return `peopl.<tld>` and
`stash.<tld>`. These are protocol ids, not deploy settings. See
[`docs/deploying.md`](../../docs/deploying.md) for what a deployment under
another name can change and what it gives up.

## Used by

`apps/jollity-app`, `apps/jollity-worker`, `@jollity/game-chain` and
`@jollity/collectables`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its main entry is `src/index.ts`); it is not published to
npm. It has no typecheck script of its own; the app's and the worker's
typechecks compile it through their imports.

## Testing

From the repository root:

```bash
npm run test:protocol
```
