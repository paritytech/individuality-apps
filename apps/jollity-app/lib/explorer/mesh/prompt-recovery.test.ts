// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The explorer's witnesses for #1605 and #1606 on the real Mesh (mesh-pair),
 * each replayed label by label from its anchor, then drained by the fair
 * scheduler with the liveness check (L1). The time is L1's: fake time from
 * the end of the path to a steady link.
 *
 * - #1605, half-open (the half-open leaf): a's setRemoteDescription refuses b's answer while a/2
 *   holds its offer. Before: connect-by healed it after 20 s. After: a
 *   rebuilds as offerer at the refusal, 0 s.
 * - #1606, ice-failed (the same note's leaf, found again past its first 15
 *   labels on 5 Nov): b applies a's offer and sets its answer, then its own
 *   offer takes the answer's place, and a ignores b's offer. Before: 32 s
 *   (b's answer wait, then a's connect-by). After: b answers a's offer again
 *   on a fresh responder, 0 s.
 */
// quiescence first: it traps the real timers before anything else loads
import "./quiescence"
import { describe, expect, it } from "vitest"
import type { Label } from "../core/labels"
import { warmupFaults } from "../run.explore"
import { readMeshAnchor } from "./anchors"
import { exploreRoom } from "./room"
import { SCENARIOS } from "./scenarios"

async function recovery(anchor: "half-open" | "ice-failed", path: Label[]) {
  const fixture = readMeshAnchor(anchor)
  const horizonMs = SCENARIOS[fixture.scenario].defaults.horizonMs
  const room = await exploreRoom({ scenario: fixture.scenario, phaseOffsetMs: 1000, faults: 1 + warmupFaults(fixture.warmup), horizonMs })
  try {
    await room.replay([...fixture.warmup, ...path])
    const live = await room.checkLiveness()
    const causes = room.logs().commands.flatMap((entry) => entry.kind === "replace-connection" ? [`${entry.side}:${(entry.command as { cause: string }).cause}`] : [])
    return { live, causes, violations: room.violations() }
  } finally {
    room.close()
  }
}

describe("prompt recovery on the explorer's witnesses", () => {
  it("#1605 half-open: a refused answer to a's held offer rebuilds at once, not at connect-by (was 20 s)", async () => {
    const { live, causes, violations } = await recovery("half-open", [
      "pc:b/2:sld:resolve", "pc:b/2:gather", "wire:b>a:wire-5:deliver",
      "pc:a/2:negotiationneeded", "pc:a/2:sld:resolve", "pc:a/2:gather", "wire:a>b:wire-7:deliver",
      "pc:b/3:srd:resolve", "pc:b/3:sld:resolve", "pc:b/3:gather", "wire:b>a:wire-8:deliver",
      "pc:a/2:srd:reject:InvalidAccessError",
    ])
    expect(causes).toContain("a:answer-refused")
    expect(live.violation?.detail).toBeUndefined()
    expect(live.steady).toBe(true)
    expect(live.ms).toBeLessThanOrEqual(3_000)
    expect(violations).toEqual([])
  }, 120_000)

  it("#1606 ice-failed: b's answer displaced by its own offer is made again on a fresh responder (was 32 s)", async () => {
    const { live, causes, violations } = await recovery("ice-failed", [
      "clock:next", "clock:next", "clock:next", "env:ice:b:failed", "clock:next", "clock:next",
      "pc:a/2:negotiationneeded", "clock:next", "clock:next", "clock:next", "clock:next",
      "pc:a/2:sld:resolve", "clock:next", "pc:a/2:gather", "wire:a>b:wire-5:deliver",
      "pc:b/2:srd:resolve", "pc:b/2:sld:resolve", "pc:b/2:negotiationneeded", "pc:b/2:sld:resolve",
      "pc:b/2:gather", "wire:b>a:wire-6:deliver", "clock:next",
    ])
    expect(causes).toContain("b:answer-displaced-rejoin")
    expect(live.violation?.detail).toBeUndefined()
    expect(live.steady).toBe(true)
    expect(live.ms).toBeLessThanOrEqual(3_000)
    expect(violations).toEqual([])
  }, 120_000)
})
