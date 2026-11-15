// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The outage scenario:
 * from the steady anchor, env:ice takes one side's PC down; a down pair
 * carries no frames and comes back through an ICE restart or a rebuild.
 */
// quiescence first: it traps the real timers before anything else loads
import "./quiescence"
import { describe, expect, it } from "vitest"
import { isFault, type Label } from "../core/labels"
import { readMeshAnchor, settled, steadyLink } from "./anchors"
import { fairPick } from "./fair"
import { exploreRoom, HarnessError, type Room } from "./room"
import type { PeerActorState } from "../../state-machines/peer-actor"
import { SCENARIOS } from "./scenarios"

const ICE = /^env:ice:/
const steady = () => readMeshAnchor("steady").warmup

/** the fair scheduler (no fault) until `done`, or `limit` labels */
async function fairUntil(room: Room, done: () => boolean, limit = 400): Promise<Label[]> {
  const since = new Map<Label, number>()
  const taken: Label[] = []
  for (let k = 0; k < limit && !done(); k++) {
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

const pcIds = (room: Room) => (["a", "b"] as const).map((side) => room.internals(side).conns.get(side === "a" ? "b" : "a")!.pc)

describe("the outage scenario", () => {
  it("starts from the steady anchor's warmup, under itself, with no fault spent", async () => {
    // run.explore.ts meshScenario replays the `from` anchor's warmup under this scenario
    expect(SCENARIOS.outage.from).toBe("steady")
    const warmup = steady()
    expect(warmup.filter(isFault)).toEqual([])
    expect(SCENARIOS.outage.env.every((label) => isFault(label))).toBe(true)
    const room = await exploreRoom({ scenario: "outage", phaseOffsetMs: 1000 })
    try {
      await room.replay(warmup)
      expect(room.violations()).toEqual([])
      expect(steadyLink(room) && settled(room)).toBe(true)
      expect(room.enabled().filter((label) => ICE.test(label))).toEqual(["env:ice:a:disconnected", "env:ice:a:failed", "env:ice:b:disconnected", "env:ice:b:failed"])
    } finally {
      room.close()
    }
  })

  it("never offers env:ice in the other scenarios, nor before the steady point, nor while anything waits", async () => {
    for (const scenario of ["rejoin-two-offers", "single-offer"] as const) {
      const room = await exploreRoom({ scenario, phaseOffsetMs: 1000 })
      try {
        // the fair run to a connected, settled pair, checking every step on the way
        await fairUntil(room, () => {
          expect(room.enabled().filter((label) => ICE.test(label))).toEqual([])
          return steadyLink(room) && settled(room)
        }, 80)
        expect(steadyLink(room)).toBe(true)
      } finally {
        room.close()
      }
    }
    const room = await exploreRoom({ scenario: "outage", phaseOffsetMs: 1000 })
    try {
      // through the warmup env:ice appears only once both PCs connected and nothing waits
      for (const label of steady()) {
        const ice = room.enabled().filter((candidate) => ICE.test(candidate))
        if (ice.length > 0) expect(room.enabled().filter((candidate) => candidate !== "clock:next" && !isFault(candidate))).toEqual([])
        await room.step(label)
      }
    } finally {
      room.close()
    }
  })

  it("takes one side down once per schedule, as a fault F caps", async () => {
    const room = await exploreRoom({ scenario: "outage", phaseOffsetMs: 1000, faults: 1 })
    try {
      await room.replay(steady())
      const [a, b] = pcIds(room)
      await room.step("env:ice:a:disconnected")
      expect(room.faultsLeft()).toBe(0)
      expect([a.connectionState, b.connectionState]).toEqual(["disconnected", "connected"])
      expect(room.logs().inputs.some((input) => input.side === "a" && input.kind === "env:ice")).toBe(true)
      expect(room.enabled().filter((label) => label.startsWith("env:ice:a:"))).toEqual([])
      // b's label is listed while it is quiet (T4 counts it as a faults cut) but refused with F spent
      const bIce = room.enabled().find((label) => label.startsWith("env:ice:b:"))
      if (bIce) await expect(room.step(bIce)).rejects.toThrow(HarnessError)
    } finally {
      room.close()
    }
  })

  it("fingerprints the spent latch and the drop", async () => {
    const room = await exploreRoom({ scenario: "outage", phaseOffsetMs: 1000 })
    try {
      await room.replay(steady())
      const before = room.fingerprint()
      await room.step("env:ice:b:failed")
      expect(room.fingerprint()).not.toBe(before)
    } finally {
      room.close()
    }
  })

  /** the connected pair's offer identity (x-offer of the offerer's current offer) */
  const offerIdentity = (room: Room) => {
    const [a, b] = pcIds(room)
    const offerer = a.localDescription?.type === "offer" ? a : b
    return /^a=x-offer:(.*)$/m.exec(offerer.localDescription?.sdp ?? "")?.[1]?.trim()
  }

  // The recovery depth (labels past the steady anchor, the drop included) on
  // the fair schedule, an upper bound on the depth a search needs: every heal
  // today is a rebuild (new PCs, a new offer identity), because Mesh's ICE
  // restart offer rides the lane and a down pair carries no lane frames. The
  // monitors judge every step.
  // A disconnect's heal waits out the clock past the first beats, so its
  // fair schedule takes hb:a and hb:b too (two labels more since #1525).
  const RECOVERY_DEPTH = { "a:disconnected": 28, "a:failed": 14, "b:disconnected": 30, "b:failed": 16 } as const
  for (const [side, state] of [["a", "disconnected"], ["a", "failed"], ["b", "disconnected"], ["b", "failed"]] as const) {
    it(`goes connected, down (env:ice:${side}:${state}) and connected again on a new offer identity, clean`, async () => {
      const room = await exploreRoom({ scenario: "outage", phaseOffsetMs: 1000, horizonMs: 600_000 })
      try {
        await room.replay(steady())
        const [a1, b1] = pcIds(room)
        const before = offerIdentity(room)
        await room.step(`env:ice:${side}:${state}`)
        expect(steadyLink(room)).toBe(false)
        const taken = await fairUntil(room, () => steadyLink(room))
        expect(steadyLink(room), `not healed after ${taken.length} fair labels: ${taken.slice(-12).join(" ")}`).toBe(true)
        expect(room.violations()).toEqual([])
        expect(offerIdentity(room)).not.toBe(before)
        const [a2, b2] = pcIds(room)
        // measured at a5023e9a: every heal a rebuild, at these depths (logged, so a Mesh timer change does not fail it)
        expect(1 + taken.length).toBeLessThanOrEqual(RECOVERY_DEPTH[`${side}:${state}`])
        console.info(`outage heal ${side} ${state}: ${a2 === a1 && b2 === b1 ? "restart" : "rebuild"}, ${1 + taken.length} labels past steady`)
      } finally {
        room.close()
      }
    })
  }

  // the split outage's "back": a's link drops, a marks b away after 8 s and
  // rebuilds; b's statement answer to a's new offer reaches a over signalling
  // while a's link is still down. That shows b back (markBack), which
  // restarts downAt on Mesh, and on the actor, which now owns that time.
  it("reaches a signalling back during an outage: downAt restarts on Mesh and the actor alike", async () => {
    const outage: Label[] = [
      "env:ice:a:disconnected", "clock:next", "clock:next", "clock:next", "clock:next", "clock:next", "clock:next", "clock:next",
      "pc:a/1:negotiationneeded", "pc:a/1:sld:resolve", "pc:a/1:gather", "clock:next", "clock:next", "clock:next", "clock:next", "clock:next", "clock:next",
      "pc:a/2:negotiationneeded", "pc:a/2:sld:resolve", "pc:a/2:gather", "wire:a>b:wire-5:deliver", "pc:b/2:srd:resolve", "pc:b/2:sld:resolve", "pc:b/2:gather",
    ]
    const room = await exploreRoom({ scenario: "outage", phaseOffsetMs: 1000 })
    try {
      await room.replay([...steady(), ...outage])
      const mesh = room.internals("a")
      const actor = () => (mesh.runner as unknown as { state(peer: string): PeerActorState }).state("b")
      const conn = () => mesh.conns.get("b") as unknown as { downAt: number; away: string | null }
      const before = actor()
      expect(before).toMatchObject({ away: "timeout", upAt: null })
      expect(before.downAt).not.toBeNull()
      expect(conn().away).toBe("timeout")
      // b's statement answer, over signalling: b is shown back, a's link still down
      await room.step("wire:b>a:wire-6:deliver")
      const after = actor()
      expect(after.away).toBe("here")
      expect(after.downAt).toBeGreaterThan(before.downAt!)
      expect(after.upAt).toBeNull()
      expect(conn()).toMatchObject({ away: null, downAt: after.downAt })
      expect(room.violations()).toEqual([])
    } finally {
      room.close()
    }
  })
})
