// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useRewardCue } from "../components/game/animations"
import { REWARD_STEP_MS, waveRange } from "./reward-burst"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function mountCue(accepted: number) {
  return renderHook(({ accepted }) => useRewardCue({ accepted, reachable: 3 }), { initialProps: { accepted } })
}

describe("useRewardCue", () => {
  it("fires the first wave again when the same co-player accepts you on the next turn", () => {
    // Given
    const cue = mountCue(1)
    expect(cue.result.current).toEqual({ burst: 1, ...waveRange(0) })

    // When
    cue.rerender({ accepted: 0 })
    cue.rerender({ accepted: 1 })

    // Then
    expect(cue.result.current).toEqual({ burst: 2, ...waveRange(0) })
  })

  it("fires nothing for an accept taken back and cast again inside one turn", () => {
    // Given
    const cue = mountCue(2)
    act(() => void vi.advanceTimersByTime(REWARD_STEP_MS * 2))
    expect(cue.result.current.burst).toBe(2)

    // When
    cue.rerender({ accepted: 1 })
    cue.rerender({ accepted: 2 })
    act(() => void vi.advanceTimersByTime(REWARD_STEP_MS * 2))

    // Then
    expect(cue.result.current.burst).toBe(2)
  })
})
