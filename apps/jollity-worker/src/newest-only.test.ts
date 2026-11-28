// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { newestOnly } from "./newest-only"

describe("newestOnly works", () => {
  it("answers only the newest move it holds", () => {
    // Given
    const flushes: (() => void)[] = []
    const answered: number[] = []
    const moves = newestOnly<number>((x) => answered.push(x), (flush) => flushes.push(flush))

    // When
    moves.offer(1)
    moves.offer(2)
    moves.offer(3)
    flushes.shift()?.()

    // Then
    expect(answered).toEqual([3])
  })

  it("schedules one answer for the moves offered before it runs", () => {
    // Given
    const flushes: (() => void)[] = []
    const moves = newestOnly<number>(() => {}, (flush) => flushes.push(flush))

    // When
    moves.offer(1)
    moves.offer(2)

    // Then
    expect(flushes).toHaveLength(1)
  })

  it("answers nothing once the pan ended", () => {
    // Given
    const flushes: (() => void)[] = []
    const answered: number[] = []
    const moves = newestOnly<number>((x) => answered.push(x), (flush) => flushes.push(flush))
    moves.offer(4)

    // When
    moves.drop()
    flushes.forEach((flush) => flush())

    // Then
    expect(answered).toEqual([])
  })
})
