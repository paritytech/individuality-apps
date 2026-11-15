// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The app side of the chat worker's proof of life (issue #875).
 *
 * The two executables cannot call one another. The worker therefore refreshes
 * one small host-storage record; the app reads it once after startup and
 * compares both its age and its exact build release. They share the device
 * wall clock, so this does not need the game clock.
 */
import { hostPortParked, insideContainer } from "../host/container"
import { hostStorage } from "../host/storage"

export const WORKER_HEARTBEAT_KEY = "jollity.wg.workerHeartbeat"
export const WORKER_HEARTBEAT_GRACE_MS = 20_000
const WORKER_HEARTBEAT_FRESH_MS = 90_000
export const WORKER_HEARTBEAT_READ_DEADLINE_MS = 10_000
const FUTURE_SKEW_MS = 60_000

export type WorkerHeartbeatObservation =
  | { status: "not-applicable" | "missing" | "unavailable" | "malformed" }
  | {
      status: "fresh" | "stale" | "release-mismatch" | "stale-release-mismatch"
      ageMs: number
      release: string
    }

type StoredHeartbeat = { at?: unknown; release?: unknown }

async function readHeartbeat(): Promise<string | WorkerHeartbeatObservation> {
  try {
    if (!(await insideContainer())) return { status: hostPortParked() ? "unavailable" : "not-applicable" }
    const store = await hostStorage()
    if (!store) return { status: "unavailable" }
    const stored = await store.readString(WORKER_HEARTBEAT_KEY)
    if (stored === null || stored.length === 0) return { status: "missing" }
    return stored
  } catch {
    return { status: "unavailable" }
  }
}

async function readHeartbeatWithinDeadline(): Promise<string | WorkerHeartbeatObservation> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    readHeartbeat(),
    new Promise<WorkerHeartbeatObservation>((resolve) => {
      deadline = setTimeout(() => resolve({ status: "unavailable" }), WORKER_HEARTBEAT_READ_DEADLINE_MS)
    }),
  ]).finally(() => {
    if (deadline !== undefined) clearTimeout(deadline)
  })
}

/** Read and classify without throwing. A failed store is not misreported as a dead worker. */
export async function observeWorkerHeartbeat(
  expectedRelease: string,
  now = Date.now(),
): Promise<WorkerHeartbeatObservation> {
  const read = await readHeartbeatWithinDeadline()
  if (typeof read !== "string") return read

  let parsed: unknown
  try {
    parsed = JSON.parse(read)
  } catch {
    return { status: "malformed" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "malformed" }
  const value = parsed as StoredHeartbeat
  if (
    !Number.isFinite(value.at) ||
    typeof value.release !== "string" ||
    value.release.length === 0 ||
    (value.at as number) > now + FUTURE_SKEW_MS
  )
    return { status: "malformed" }

  const ageMs = Math.max(0, now - (value.at as number))
  const stale = ageMs > WORKER_HEARTBEAT_FRESH_MS
  const mismatch = value.release !== expectedRelease
  const status = stale
    ? mismatch
      ? "stale-release-mismatch"
      : "stale"
    : mismatch
      ? "release-mismatch"
      : "fresh"
  return { status, ageMs, release: value.release }
}
