// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @jollity/game-chain/game — THE PURE HALF.
 *
 * It holds the round timing and the round state machine, plain arithmetic over
 * plain data, with no papi, no descriptors and no chain client anywhere in the
 * import graph. The group arithmetic, `numberOfGroups` and `groupSeats`, comes
 * from the SDK.
 *
 * WHY IT HAS ITS OWN ENTRY POINT. The package barrel (`src/index.ts`)
 * re-exports `chain/client`, so importing ANY value from it — even
 * `calculateSnapshot`, which is nine lines of subtraction — pulls
 * polkadot-api and the generated descriptors into whatever bundle asked. The
 * app's game screen wants exactly this arithmetic and nothing else; through
 * here it gets it without the chain.
 *
 * Types are a different matter: `import type` is erased at compile, so a
 * type-only import from the barrel costs nothing and callers should keep
 * taking their types from there.
 */
export * from "./constants"
export * from "./stateMachine"
