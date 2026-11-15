# @jollity/statement-core

A People-chain statement-store client and the WebRTC signalling Jollity runs
over it. It is chain-agnostic and DOM-free apart from WebRTC types: it builds,
proves and submits statements over an injected transport, and it carries the
offers, answers and ICE candidates of the game's mesh as statements. The
Jollity app signals on it; it has no papi descriptors and no host SDK import.

## Entry points

`.` (`src/index.ts`), in layers from the bottom up:

- Statement primitives: SCALE encode, decode and prove
  (`encodeStatement`, `decodeStatement`, `buildSignedStatement`,
  `statementHash`, `keypairStatementProver`, `MAX_STATEMENT_BYTES`;
  `statement.ts`) and the node RPCs `statement_submit` and
  `statement_subscribeStatement` (`createStatementRpc`, `providerTransport`,
  `substrateClientTransport`; `rpc.ts`).
- The store seam: `StatementStoreLike`, the interface every layer above talks
  to (`store.ts`). Inside a host, `@parity/product-sdk-host`'s statement store
  satisfies it structurally; standalone, `nodeStatementStore(rpc, prover)`
  implements it over the primitives.
- The signalling transport: `statementTransport` (`statementTransport.ts`),
  the `CreateTransport` factory the mesh signals through, with the seam types
  `SignalTransport`, `SignalHandlers`, `RtcPayload` and `SignalStats`
  (`transport.ts`) and the shared expiry and error helpers in
  `statementCommon.ts`.
- The data-channel frame codec: `encodeChannelMessage`,
  `decodeChannelMessage` and the lane payloads (`dataChannel.ts`).
- The store clock: `createStoreClock` and `calibrateStoreClock`, which stamp
  statement expiries against the store's clock (`storeClock.ts`; see
  [`docs/time-and-clocks.md`](../../docs/time-and-clocks.md), Rule 2).
- The ECDH helpers sealing uses: `sharedSecret`, `encryptionKeyBytes`
  (`crypto.ts`).
- The health ladder: `classifyLadder`, `classifySignalHealth`,
  `stallTransition`, `iceRecoveryEpisode` and their types (`health.ts`), pure
  decision logic that names the first failing layer (internet, TURN
  credentials, store write, store read, signalling, ICE, media, camera).

## Used by

`apps/jollity-app`.

## Status

The package is `"private": true` and is consumed as TypeScript source from
this npm workspace (its exports point at `src/*.ts`); it is not published to
npm. Dependencies: `@noble/curves`, `@noble/hashes`, `scale-ts`.

## Testing

From the repository root:

```bash
npm run test:statement-core
npm run typecheck -w @jollity/statement-core
```

`npm run test:engines` and `npm run typecheck:engines` cover this package and
`@jollity/game-chain` together.
