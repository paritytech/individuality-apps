// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The room's partial-order reduction (por.ts): the independence relation per dependency class, the
 * runtime check and its negative controls, and the census result (at 3 phones every closure reaches
 * every enabled label through a sweep, so the reduced search is the full one).
 */
import { describe, expect, it } from "vitest"
import { roomBfs } from "./bfs"
import { roomAnchor } from "./checks"
import { candidateLabels, ENTRY, HALF_LOCAL, quiet, step, type Room } from "./model"
import { checkIndependence, chooseAmple, clockResource, dependent, emptyPorCheck, explainClosures, footprint, macroStep, pairResource, phoneResource, type FootprintOverride } from "./por"

const fp = (label: string, n = 3) => footprint(label, n)
const dep = (a: string, b: string, n = 3) => dependent(fp(a, n), fp(b, n))

/** quiet rooms with no fault left, reached from the reload anchor with F = 0 */
const zeroFaultRooms = (depth: number): Room[] => {
  const anchor = roomAnchor(3, "reload", 0)
  return roomBfs(anchor.room, { depth, maxStates: 1e6, keepRooms: true }).rooms!.filter((room) => quiet(room) && room.faultsLeft === 0)
}

describe("the room's independence relation", () => {
  it("numbers the resources: pairs in pairsOf order, then phones, then the clock", () => {
    expect([pairResource(4, 0, 1), pairResource(4, 0, 3), pairResource(4, 1, 2), pairResource(4, 3, 2)]).toEqual([0, 2, 3, 5])
    expect([phoneResource(4, 0), clockResource(4)]).toEqual([6, 10])
  })

  it("pair labels on one pair are dependent, in both directions and across families", () => {
    expect(dep("h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver")).toBe(true)
    expect(dep("w:1>0:deliver", "hello:0@1")).toBe(true)
    expect(dep("lane:0>1:deliver", "chan:0-1:open")).toBe(true)
    expect(dep("ice:1>0:lost", "ice:0-1:up")).toBe(true)
  })

  it("pair labels on disjoint pairs are independent, also when they share a phone", () => {
    expect(dep("h:0>1:stats:same", "h:2>3:stats:same", 4)).toBe(false)
    expect(dep("h:0>1:stats:same", "h:0>2:stats:same")).toBe(false)
    expect(dep("hello:1@0", "w:2>0:deliver")).toBe(false)
  })

  it("a sweep or a beat of phone i is dependent with every label on a pair of i, and only those", () => {
    for (const family of ["tick", "beat"]) {
      expect(dep(`${family}:0`, "h:1>0:stats:same")).toBe(true)
      expect(dep(`${family}:0`, "ice:0-2:up")).toBe(true)
      expect(dep(`${family}:0`, "h:1>2:stats:same")).toBe(false)
      expect(dep(`${family}:0`, `${family}:1`)).toBe(true)
    }
  })

  it("the clock (advance) is dependent with every label", () => {
    for (const label of ["h:1>2:stats:same", "hello:0@1", "tick:2", "advance-jb:1"]) expect(dep("advance:0", label)).toBe(true)
  })

  it("fault labels are marked as faults (disabled for good at faultsLeft = 0)", () => {
    expect(["ph:0:reload", "ph:1:network", "w:0>1:drop", "ice:0-1:drop", `h:0>1:${HALF_LOCAL.find((key) => ENTRY.get(key)?.fault)!}`].map((label) => fp(label).fault)).toEqual([true, true, true, true, true])
    expect(fp("w:0>1:deliver").fault).toBe(false)
  })
})

describe("the runtime check", () => {
  const rooms = zeroFaultRooms(2)

  it("finds the relation's claims true on every quiet state with no fault left, 3 phones, to depth 2", () => {
    const check = emptyPorCheck()
    for (const room of rooms) checkIndependence(room, check, {}, 60)
    expect(check.states).toBe(rooms.length)
    expect(check.pairs).toBeGreaterThan(1000)
    expect(check.failures, check.samples.join("\n")).toBe(0)
  })

  it("goes red on a wrong independence claim (a hello that does not write its pair)", () => {
    const wrong: FootprintOverride = (label, _n, made) => (label === "hello:1@0" ? { ...made, reads: [], writes: [] } : made)
    const check = emptyPorCheck()
    for (const room of rooms) checkIndependence(room, check, { override: wrong }, 60)
    expect(check.failures).toBeGreaterThan(0)
    expect(check.samples.some((sample) => sample.includes("hello:1@0"))).toBe(true)
  })

  it("goes red when one pair is removed from a sweep's footprint (the footprint negative control)", () => {
    const wrong: FootprintOverride = (label, n, made) => (label === "tick:0" ? { ...made, writes: made.writes.filter((r) => r !== pairResource(n, 0, 1)), reads: made.reads.filter((r) => r !== pairResource(n, 0, 1)) } : made)
    const check = emptyPorCheck()
    for (const room of rooms) checkIndependence(room, check, { override: wrong }, 60)
    expect(check.failures).toBeGreaterThan(0)
  })

  it("macro steps resolve every choice a label leaves, to a quiet room", () => {
    for (const room of rooms.slice(0, 20)) for (const label of candidateLabels(room)) {
      const end = macroStep(room, label)
      if (end) expect(quiet(end)).toBe(true)
    }
  })
})

describe("the ample set on the room (the census)", () => {
  it("takes the full set while faults are left, and while the clock may move", () => {
    const anchor = roomAnchor(3, "reload", 1)
    const enabled = candidateLabels(anchor.room).filter((label) => step(anchor.room, label))
    expect(chooseAmple(anchor.room, enabled, () => null)).toEqual({ ample: null, why: "faults" })
  })

  it("at 3 phones every closure reaches every enabled label, and every such flood runs through a sweep", () => {
    let reducible = 0
    for (const room of zeroFaultRooms(3)) {
      const enabled = candidateLabels(room).filter((label) => step(room, label))
      const choice = chooseAmple(room, enabled, (label) => macroStep(room, label))
      expect(choice.ample).toBeNull()
      if (choice.why !== "all-enabled") continue
      reducible += 1
      for (const closure of explainClosures(room, enabled)) {
        // each other pair is reached through a tick (or the clock that a tick's enabling set brings in); a tick seed reaches them directly
        if (/^(tick|beat):/.test(closure.seed)) continue
        for (const chain of closure.chains) expect(chain.some((link) => /^(tick|advance)/.test(link)), chain.join(" > ")).toBe(true)
      }
    }
    expect(reducible).toBeGreaterThan(0)
  })

  it("leaves the search exactly as it is without the flag: same states, edges and finding signatures", () => {
    const anchor = roomAnchor(3, "reload", 0)
    const options = { depth: 3, maxStates: 1e6, inclusionEvery: 10, probeEvery: 50, sampling: "key" as const }
    const off = roomBfs(anchor.room, options)
    const on = roomBfs(anchor.room, { ...options, por: true, porCheck: 25 })
    expect([on.states, on.edges, on.signatures, on.findingCounts]).toEqual([off.states, off.edges, off.signatures, off.findingCounts])
    expect(on.por!.reduced).toBe(0)
    expect(on.por!.check.failures).toBe(0)
  })
})
