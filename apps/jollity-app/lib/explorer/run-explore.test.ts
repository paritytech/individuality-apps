// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** run.explore.ts's small helpers (its search paths run through `npm run explore`). */
import { describe, expect, it } from "vitest"
import { exitCode } from "./core/cli"
import { mergeKnownGaps } from "./core/report"
import { dedupGapState, dedupRefusal, gapLeavesAtDeepest, memoizedFingerprint, unreachedCells } from "./run.explore"

describe("run.explore helpers", () => {
  it("fingerprints a room state once, and again after anything that can change it", async () => {
    let state = 1
    let walks = 0
    const room = { fingerprint: () => { walks++; return `fp${state}` } }
    const memo = memoizedFingerprint(room, false)
    expect(memo.fingerprint()).toBe("fp1")
    expect(memo.fingerprint()).toBe("fp1")
    expect(walks).toBe(1)
    await memo.changing(async () => { state = 2 })
    expect(memo.fingerprint()).toBe("fp2")
    expect(walks).toBe(2)
    // a fingerprint taken while a change is in flight is not reused after it
    await memo.changing(async () => {
      expect(memo.fingerprint()).toBe("fp2")
      state = 3
    })
    expect(memo.fingerprint()).toBe("fp3")
    await expect(memo.changing(async () => { state = 4; throw new Error("step failed") })).rejects.toThrow("step failed")
    expect(memo.fingerprint()).toBe("fp4")
    const verified = memoizedFingerprint(room, true)
    expect(verified.fingerprint()).toBe("fp4")
    state = 5
    expect(() => verified.fingerprint()).toThrow(/changed without a step/)
  })

  it("refuses dedup for every active monitor that is not trace-closed", () => {
    const active = [
      { id: "P1", closed: true },
      { id: "P2", closed: false },
      { id: "R", closed: false },
    ]
    for (const monitor of active.filter(({ closed }) => !closed)) {
      const refusal = dedupRefusal(true, [monitor] as never)
      expect(refusal).toBe(`--dedup requires trace-closed monitors; active ${monitor.id} is not trace-closed`)
      expect(exitCode({ violations: 0, mutantMissed: false, harnessError: refusal !== undefined, inconclusive: false })).toBe(4)
    }
    expect(dedupRefusal(true, active.slice(0, 1) as never)).toBeUndefined()
    expect(dedupRefusal(false, active as never)).toBeUndefined()
  })
  it("reports an adapter's unreached cells as a count, or as its words when it cannot list them", () => {
    expect(unreachedCells(["a", "b"])).toBe(2)
    expect(unreachedCells([])).toBe(0)
    expect(unreachedCells("cell list unknown")).toBe("cell list unknown")
  })

  it("counts a known gap in the deepest level's leaves, not in every iterative-deepening replay", () => {
    // levels of 2, 3 and 4 leaves; the gap is met in one d=1 leaf, two d=2 leaves and three d=3 leaves
    const perLeaf = [["g"], null, ["g"], ["g"], null, ["g", "g"], ["g", "h"], ["g"], null]
    const counts = gapLeavesAtDeepest(perLeaf, [{ leaves: 2 }, { leaves: 3 }, { leaves: 4 }])
    expect(Object.fromEntries(counts)).toEqual({ g: 3, h: 1 })
    expect(gapLeavesAtDeepest([], []).size).toBe(0)
  })

  it("counts known gaps by distinct fingerprint state under dedup", () => {
    const perLeaf = [
      ["g\0state=a"],
      ["g\0state=a"],
      ["g\0state=b", "h\0state=b"],
    ]
    expect(Object.fromEntries(gapLeavesAtDeepest(perLeaf, [{ leaves: 3 }], true))).toEqual({ g: 2, h: 1 })
  })

  it("unions dedup known-gap states across shards instead of double-counting them", () => {
    const [gap] = mergeKnownGaps([
      [{ property: "P1b", issue: 1499, detail: "known", schedules: 2, stateKeys: ["on:a", "on:b"] }],
      [{ property: "P1b", issue: 1499, detail: "known", schedules: 2, stateKeys: ["on:b", "on:c"] }],
    ])
    expect(gap).toMatchObject({ schedules: 3, stateKeys: ["on:a", "on:b", "on:c"] })
  })

  it("guards a gap-leaf fingerprint failure for harness reporting", () => {
    expect(dedupGapState(true, {
      fingerprint() {
        throw new Error("fingerprint failed")
      },
    } as never)).toEqual({
      harnessDetail: "dedup gap fingerprint: fingerprint failed",
    })
    expect(dedupGapState(false, {} as never)).toEqual({})
  })
})
