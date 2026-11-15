// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * RP6 on real Mesh (a closed-pair measurement): one PC applies descriptions from two remote connections, from a cold
 * start with no fault. The abstract room found it in 18 labels; this is the
 * same schedule on the two real Meshes of the explorer's room.
 *
 * - b (the answerer) rebuilds at its connect-by deadline (+18 s) and offers
 *   from b/2. a answers from a/1.
 * - b reads a's answer late, and its setRemoteDescription is still pending
 *   when a, whose own connect-by deadline came (+35 s), rebuilds to a/2 and
 *   offers. b reads that offer too.
 * - Mesh's new-session check (onRtc, newSessionOver) sees no session: the PC
 *   has no remote description yet (the answer's SRD is pending) and there is
 *   no answering entry (that records only an offer being answered, #1499's
 *   fix). So b puts a/2's offer on b/2, behind a/1's answer, instead of
 *   rebuilding: b/2 resolves an answer from a/1 and then an offer from a/2.
 *
 * The harness's P1b monitor counts offers only, so it does not flag this
 * (one answer, one offer); the assertions below read the op log itself.
 * Fixed in #1615: newSessionOver also reads the session of an answer still
 * being set, so a/2's offer takes the new-session rebuild and the pair heals.
 */
// quiescence first: it traps the real timers before anything else loads
import "./quiescence"
import { afterEach, describe, expect, it } from "vitest"
import type { Label } from "../core/labels"
import { exploreRoom, type Room } from "./room"

let room: Room | undefined
afterEach(() => {
  room?.close()
  room = undefined
})

/** clock:next until a label matching `pattern` is enabled */
async function clockUntil(current: Room, pattern: RegExp): Promise<void> {
  for (let k = 0; k < 300; k++) {
    if (current.enabled().some((label) => pattern.test(label))) return
    await current.step("clock:next")
  }
  throw new Error(`never enabled: ${pattern}`)
}

/** each PC of `side` with the remote PCs whose descriptions it applied (any role) */
function appliedFrom(current: Room, side: "a" | "b"): Map<string, string[]> {
  const remotes = new Map<string, string[]>()
  for (const entry of current.logs().ops) {
    if (!entry.pc.startsWith(`${side}/`) || entry.op !== "srd" || entry.outcome !== "resolved" || entry.xPc === undefined) continue
    const seen = remotes.get(entry.pc) ?? []
    if (!seen.includes(entry.xPc)) seen.push(entry.xPc)
    remotes.set(entry.pc, seen)
  }
  return remotes
}

describe("RP6: a description mix after a connect-by rebuild", () => {
  it("rebuilds for a new remote connection's offer while the old one's answer is still being set", async () => {
    room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000, faults: 0, horizonMs: 10_000_000 })
    const steps: Label[] = ["wire:a>b:wire-1:deliver", "wire:b>a:wire-2:deliver"] // the hellos; a's first negotiationneeded is never taken
    for (const label of steps) await room.step(label)
    await clockUntil(room, /^pc:b\/2:/) // b's connect-by deadline: b/1 replaced by b/2
    for (const label of ["pc:b/2:negotiationneeded", "pc:b/2:sld:resolve", "pc:b/2:gather", "wire:b>a:wire-3:deliver", // b/2's offer reaches a
      "pc:a/1:srd:resolve", "pc:a/1:sld:resolve", "pc:a/1:gather"]) await room.step(label) // a/1 answers (wire-4)
    await clockUntil(room, /^pc:a\/2:/) // a's connect-by deadline: a/1 replaced by a/2
    for (const label of ["wire:a>b:wire-4:deliver", // b reads a/1's answer: its SRD is left pending
      "pc:a/2:negotiationneeded", "pc:a/2:sld:resolve", "pc:a/2:gather", "wire:a>b:wire-5:deliver", // a/2's offer reaches b
    ]) await room.step(label)

    // a/2's offer is a new remote session: b rebuilds and takes it on a fresh connection
    expect(room.logs().commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: "b", command: expect.objectContaining({ kind: "replace-connection" }), pcAtIssue: "b/2" }),
    ]))
    // and the pair recovers: a steady link, no PC of b's applying two remote connections
    const live = await room.checkLiveness(120_000)
    expect(live.violation?.detail).toBeUndefined()
    expect(live.steady).toBe(true)
    const applied = appliedFrom(room, "b")
    expect([...applied].filter(([, remotes]) => remotes.length > 1)).toEqual([])
    const newest = [...applied.keys()].at(-1)!
    expect(newest).not.toBe("b/2")
    expect(applied.get(newest)!.at(-1)).toMatch(/^a\//)
  })
})
