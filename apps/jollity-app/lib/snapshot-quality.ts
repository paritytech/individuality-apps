// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const SNAPSHOT_SIZE = 288
export const SNAPSHOT_MIN_SOURCE_EDGE = 144
const SNAPSHOT_MIN_MEAN_LUMA = 8
const SNAPSHOT_MIN_LUMA_VARIANCE = 12

export type SnapshotRejectReason =
  | "not-drawable"
  | "source-too-small"
  | "too-dark"
  | "too-uniform"
  | "canvas-unreadable"

export type SnapshotScore = readonly [hostGameplay: 0 | 1, sourceEdge: number, lumaVariance: number]

export function lumaStats(rgba: Uint8ClampedArray): { mean: number; variance: number } {
  const pixels = Math.floor(rgba.length / 4)
  if (pixels === 0) return { mean: 0, variance: 0 }
  let sum = 0
  let squared = 0
  for (let offset = 0; offset + 2 < rgba.length; offset += 4) {
    const luma = rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722
    sum += luma
    squared += luma * luma
  }
  const mean = sum / pixels
  return { mean, variance: Math.max(0, squared / pixels - mean * mean) }
}

export function snapshotScore(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
  hostGameplay: boolean,
): { ok: true; score: SnapshotScore } | { ok: false; reason: SnapshotRejectReason } {
  const edge = Math.min(width, height)
  if (!edge) return { ok: false, reason: "not-drawable" }
  if (edge < SNAPSHOT_MIN_SOURCE_EDGE) return { ok: false, reason: "source-too-small" }
  const { mean, variance } = lumaStats(rgba)
  if (mean < SNAPSHOT_MIN_MEAN_LUMA) return { ok: false, reason: "too-dark" }
  if (variance < SNAPSHOT_MIN_LUMA_VARIANCE) return { ok: false, reason: "too-uniform" }
  return { ok: true, score: [hostGameplay ? 1 : 0, Math.min(edge, 720), variance] }
}

export function betterSnapshot(candidate: SnapshotScore, current: SnapshotScore): boolean {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] > current[i]) return true
    if (candidate[i] < current[i]) return false
  }
  return false
}
