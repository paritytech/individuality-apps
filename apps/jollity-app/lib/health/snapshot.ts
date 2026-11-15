// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The latest connection-health reading, as a module-level value.
 *
 * `DebugBoot` mounts in the root layout (`app/layout.tsx`), so `DebugSheet` is
 * nowhere near the game session's React tree and cannot be handed this as a
 * prop. `setTelemetryAddress` in `lib/debug/telemetry.ts` bridges the same gap
 * the same way, and `log-store.ts` uses the same subscribe shape — so a reader
 * re-renders on a new reading without the game plumbing a context through
 * every screen for a surface almost nobody opens.
 */
import type { LadderVerdict, SessionStats, SignalStats } from "@jollity/statement-core"
import type { PeerReport } from "../webrtc/mesh"

export interface HealthSnapshot {
  /** This mesh's own player id. */
  selfId: string
  at: number
  verdict: LadderVerdict
  stats: SignalStats | null
  /** per-peer signalling counters, where the wire keeps them */
  sessions: Map<string, SessionStats> | null
  /** per-peer WebRTC rows — candidate pair, gathering state, decoded frames */
  peers: PeerReport[]
  /** ms since the signalling transport was constructed (0 = not yet) */
  signalElapsedMs: number
  /** ms since the room opened — a different clock; see SIGNAL_GRACE_MS */
  inCallElapsedMs: number
  /** Number of configured TURN URLs in the current mesh. */
  turnServers: number
}

let snapshot: HealthSnapshot | null = null
const listeners = new Set<() => void>()

export function setHealthSnapshot(next: HealthSnapshot | null): void {
  snapshot = next
  for (const listener of listeners) listener()
}

export function getHealthSnapshot(): HealthSnapshot | null {
  return snapshot
}

export function subscribeHealth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
