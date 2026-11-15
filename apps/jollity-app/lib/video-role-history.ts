// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PlayerId } from "./game-source"

/** First trustworthy global turn in which a decoded peer frame made a player
 * eligible for this viewer. `null` is a real observation waiting for the next
 * trustworthy turn boundary. Key presence is the durable one-way seen bit. */
export type VideoRoleHistory = Partial<Record<PlayerId, { fromTurn: number | null }>>

function earlierBoundary(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null | undefined {
  if (typeof left === "number" && typeof right === "number") return Math.min(left, right)
  if (typeof left === "number") return left
  if (typeof right === "number") return right
  if (left === null || right === null) return null
  return undefined
}

/** Merge a restore/local race without ever moving a boundary later. */
export function mergeVideoRoleHistory(
  left: VideoRoleHistory,
  right: VideoRoleHistory | undefined,
): VideoRoleHistory {
  if (!right) return { ...left }
  const merged: VideoRoleHistory = { ...left }
  for (const id of Object.keys(right)) {
    const boundary = earlierBoundary(left[id]?.fromTurn, right[id]?.fromTurn)
    if (boundary !== undefined) merged[id] = { fromTurn: boundary }
  }
  return merged
}

/** Idempotently record a decoded frame. */
export function markVideoRoleSeen(
  history: VideoRoleHistory,
  id: PlayerId,
  fromTurn: number | null,
): { history: VideoRoleHistory; changed: boolean } {
  if (history[id] !== undefined) return { history, changed: false }
  return { history: { ...history, [id]: { fromTurn } }, changed: true }
}

/** Bind every pre-turn observation before that turn's eligibility is read. */
export function bindPendingVideoRoles(
  history: VideoRoleHistory,
  globalTurn: number,
): { history: VideoRoleHistory; changed: boolean } {
  let changed = false
  const bound: VideoRoleHistory = { ...history }
  for (const [id, entry] of Object.entries(history)) {
    if (entry?.fromTurn !== null) continue
    bound[id] = { fromTurn: globalTurn }
    changed = true
  }
  return { history: changed ? bound : history, changed }
}

export function videoRoleSeen(history: VideoRoleHistory, id: PlayerId): boolean {
  return history[id] !== undefined
}

/** A pending observation is globally seen but cannot be replayed into a turn
 * until a trustworthy openTurn binds it. */
export function videoRoleEligible(
  history: VideoRoleHistory,
  id: PlayerId,
  globalTurn: number,
): boolean {
  const boundary = history[id]?.fromTurn
  return typeof boundary === "number" && boundary <= globalTurn
}
