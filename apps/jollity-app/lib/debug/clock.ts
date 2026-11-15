// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The source's game clock and the current game, as a module-level value.
 * `DebugSheet` mounts outside the game tree, so the source hands it the clock
 * through this value, the same way `lib/health/snapshot.ts` does.
 */
export interface ClockSnapshot {
  /** which engine answered, for the panel header */
  engine: "chain"
  /** the shown game time minus the device time, ms */
  offsetMs: number
  /** the chain second of the last chain value, 0 before one */
  chainSeconds: number
  /** device ms when that value landed */
  anchoredAtMs: number
  /** the current game's kickoff (`game_date`), null while there is none */
  gameAt: number | null
  /** the derived status kind, as `watchStatus` emits it */
  status: string
  /** which check moved the clock: none or peer */
  method: string
  /** the peers of the last peer check */
  peers: number
}

let snapshot: ClockSnapshot | null = null
const listeners = new Set<() => void>()

export function setClockSnapshot(patch: Partial<ClockSnapshot> & Pick<ClockSnapshot, "engine">): void {
  snapshot = {
    ...(snapshot ?? { offsetMs: 0, chainSeconds: 0, anchoredAtMs: 0, gameAt: null, status: "loading", method: "none", peers: 0 }),
    ...patch,
  }
  for (const listener of listeners) listener()
}

export function getClockSnapshot(): ClockSnapshot | null {
  return snapshot
}

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
