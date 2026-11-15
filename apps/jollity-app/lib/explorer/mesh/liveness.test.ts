// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps the real timers before anything else loads
import "./quiescence"
import { afterEach, describe, expect, it } from "vitest"
import { isFault, type Label } from "../core/labels"
import { readMeshAnchor, settled, steadyLink } from "./anchors"
import { fairPick } from "./fair"
import { exploreRoom, type ExploreRoomOptions, type Room } from "./room"
import { scenarioFrom } from "./scenarios"

/**
 * The transport heartbeat (`hb:<side>`, #1525) and L1, eventually steady
 * (room.ts checkLiveness), on the schedules of the reload-drop probe: from
 * the after-reload
 * anchor, the fair scheduler, one fault, then L1 from right after it.
 */
type Fault = "offer-drop" | "answer-drop" | "hello-drop" | "sld-reject" | "srd-reject"

let room: Room | undefined
afterEach(() => {
  room?.close()
  room = undefined
})

/** the fault label `fault` names, when it is enabled now, past the warmup */
function faultLabel(current: Room, fault: Fault, warm: number): Label | undefined {
  const enabled = current.enabled()
  if (fault === "sld-reject") return enabled.find((label) => /^pc:a\/\d+:sld:reject:OperationError$/.test(label) && !label.startsWith("pc:a/1:"))
  if (fault === "srd-reject") return enabled.find((label) => /^pc:b\/\d+:srd:reject:InvalidAccessError$/.test(label) && !label.startsWith("pc:b/1:"))
  if (fault === "hello-drop") {
    return enabled.find((label) => {
      const id = /^wire:b>a:(.+):drop$/.exec(label)?.[1]
      return id !== undefined && current.logs().wire.some((entry) => entry.id === id && entry.kind === "hello")
    })
  }
  const [from, to, kind] = fault === "offer-drop" ? (["a", "b", "offer"] as const) : (["b", "a", "answer"] as const)
  return enabled.find((label) => {
    const id = new RegExp(`^wire:${from}>${to}:(.+):drop$`).exec(label)?.[1]
    return id !== undefined && current.logs().wire.some((entry) => entry.id === id && entry.channel === "statement" && entry.kind === kind && entry.step >= warm)
  })
}

/** the after-reload warmup, then fair labels until `fault` is enabled, then the fault: the labels taken */
async function toFault(fault: Fault, options: Partial<ExploreRoomOptions> = {}): Promise<Label[]> {
  const fixture = readMeshAnchor("after-reload")
  room = await exploreRoom({ scenario: fixture.scenario, phaseOffsetMs: 1000, faults: 3, horizonMs: 10_000_000, ...options })
  await room.replay(fixture.warmup)
  const taken = [...fixture.warmup]
  const since = new Map<Label, number>()
  for (let k = 0; k < 200; k++) {
    const label = faultLabel(room, fault, fixture.warmup.length)
    if (label) {
      await room.step(label)
      return [...taken, label]
    }
    const enabled = room.enabled().filter((candidate) => !isFault(candidate))
    for (const seen of [...since.keys()]) if (!enabled.includes(seen)) since.delete(seen)
    for (const candidate of enabled) if (!since.has(candidate)) since.set(candidate, k)
    const next = fairPick(enabled, since)
    await room.step(next)
    taken.push(next)
  }
  throw new Error(`${fault}: never enabled`)
}

describe("the transport heartbeat (hb:<side>)", () => {
  it("is offered only once 8 s have passed since the side's last beat, and only at a quiet point", async () => {
    const fixture = readMeshAnchor("steady")
    room = await exploreRoom({ scenario: fixture.scenario, phaseOffsetMs: 1000 })
    await room.replay(fixture.warmup)
    expect(steadyLink(room) && settled(room)).toBe(true)
    // the fair schedule until a beat is due on each side
    const seen = new Set<string>()
    for (let k = 0; k < 200 && seen.size < 2; k++) {
      const enabled = room.enabled().filter((label) => !isFault(label))
      for (const label of enabled) if (label.startsWith("hb:")) seen.add(label)
      if (seen.size < 2) await room.step(enabled.find((label) => label !== "clock:next" && !label.startsWith("hb:")) ?? "clock:next")
    }
    expect([...seen].sort()).toEqual(["hb:a", "hb:b"])
    const before = Date.now()
    await room.step("hb:a")
    expect(Date.now()).toBe(before)
    expect(room.enabled()).not.toContain("hb:a")
    expect(room.enabled()).toContain("hb:b")
    // the beat is presence: b heard a, at once
    const facts = room.logs().externalFacts.slice(-2).map((fact) => `${fact.side}:${fact.call}`)
    expect(facts).toEqual(["b:addPeer", "b:markSeen"])
    expect(steadyLink(room) && settled(room)).toBe(true)
  })

  it("puts a dropped description back on the wire, same gen and SDP, under a new frame id", async () => {
    const labels = await toFault("offer-drop")
    const dropped = /^wire:a>b:(.+):drop$/.exec(labels.at(-1)!)![1]!
    const original = room!.logs().wire.find((entry) => entry.id === dropped)!
    for (let k = 0; k < 40 && !room!.enabled().includes("hb:a"); k++) {
      const enabled = room!.enabled().filter((label) => !isFault(label))
      await room!.step(enabled.find((label) => label !== "clock:next") ?? "clock:next")
    }
    await room!.step("hb:a")
    const again = room!.logs().wire.at(-1)!
    expect(again).toMatchObject({ from: "a", to: "b", fate: "reannounced", kind: "offer", gen: original.gen, xPc: original.xPc, xOffer: original.xOffer })
    expect(again.id).not.toBe(dropped)
    expect(room!.enabled()).toContain(`wire:a>b:${again.id}:deliver`)
    // a second beat has nothing to put back while the slot holds it
    const wire = room!.logs().wire.length
    for (let k = 0; k < 40 && !room!.enabled().includes("hb:a"); k++) {
      const enabled = room!.enabled().filter((label) => !isFault(label) && !label.startsWith("wire:"))
      if (enabled.length === 0) break
      await room!.step(enabled.find((label) => label !== "clock:next") ?? "clock:next")
    }
    expect(room!.logs().wire.slice(wire).filter((entry) => entry.fate === "reannounced")).toEqual([])
  })
})

