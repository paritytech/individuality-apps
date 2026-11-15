// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeerReport } from "./mesh"

export const HOST_ONLY_GATHER_DWELL_MS = 8_000

/** The raw network-warning proof: every active peer has found local/private host
 * candidates only, and not one peer link connected. Gathering may remain in
 * progress forever while UDP is blocked, especially when self-heal replaces
 * failed peer connections. A camera or media failure on an otherwise connected
 * direct path must never become network blame. */
export function noUsableNetworkPath(rows: readonly PeerReport[]): boolean {
  return rows.length > 0 && rows.every((row) => {
    const counts = row.gathered?.counts
    return (
      row.conn !== "connected" &&
      row.gather !== "new" &&
      counts !== undefined &&
      counts.host > 0 &&
      counts.srflx === 0 &&
      counts.relay === 0 &&
      counts.other === 0
    )
  })
}

/**
 * Completed host-only gathering is the original conclusive proof. While a
 * gather is still running, hold the same observation continuously so the
 * ordinary host-before-STUN candidate order cannot flash network blame.
 */
export class NoUsableNetworkPathGate {
  private gatheringHostOnlySince: number | null = null

  update(rows: readonly PeerReport[], now: number): boolean {
    return this.updateObservation(
      noUsableNetworkPath(rows),
      rows.length > 0 && rows.every((row) => row.gather === "complete"),
      now,
    )
  }

  /** The same dwell for a peerless pre-flight gather. Keeping this primitive
   * here prevents the waiting room and the live mesh from drifting into two
   * different definitions of when host-only evidence is safe to show. */
  updateObservation(hostOnly: boolean, complete: boolean, now: number): boolean {
    if (!hostOnly) {
      this.gatheringHostOnlySince = null
      return false
    }
    if (complete) {
      this.gatheringHostOnlySince = null
      return true
    }
    if (this.gatheringHostOnlySince === null) {
      this.gatheringHostOnlySince = now
      return false
    }
    return now - this.gatheringHostOnlySince >= HOST_ONLY_GATHER_DWELL_MS
  }
}
