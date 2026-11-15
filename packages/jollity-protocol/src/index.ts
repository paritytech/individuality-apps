// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @jollity/protocol — what every part of Jollity agrees on: the game engine
 * interface (./engine), the networks and product names (./config), the host's
 * reminder and camera words, the player-name key and the TURN pass.
 */

/**
 * The context Jollity derives its sign-ups' communication key from with the
 * host's entropy (RFC-0007), with the game (`communicationKeyFrom` of
 * @individuality/sign-up). The chat and the app derive the same key for a
 * game, so whichever surface lands, the product can always derive its secret.
 */
export const COMMUNICATION_ENTROPY_CONTEXT = Uint8Array.from("jollity:comm-id", (char) => char.charCodeAt(0))

/** Where a game is in its life, as the chat card reads it. */
export type GameStatus = "idle" | "scheduled" | "active" | "reporting" | "finished"

export * from "./engine"
export * from "./config"
export * from "./host-reminder"
export * from "./camera"
export * from "./claim-words"
export * from "./player-name"
export * from "./turn-pass"
