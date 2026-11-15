// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The player's username, handed from the app to the chat worker through host
 * storage, so the worker's telemetry can carry it.
 *
 * The app writes it where it learns it (lib/host/identity.ts), a JSON string.
 * Game accounts are product accounts, so the chain cannot name them, and the
 * worker has no consent screen of its own: it reads this key, and asks the
 * host for the name only when the player already gave it.
 */
export const PLAYER_NAME_KEY = "jollity.playerName"
