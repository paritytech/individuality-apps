// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The session's clock, shared with the chrome that tweens on it.
 *
 * `lib/game-session.ts` ticks the state machine on this interval, and the
 * turn pill's fill eases over the same window, so each tick's step reads as
 * one continuous rise. The constant lives here, not in `game-session`, so the
 * animation module can read it without an `animations → game-session` edge.
 */
export const SESSION_TICK_MS = 500
