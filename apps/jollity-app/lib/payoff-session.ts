// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  payoff,
  payoffTag,
  startPayoff,
  type PayoffCommand,
  type PayoffEvent,
  type PayoffInput,
  type PayoffRoute,
  type PayoffState,
  type PayoffTag,
} from "./payoff-machine"

export interface PayoffSessionRunner {
  capture(): PayoffTag
  current(): PayoffState
  send(event: PayoffInput, tag?: PayoffTag): PayoffCommand[]
}

/**
 * Client-side route replacements mount a new page without reloading this
 * module. Keep one reducer state per game so /prize-draw and /chest are
 * adapters over one payoff journey. A document reload naturally clears
 * the registry and preserves the silent reload bootstrap contract.
 */
const sessions = new Map<number, PayoffSessionRunner>()

const createSession = (gameIndex: number, route: PayoffRoute): PayoffSessionRunner => {
  let state = startPayoff(gameIndex, route)
  return {
    capture: () => payoffTag(state),
    current: () => state,
    send(event, tag = payoffTag(state)) {
      const transition = payoff(state, { ...event, ...tag } as PayoffEvent)
      state = transition.state
      return transition.commands
    },
  }
}

export function payoffSession(gameIndex: number, route: PayoffRoute): PayoffSessionRunner {
  if (gameIndex < 0) return createSession(gameIndex, route)
  const existing = sessions.get(gameIndex)
  // A later client-side visit to the same payoff must keep the pages'
  // unconditional navigation. The ended reducer is intentionally
  // inert, so reusing it would leave Continue dead.
  if (existing && existing.current().kind !== "ended" && existing.current().route === route) return existing
  const created = createSession(gameIndex, route)
  sessions.set(gameIndex, created)
  return created
}

/** Test boundary equivalent to a fresh document load. */
export function resetPayoffSessionsForTest(): void {
  sessions.clear()
}
