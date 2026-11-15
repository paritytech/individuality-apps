// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { betterSnapshot, lumaStats, snapshotScore, type SnapshotScore } from "./snapshot-quality"

const pixels = (...values: number[]) =>
  new Uint8ClampedArray(values.flatMap((value) => [value, value, value, 255]))

describe("snapshot quality", () => {
  it("calculates deterministic luma mean and variance", () => {
    const stats = lumaStats(pixels(0, 20))
    expect(stats.mean).toBeCloseTo(10)
    expect(stats.variance).toBeCloseTo(100)
  })

  it("rejects undersized, black, and near-uniform candidates", () => {
    expect(snapshotScore(143, 200, pixels(0, 255), false)).toEqual({ ok: false, reason: "source-too-small" })
    expect(snapshotScore(200, 200, pixels(0, 0, 0), false)).toEqual({ ok: false, reason: "too-dark" })
    expect(snapshotScore(200, 200, pixels(40, 40, 40), false)).toEqual({ ok: false, reason: "too-uniform" })
  })

  it("caps resolution and ranks host gameplay before image quality", () => {
    const scored = snapshotScore(1920, 1080, pixels(10, 80, 200), false)
    expect(scored.ok).toBe(true)
    if (scored.ok) expect(scored.score.slice(0, 2)).toEqual([0, 720])
    const ordinary: SnapshotScore = [0, 720, 5_000]
    const host: SnapshotScore = [1, 144, 13]
    expect(betterSnapshot(host, ordinary)).toBe(true)
    expect(betterSnapshot([1, 300, 20], host)).toBe(true)
    expect(betterSnapshot([0, 720, 9_000], host)).toBe(false)
  })
})
