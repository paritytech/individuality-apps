// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The bound and words of the slow notice, in a module of their own so a
 * reducer can read them without React.
 */

/** How long a payoff screen waits on the chain before it says so. The collectables screen's
 *  own wait (`payoff.chest.show`, measured over 320 opens) had a median of
 *  3.3 s and a 95th percentile of 15 s; 5 of them (1.6%) ran past 60 s. */
export const SLOW_PAYOFF_MS = 60_000

export const SLOW_PAYOFF_COPY = {
  heading: "Taking longer than usual",
  body: "Any collectables you earned this game will be in the chat when they're ready.",
} as const
