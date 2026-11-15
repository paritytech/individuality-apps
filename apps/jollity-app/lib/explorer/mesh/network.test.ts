// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The network-change fault: env:network:<side> runs Mesh.networkChanged on that side, as useMesh's
 * network watcher does once its debounce fires. Every scenario lists it on
 * both sides; F caps it.
 */
// quiescence first: it traps the real timers before anything else loads
import "./quiescence"
import { describe, expect, it } from "vitest"
import { isFault, type Label } from "../core/labels"
import { readMeshAnchor, settled, steadyLink } from "./anchors"
import { fairPick } from "./fair"
import { exploreRoom, HarnessError, type Room } from "./room"
import { SCENARIOS } from "./scenarios"

const steady = () => readMeshAnchor("steady").warmup

/** the fair scheduler (no fault) until the link is steady and settled, or `limit` labels */
async function fairToSteady(room: Room, limit = 400): Promise<Label[]> {
  const since = new Map<Label, number>()
  const taken: Label[] = []
  for (let k = 0; k < limit && !(steadyLink(room) && settled(room)); k++) {
    const enabled = room.enabled().filter((label) => !isFault(label))
    if (enabled.length === 0) break
    for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
    for (const label of enabled) if (!since.has(label)) since.set(label, k)
    const pick = fairPick(enabled, since)
    taken.push(pick)
    await room.step(pick)
  }
  return taken
}

describe("env:network", () => {
  it("is a fault every scenario lists on both sides", () => {
    expect(isFault("env:network:a")).toBe(true)
    for (const scenario of Object.values(SCENARIOS)) expect(scenario.env).toEqual(expect.arrayContaining(["env:network:a", "env:network:b"]))
  })

  it("on a steady link: calls Mesh.networkChanged on that side only, and the actor repairs the link in place", async () => {
    const room = await exploreRoom({ scenario: "rejoin-two-offers", phaseOffsetMs: 1000, faults: 1 })
    try {
      await room.replay(steady())
      expect(room.enabled()).toEqual(expect.arrayContaining(["env:network:a", "env:network:b"]))
      const pcs = (["a", "b"] as const).map((side) => room.internals(side).conns.get(side === "a" ? "b" : "a")!.pc)
      const step = room.logs().inputs.length
      await room.step("env:network:a")
      expect(room.faultsLeft()).toBe(0)
      const inputs = room.logs().inputs.slice(step)
      expect(inputs.slice(0, 2).map(({ side, kind }) => [side, kind])).toEqual([["a", "env:network"], ["a", "mesh:networkChanged"]])
      expect(room.logs().externalFacts.at(-1)).toMatchObject({ side: "a", peer: "b", call: "networkChanged" })
      expect(room.logs().externalFacts.at(-1)?.threw).toBeUndefined()
      // a's repair is an ICE restart on the same connection; b heard nothing yet
      expect(room.logs().commands.filter((command) => command.side === "a" && command.kind === "restart-ice")).toHaveLength(1)
      expect(room.logs().commands.some((command) => command.side === "b" && /restart-ice|replace-connection/.test(command.kind))).toBe(false)
      expect(pcs.map((pc) => pc.connectionState)).toEqual(["connected", "connected"])
      // listed with F spent (T4 counts it as a faults cut), refused when taken
      expect(room.enabled()).toContain("env:network:b")
      await expect(room.step("env:network:b")).rejects.toThrow(HarnessError)
    } finally {
      room.close()
    }
  })

  it("network-all (a's change, then b's at once) recovers to a steady link on the fair schedule, clean", async () => {
    const room = await exploreRoom({ scenario: "rejoin-two-offers", phaseOffsetMs: 1000, faults: 2 })
    try {
      await room.replay(readMeshAnchor("network-all").warmup)
      expect(room.faultsLeft()).toBe(0)
      const taken = await fairToSteady(room)
      expect(steadyLink(room) && settled(room)).toBe(true)
      expect(taken.length).toBeGreaterThan(0)
      expect(room.violations()).toEqual([])
    } finally {
      room.close()
    }
  })

  // #1583 item l on real Mesh (the F0 liveness search from network-all): b answers a's restart offer and
  // offers its own at once; a is still applying the answer when b's offer lands, reads have-local-offer,
  // and as the impolite side ignores it. Nothing answers b's lane offer after that. The unit-level
  // repro is lib/webrtc/mesh-lane-answer-pending.test.ts. Fails on main.
  it.skip("#1583: network-all, b's lane offer landing while a applies b's answer, is answered (steady within 120 s)", async () => {
    const room = await exploreRoom({ scenario: "rejoin-two-offers", phaseOffsetMs: 1000, faults: 2 })
    try {
      await room.replay([...readMeshAnchor("network-all").warmup,
        "pc:a/1:negotiationneeded", "pc:a/1:sld:resolve", "pc:a/1:gather", "lane:a>b:deliver",
        "pc:b/1:srd:resolve", "pc:b/1:sld:resolve", "pc:b/1:gather",
        "pc:b/1:negotiationneeded", "pc:b/1:sld:resolve", "pc:b/1:gather"])
      const live = await room.checkLiveness(120_000)
      expect(live.violation?.detail).toBeUndefined()
      expect(live.steady).toBe(true)
    } finally {
      room.close()
    }
  })

  it("is not listed on a side whose Mesh holds no connection to the peer", async () => {
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      for (const side of ["a", "b"] as const) {
        const listed = room.enabled().includes(`env:network:${side}`)
        expect(listed).toBe(room.internals(side).conns.has(side === "a" ? "b" : "a"))
      }
    } finally {
      room.close()
    }
  })
})
