// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface VideoRoleWindow {
  /** zero-based round containing both the delayed sender and reload viewer */
  round: number
  enableAtTurn: number
  disableAtTurn: number
}

export type GroupSeats = (ownIndex: number, playerCount: number, maxGroupSize: number) => readonly { occupied: boolean; index: number }[]

/** The co-players in one finalized game group. */
export function gameGroupPeers(round: readonly string[], self: string): string[] {
  return [...new Set(round.filter((account) => account !== self))].sort()
}

/** Every distinct peer this player shares any game round with. The mesh opens
 * this union ahead of time, which explains why a hook fired before the last
 * round can see more connections than that round's active group. */
export function sharedGamePeers(rounds: readonly (readonly string[])[], self: string): string[] {
  return [...new Set(rounds.flatMap((round) => gameGroupPeers(round, self)))].sort()
}

/** Actual shared rounds from the pallet's finalized per-round shuffled indices. */
export function sharedGroupRounds(ownIndices: readonly number[], peerIndices: readonly number[], playerCount: number, maxGroupSize: number, rounds: number, seatsFor: GroupSeats): number[] {
  if (!Number.isInteger(rounds) || rounds < 1 || ownIndices.length < rounds || peerIndices.length < rounds)
    throw new Error(`group overlap needs ${rounds} rounds of indices (got ${ownIndices.length} and ${peerIndices.length})`)
  if (!Number.isInteger(playerCount) || playerCount < 2 || !Number.isInteger(maxGroupSize) || maxGroupSize < 2)
    throw new Error(`invalid group geometry: ${playerCount} players, max group size ${maxGroupSize}`)
  const valid = (index: number) => Number.isInteger(index) && index >= 0 && index < playerCount
  const shared: number[] = []
  for (let round = 0; round < rounds; round++) {
    const own = ownIndices[round]
    const peer = peerIndices[round]
    if (!valid(own) || !valid(peer)) throw new Error(`round ${round + 1} has invalid player index ${own}/${peer} for ${playerCount} players`)
    if (seatsFor(own, playerCount, maxGroupSize).some((seat) => seat.occupied && seat.index === peer)) shared.push(round)
  }
  return shared
}

/**
 * Pick a same-observer proof window from actual grouping. At least the first
 * shared turn or the last pre-return turn stays video-free for authoritative
 * Unseen evidence; two later turns provide the enable/decoded/disable window,
 * and disable must precede the viewer reload.
 */
export function planVideoRoleWindow(input: {
  sharedRounds: readonly number[]
  maxGroupSize: number
  rounds: number
  joinAfterTurn: number
  reloadAtTurn: number
}): VideoRoleWindow | null {
  const { maxGroupSize, rounds, joinAfterTurn, reloadAtTurn } = input
  if (!Number.isInteger(maxGroupSize) || maxGroupSize < 4 || !Number.isInteger(rounds) || rounds < 1) return null
  // Prefer the latest feasible shared round: it gives the returned page and
  // its outbound sender the most time to become live. An earlier round remains
  // valid when extra participants make it the only overlap.
  for (const round of [...new Set(input.sharedRounds)].sort((a, b) => b - a)) {
    if (!Number.isInteger(round) || round < 0 || round >= rounds) continue
    const roundStart = round * maxGroupSize + 1
    const roundEnd = roundStart + maxGroupSize - 1
    // Keep one complete suppressed-video turn after a late return before the
    // sender may enable. The cold return needs time to rebuild its mesh, and
    // the viewer still needs an authoritative Unseen end frame before the
    // first possible Co-player frame.
    const enableAtTurn = Math.max(roundStart + 1, joinAfterTurn + 2)
    const disableAtTurn = enableAtTurn + 2
    if (disableAtTurn > roundEnd || disableAtTurn >= reloadAtTurn) continue
    return { round, enableAtTurn, disableAtTurn }
  }
  return null
}

/** A late sender must never collapse a missed proof window into one same-turn enable/disable pair. */
export const videoRoleEnableWindowOpen = (turn: number | null, window: Pick<VideoRoleWindow, "enableAtTurn" | "disableAtTurn">): boolean =>
  turn !== null && turn >= window.enableAtTurn && turn < window.disableAtTurn

export interface VideoRoleControlState {
  /** The page controller was armed, even if no real sender existed yet. */
  requested: boolean
  /** A real live sender acknowledged the enable request in time. */
  enabled: boolean
  /** The page controller is off, independently of whether a live sender proved it. */
  disarmed: boolean
  /** Disable proof completed, or an unacknowledged request expired terminally. */
  disabled: boolean
}

export interface VideoRoleControlFacts {
  enabled: boolean
  senders: number
}

/**
 * Advance the delayed-video controller by one observed game turn. The disable
 * boundary is exclusive for new enable acknowledgements. A pending zero-sender
 * request is still disarmed at the deadline so a later rebuilt sender cannot
 * inherit an enabled controller, but that disarm is not reported as proof.
 */
export async function advanceVideoRoleWindow(input: {
  turn: number | null
  stage: string
  window: { enableAtTurn: number; disableAtTurn: number | null } | null
  state: VideoRoleControlState
  facts: VideoRoleControlFacts | null
  setEnabled(enabled: boolean): Promise<VideoRoleControlFacts>
}): Promise<{ action: "enabled" | "disabled" | null; changed: boolean; facts: VideoRoleControlFacts | null }> {
  const { turn, stage, window, state } = input
  if (turn === null || !window || !["intro", "play"].includes(stage)) return { action: null, changed: false, facts: input.facts }

  if (window.disableAtTurn !== null && turn >= window.disableAtTurn) {
    if (state.disabled || (!state.requested && !state.enabled && !input.facts?.enabled)) return { action: null, changed: false, facts: input.facts }
    if (state.disarmed && (!state.enabled || !input.facts?.senders)) return { action: null, changed: false, facts: input.facts }
    const after = await input.setEnabled(false)
    const action = state.enabled && after.senders > 0 ? "disabled" : null
    state.requested = false
    state.disarmed = true
    // An enable that never reached a real sender expires terminally. A real
    // earlier enable keeps proof pending when teardown leaves zero live owners;
    // a rebuilt trackless sender can then acknowledge disable on a later poll.
    state.disabled = action === "disabled" || !state.enabled
    return { action, changed: true, facts: after }
  }

  if (!state.enabled && !state.disabled && turn >= window.enableAtTurn && (window.disableAtTurn === null || videoRoleEnableWindowOpen(turn, { enableAtTurn: window.enableAtTurn, disableAtTurn: window.disableAtTurn }))) {
    const after = input.facts?.enabled ? input.facts : await input.setEnabled(true)
    const changed = !input.facts?.enabled
    state.requested = true
    if (after.enabled && after.senders > 0) {
      state.enabled = true
      return { action: "enabled", changed: true, facts: after }
    }
    return { action: null, changed, facts: after }
  }

  return { action: null, changed: false, facts: input.facts }
}
