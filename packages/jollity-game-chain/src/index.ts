// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @jollity/game-chain answers the chain `GameEngine` for the individuality
 * People chain, over `@parity/product-sdk-individuality` and its descriptors at
 * spec 3004000.
 *
 * Callers hand it a WebSocket URL or a papi `JsonRpcProvider` and get the
 * engine back. What stays here is what the SDK does not do: the prize-draw
 * read in the shape the drum draws, the extension default for local signers,
 * the lite sign-up binding, the game timing and state machine, and the
 * signalling key from host entropy (`keys/entropy.ts`).
 */
export * from "./chain/client"
export * from "./engine"
export * from "./chain/tx"
export * from "./chain/airdrop"
export * from "./game/constants"
export * from "./game/stateMachine"
export * from "./keys/entropy"