/** rejoin-two-offers plus the sld OperationError no scenario searches yet */
const SLD_REFUSED = scenarioFrom("rejoin-two-offers", { rejections: [["sld", "OperationError"]] })

describe("L1, eventually steady", () => {
  it.each(["offer-drop", "answer-drop"] as const)("after b's reload, the %s heals at the next beat: L1 is clean", async (fault) => {
    await toFault(fault)
    const result = await room!.checkLiveness()
    expect(result).toMatchObject({ steady: true })
    // the beat's re-announce, not the 30 s yield and 30 s stranded re-offer (62 s with presence alone)
    expect(result.ms).toBeLessThanOrEqual(8_000)
    expect(room!.violations()).toEqual([])
    expect(room!.logs().wire.some((entry) => entry.fate === "reannounced" && entry.kind === (fault === "offer-drop" ? "offer" : "answer"))).toBe(true)
  })

  // Without the beat nothing re-announces. B4's per-connection deadline now
  // rebuilds before the stale PC needs Chrome's ICE timeout.
  it("after b's reload, the offer-drop heals at connectBy without the heartbeat or browser ICE timeout", async () => {
    await toFault("offer-drop", { heartbeat: false })
    const result = await room!.checkLiveness()
    expect(result).toMatchObject({ steady: true, ms: 32_000 })
    expect(room!.logs().commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.objectContaining({ kind: "replace-connection", cause: "connect-by-deadline" }) }),
    ]))
    expect(room!.logs().inputs.some(({ kind }) => kind === "pc:ice-timeout-failed")).toBe(false)
    expect(room!.violations()).toEqual([])
  })

  it("after b's reload, the answer-drop also heals at connectBy without the heartbeat", async () => {
    await toFault("answer-drop", { heartbeat: false })
    const result = await room!.checkLiveness()
    expect(result).toMatchObject({ steady: true, ms: 32_000 })
    expect(room!.logs().commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.objectContaining({ kind: "replace-connection", cause: "connect-by-deadline" }) }),
    ]))
    expect(room!.violations()).toEqual([])
  })

  it("b's new session's first hello dropped: the beat puts a hello back, and the pair heals", async () => {
    const labels = await toFault("hello-drop")
    expect(labels.at(-1)).toMatch(/^wire:b>a:.+:drop$/)
    const result = await room!.checkLiveness()
    expect(result).toMatchObject({ steady: true })
    expect(room!.logs().wire.some((entry) => entry.fate === "reannounced" && entry.kind === "hello" && entry.from === "b")).toBe(true)
  })

  it("b refusing a's rejoin offer (srd InvalidAccessError) heals without waiting on the clock", async () => {
    await toFault("srd-reject")
    expect(await room!.checkLiveness()).toMatchObject({ steady: true, ms: 0 })
  })

  it("#1562's shape heals by the actor's connect-by deadline, before the stale PCs' browser ICE timeout", async () => {
    const labels = await toFault("sld-reject", { custom: SLD_REFUSED })
    expect(labels.at(-1)).toBe("pc:a/2:sld:reject:OperationError")
    const result = await room!.checkLiveness()
    expect(result).toMatchObject({ steady: true })
    expect(result.ms).toBeLessThan(30_000)
    expect(room!.logs().commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: expect.objectContaining({ kind: "replace-connection", cause: "connect-by-deadline" }) }),
    ]))
    expect(room!.logs().inputs.some(({ kind }) => kind === "pc:ice-timeout-failed")).toBe(false)
    expect(room!.violations()).toEqual([])
    expect(room!.gaps("L1")).toEqual([])
  })

  it("is quick and silent on a steady pair", async () => {
    const fixture = readMeshAnchor("steady")
    room = await exploreRoom({ scenario: fixture.scenario, phaseOffsetMs: 1000 })
    await room.replay(fixture.warmup)
    expect(await room.checkLiveness()).toEqual({ steady: true, ms: 0, steps: 0 })
  })
})
