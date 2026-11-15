// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T3: the explorer's two-phone room (design 2.1, 1.1, 1.2 slice-1 labels and
 * 2.2's reset), its two slice-1 scenarios, the fair scheduler and the room's
 * import closure. Real flag-on Meshes (the peer actor driving) over T1's controlled
 * PeerConnections and T2's statement transport model.
 */
// quiescence first: it traps the real timers before anything else loads
import { liveRealTimers } from "./quiescence"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { isFault, type Label } from "../core/labels"
import { search } from "../core/search"
import type { OpLogEntry } from "./controlled-pc"
import { fairPick } from "./fair"
import { canonicalFingerprintValue, canonicalizeFrameIds, exploreRoom, HarnessError, type ExploreRoomOptions, type Room, type WireLogEntry } from "./room"
import { SCENARIOS } from "./scenarios"

const consoleLog = console.log
const consoleWarn = console.warn

/** a seeded generator (mulberry32), so every run takes the same schedules */
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** labels the room would let a search take now: faults only while F lasts */
const takeable = (room: Room) => room.enabled().filter((label) => !isFault(label) || room.faultsLeft() > 0)

/** A fair run (fairPick over the room's enabled labels, oldest first) until
 *  `done` or `max` steps; every label taken was enabled when it was taken. */
async function fairRun(room: Room, max: number, done: () => boolean = () => false): Promise<Label[]> {
  const since = new Map<Label, number>()
  const taken: Label[] = []
  const refresh = () => {
    const enabled = room.enabled()
    for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
    for (const label of enabled) if (!since.has(label)) since.set(label, taken.length)
    return enabled
  }
  while (taken.length < max && !done()) {
    const enabled = refresh()
    if (enabled.filter((label) => !isFault(label)).length === 0) break
    const label = fairPick(enabled, since)
    expect(enabled).toContain(label)
    await room.step(label)
    taken.push(label)
  }
  return taken
}

/** take the first enabled label matching `pattern`, failing with the enabled list if none */
async function take(room: Room, pattern: RegExp): Promise<Label> {
  const enabled = room.enabled()
  const label = enabled.find((candidate) => pattern.test(candidate))
  if (!label) throw new Error(`no enabled label matches ${pattern}: ${enabled.join(" ")}`)
  await room.step(label)
  return label
}

/** fair steps that avoid `avoid` until `done` */
async function fairUntil(room: Room, done: () => boolean, avoid: RegExp, max = 40) {
  const since = new Map<Label, number>()
  for (let k = 0; k < max && !done(); k++) {
    const enabled = room.enabled().filter((label) => !avoid.test(label))
    for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
    for (const label of enabled) if (!since.has(label)) since.set(label, k)
    await room.step(fairPick(enabled, since))
  }
  if (!done()) throw new Error(`not reached in ${max} fair steps: ${room.enabled().join(" ")}`)
}

const offers = (room: Room, from: string): WireLogEntry[] =>
  room.logs().wire.filter((entry) => entry.channel === "statement" && entry.from === from && entry.kind === "offer" && entry.fate === "published")

/** a seeded schedule of at most `depth` takeable labels from a fresh reset */
async function sample(room: Room, random: () => number, depth: number): Promise<Label[]> {
  await room.reset()
  const labels: Label[] = []
  while (labels.length < depth && !room.horizonReached()) {
    const enabled = takeable(room)
    if (enabled.length === 0) break
    const label = enabled[Math.floor(random() * enabled.length)]
    labels.push(label)
    await room.step(label)
  }
  return labels
}

const legacySinks = () =>
  (globalThis as { __jollityLegacyDecisionCaptureRegistry?: { sinks: Set<unknown> } }).__jollityLegacyDecisionCaptureRegistry?.sinks.size ?? 0

const options = (overrides: Partial<ExploreRoomOptions>): ExploreRoomOptions => ({ scenario: "single-offer", phaseOffsetMs: 1000, ...overrides })

describe("the explorer's two-phone room", () => {
  it("fingerprints the same room state stably and distinguishes a genuine state change", async () => {
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      await room.reset()
      const initial = room.fingerprint()
      await room.reset()
      expect(room.fingerprint()).toBe(initial)

      const label = takeable(room)[0]
      expect(label).toBeDefined()
      await room.step(label!)
      expect(room.fingerprint()).not.toBe(initial)
    } finally {
      room.close()
    }
  })

  it("walks bytes and promises explicitly and refuses opaque exotic objects", () => {
    expect(canonicalFingerprintValue(new Uint8Array([1, 2, 3]))).toBe(canonicalFingerprintValue(new Uint8Array([1, 2, 3]).buffer))
    expect(canonicalFingerprintValue(new Uint8Array([1, 2, 4]))).not.toBe(canonicalFingerprintValue(new Uint8Array([1, 2, 3])))
    expect(canonicalFingerprintValue(Promise.resolve("hidden"))).toBe(JSON.stringify({ $promise: true }))
    expect(() => canonicalFingerprintValue(new DataView(new ArrayBuffer(2)))).toThrow(HarnessError)
    expect(() => canonicalFingerprintValue(new (class Empty {})())).toThrow(/exotic object: Empty/)
  })

  it("canonicalizes only whole frame-id tokens when ids share prefixes", () => {
    const aliases = new Map(Array.from({ length: 12 }, (_, index) => [`wire-${index + 1}`, `a#${index + 1}`]))
    expect(canonicalizeFrameIds("wire-1 wire-10 wire-12 wire-1x", aliases)).toBe("a#1 a#10 a#12 wire-1x")
  })

  it("fingerprints the rejoin room", async () => {
    const room = await exploreRoom({ scenario: "rejoin-two-offers", phaseOffsetMs: 1000 })
    try {
      await room.reset()
      expect(() => room.fingerprint()).not.toThrow()
    } finally {
      room.close()
    }
  })

  it("records environment inputs on only the affected side with the clock time", async () => {
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      const before = room.fingerprint()
      await room.step("env:signal-throws:b")
      const entry = room.logs().inputs.at(-1)
      expect(entry).toMatchObject({ side: "b", kind: "env:signal-throws", clockMs: 1000 })
      expect(room.logs().inputs.filter(({ kind }) => kind === "env:signal-throws").map(({ side }) => side)).toEqual(["b"])
      expect(room.fingerprint()).not.toBe(before)
    } finally {
      room.close()
    }
  })

  it("fingerprints a change that exists only in the controller operation history", async () => {
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      await room.reset()
      const before = room.fingerprint()
      const entry: OpLogEntry = {
        pc: "b/1",
        op: "srd",
        outcome: "resolved",
        sdpRole: "offer",
        xPc: "a/1",
        xOffer: "a/1#1",
        step: 0,
      }
      const controller = (room as unknown as { controller: { log: OpLogEntry[] } }).controller
      controller.log.push(entry)

      expect(room.logs().ops).toEqual([entry])
      expect(room.fingerprint()).not.toBe(before)
    } finally {
      room.close()
    }
  })

  it("fingerprints equivalent cross-side step orders identically", async () => {
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      await room.reset()
      const first = room.enabled().filter((label) => label.startsWith("wire:") && label.endsWith(":deliver")).slice(0, 2)
      expect(first).toHaveLength(2)
      await room.replay(first)
      const forward = room.fingerprint()

      await room.reset()
      await room.replay([...first].reverse())
      expect(room.fingerprint()).toBe(forward)
    } finally {
      room.close()
    }
  })

  it("fingerprints harness frame and command ids by stable per-side ordinals", async () => {
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      await room.reset()
      const before = room.fingerprint()
      const logs = room.logs()
      const frameRename = new Map(logs.wire.flatMap((entry, index) => entry.id ? [[entry.id, `renamed-frame-${index + 41}`] as const] : []))
      for (const entry of logs.wire) if (entry.id) entry.id = frameRename.get(entry.id)!
      for (const entry of logs.deliveries) entry.frameId = frameRename.get(entry.frameId) ?? entry.frameId
      const model = (room as unknown as { model: { fingerprintState(): { store: Map<string, { id: string }>; captured: Set<string>; flight: { id: string }[] } } }).model
      const transport = model.fingerprintState()
      for (const frame of [...transport.store.values(), ...transport.flight]) frame.id = frameRename.get(frame.id) ?? frame.id
      const captured = [...transport.captured]
      transport.captured.clear()
      for (const id of captured) transport.captured.add(frameRename.get(id) ?? id)

      const commandRename = new Map(logs.commands.map((entry, index) => [entry.id, entry.id + index + 101]))
      for (const entry of logs.commands) entry.id = commandRename.get(entry.id)!
      for (const entry of logs.outcomes) entry.commandId = commandRename.get(entry.commandId) ?? entry.commandId
      expect(room.fingerprint()).toBe(before)
    } finally {
      room.close()
    }
  })

  it("keeps the real mesh-pair verdict, leaves and findings identical with census on", async () => {
    const run = async (census: boolean) => {
      const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000, faults: 0 })
      try {
        return await search(async () => room, { depth: 2, budgetMs: 30_000, census })
      } finally {
        room.close()
      }
    }
    const plain = await run(false)
    const counted = await run(true)
    const outcome = (result: Awaited<ReturnType<typeof run>>) => ({
      leaves: result.levels.map((level) => level.leaves),
      cuts: result.levels.map((level) => level.cuts),
      findings: result.findings,
      closedAtDepth: result.closedAtDepth,
      inconclusive: result.inconclusive,
    })
    expect(outcome(counted)).toEqual(outcome(plain))
    expect(counted.levels.every((level) => level.census !== undefined)).toBe(true)
  })
  beforeAll(() => {
    // Mesh logs every event; the console would hold every call
    console.log = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.log = consoleLog
    console.warn = consoleWarn
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("drives both Meshes with the peer actor", async () => {
    const room = await exploreRoom(options({}))
    try {
      const a = room.internals("a")
      expect(a.runner).not.toBeNull()
      await fairRun(room, 30)
      expect(room.logs().commands.length).toBeGreaterThan(0)
    } finally {
      room.close()
    }
  })

  it("connects two phones under the benign network with only enabled labels", async () => {
    const room = await exploreRoom(options({ scenario: "single-offer" }))
    try {
      const connected = () => (["a", "b"] as const).every((side) => {
        const conn = room.internals(side).conns.get(side === "a" ? "b" : "a")
        return conn?.pc.connectionState === "connected" && conn.channel?.readyState === "open"
      })
      const taken = await fairRun(room, 40, connected)
      expect(connected()).toBe(true)
      expect(taken.length).toBeLessThanOrEqual(40)
      expect(taken.some((label) => isFault(label))).toBe(false)
      // the identities the benign network matched: a/1 offered, b/1 answered it
      const a1 = offers(room, "a")
      expect(a1.map((entry) => entry.xPc)).toEqual(["a/1"])
      const answer = room.logs().wire.find((entry) => entry.from === "b" && entry.kind === "answer")
      expect(answer?.xPc).toBe("b/1")
      expect(answer?.xAnswers).toContain(a1[0]!.xOffer!)
    } finally {
      room.close()
    }
  })

  it("reloads b with a new sid, calls onPeerSession on a first, and keeps a's frames to b's old session deliverable", async () => {
    const room = await exploreRoom(options({ scenario: "rejoin-two-offers" }))
    try {
      // a hears b's first session, then a/1 offers
      await take(room, /^wire:b>a:[^:]+:deliver$/)
      await take(room, /^pc:a\/1:negotiationneeded$/)
      await take(room, /^pc:a\/1:sld:resolve$/)
      await take(room, /^pc:a\/1:gather$/)
      const [offer] = offers(room, "a")
      expect(offer?.xPc).toBe("a/1")
      const firstHello = room.logs().wire.find((entry) => entry.from === "b" && entry.kind === "hello")!
      await room.step("env:reload:b")
      const hellos = room.logs().wire.filter((entry) => entry.from === "b" && entry.kind === "hello")
      expect(hellos).toHaveLength(2)
      expect(hellos[1]!.sid).not.toBe(firstHello.sid)
      expect(room.internals("b").conns.get("a")?.pc).toBeDefined()
      expect(room.faultsLeft()).toBe(SCENARIOS["rejoin-two-offers"].defaults.faults - 1)
      // a's offer to b's old session is still there for the new b
      expect(room.enabled()).toContain(`wire:a>b:${offer!.id}:deliver`)
      // b's new hello reaches a: onPeerSession first, before anything else of b's new session
      const factsBefore = room.logs().externalFacts.length
      await room.step(`wire:b>a:${hellos[1]!.id}:deliver`)
      const facts = room.logs().externalFacts.slice(factsBefore).filter((fact) => fact.side === "a")
      expect(facts[0]).toMatchObject({ side: "a", peer: "b", call: "onPeerSession" })
      expect(facts.map((fact) => fact.call)).toEqual(["onPeerSession", "addPeer", "markSeen"])
      expect(room.enabled()).toContain(`wire:a>b:${offer!.id}:deliver`)
    } finally {
      room.close()
    }
  })

  it("reaches the M1385 warmup with real labels: a/1's offer captured by the new b and a/2's offer stored, both deliverable", async () => {
    const room = await exploreRoom(options({ scenario: "rejoin-two-offers" }))
    try {
      await take(room, /^wire:b>a:[^:]+:deliver$/)
      await take(room, /^pc:a\/1:negotiationneeded$/)
      await take(room, /^pc:a\/1:sld:resolve$/)
      await take(room, /^pc:a\/1:gather$/)
      const [first] = offers(room, "a")
      await room.step("env:reload:b")
      await room.step(`wire:a>b:${first!.id}:capture`)
      const hello = room.logs().wire.filter((entry) => entry.from === "b" && entry.kind === "hello")[1]!
      await room.step(`wire:b>a:${hello.id}:deliver`)
      // a rebuilds through onPeerSession; its fresh a/2 offers (the search's choices, taken fairly here)
      await fairUntil(room, () => offers(room, "a").length === 2, /^(wire:|env:|lane:)/)
      const second = offers(room, "a")[1]!
      expect(second.xPc).toBe("a/2")
      const enabled = room.enabled()
      expect(enabled).toContain(`wire:a>b:${first!.id}:deliver`)
      expect(enabled).toContain(`wire:a>b:${second.id}:deliver`)
      // the first is the captured copy (no second capture of it), the second the stored slot
      expect(enabled).not.toContain(`wire:a>b:${first!.id}:capture`)
      expect(enabled).toContain(`wire:a>b:${second.id}:capture`)
    } finally {
      room.close()
    }
  })

  it("throws from the next signal after env:signal-throws", async () => {
    const room = await exploreRoom(options({ scenario: "single-offer" }))
    try {
      await room.step("env:signal-throws:b")
      expect(room.enabled()).not.toContain("env:signal-throws:b")
      const refused = () => room.logs().wire.filter((entry) => entry.from === "b" && entry.fate === "refused")
      await fairRun(room, 40, () => refused().length > 0)
      expect(refused()).toHaveLength(1)
      expect(refused()[0]!.error).toBe("signal refused")
      // the refusal reaches the effect: b's send-answer settles rejected (flag on)
      await fairRun(room, 10, () => room.logs().outcomes.some((outcome) => outcome.side === "b" && outcome.kind === "send-answer"))
      expect(room.logs().outcomes.filter((outcome) => outcome.side === "b" && outcome.kind === "send-answer").map((outcome) => outcome.outcome)).toEqual(["rejected"])
      // once only: b's later signals go out
      const at = room.logs().wire.indexOf(refused()[0]!)
      await fairRun(room, 40, () => room.logs().wire.slice(at + 1).some((entry) => entry.from === "b" && entry.fate === "published"))
      expect(refused()).toHaveLength(1)
    } finally {
      room.close()
    }
  })

  it("resets between schedules without resetModules: 1000 schedules, zero harness cuts, fingerprint unchanged", async () => {
    const n = Number(process.env.ROOM_RESET_N ?? 1000)
    const room = await exploreRoom(options({ scenario: "rejoin-two-offers", checkUnowned: true }))
    const sinks = legacySinks()
    const cuts: string[] = []
    const clocks = new Set<string>()
    const random = rng(3)
    try {
      for (let k = 0; k < n; k++) {
        try {
          await sample(room, random, 12)
          await room.checkLeaf()
        } catch (error) {
          if (!(error instanceof HarnessError)) throw error
          cuts.push(error.detail)
        }
      }
      // A/B/A: the same labels replay to the same records after other schedules
      const labels = await sample(room, rng(77), 12)
      const first = JSON.stringify(await room.replay(labels))
      await sample(room, rng(78), 12)
      const again = JSON.stringify(await room.replay(labels))
      expect(again).toBe(first)
      await room.reset()
      clocks.add(`${Date.now()}|${performance.now()}`)
    } finally {
      room.close()
    }
    expect(cuts).toEqual([])
    expect(legacySinks()).toBe(sinks)
    // reset reinstalls the clock at 0 (it checks that itself) and builds b phaseOffsetMs later
    expect([...clocks]).toEqual(["1000|1000"])
    expect(liveRealTimers()).toBe(0)
  })

  it("fairPick takes the oldest enabled non-fault label and clock:next only when alone", () => {
    const since = new Map<Label, number>([
      ["pc:a/1:sld:resolve", 3],
      ["wire:a>b:wire-1:deliver", 1],
      ["wire:a>b:wire-1:drop", 0],
      ["env:reload:b", 0],
      ["clock:next", 0],
      ["pc:b/1:gather", 1],
    ])
    expect(fairPick(["pc:a/1:sld:resolve", "pc:b/1:gather", "wire:a>b:wire-1:deliver", "wire:a>b:wire-1:drop", "clock:next", "env:reload:b"], since)).toBe("pc:b/1:gather")
    expect(fairPick(["pc:a/1:sld:resolve", "wire:a>b:wire-1:deliver", "clock:next"], since)).toBe("wire:a>b:wire-1:deliver")
    // a label the map has never seen is the newest
    expect(fairPick(["lane:a>b:deliver", "pc:a/1:sld:resolve"], since)).toBe("pc:a/1:sld:resolve")
    expect(fairPick(["clock:next", "env:reload:b", "wire:a>b:wire-1:drop"], since)).toBe("clock:next")
    expect(() => fairPick(["env:reload:b", "wire:a>b:wire-1:dup"], since)).toThrow(/no fair label/)
    expect(() => fairPick([], since)).toThrow(/no fair label/)
  })

  it("reports no unowned wait at any leaf of 1000 schedules with checkUnowned: true", async () => {
    const n = Number(process.env.ROOM_UNOWNED_N ?? 1000)
    const cuts: string[] = []
    let leaves = 0
    for (const scenario of ["rejoin-two-offers", "single-offer"] as const) {
      const room = await exploreRoom(options({ scenario, checkUnowned: true }))
      const random = rng(scenario.length * 10 + 2)
      try {
        for (let k = 0; k < n / 2; k++) {
          leaves++
          try {
            await sample(room, random, 12)
            await room.checkLeaf()
          } catch (error) {
            if (!(error instanceof HarnessError)) throw error
            cuts.push(`${scenario}: ${error.detail}`)
          }
        }
      } finally {
        room.close()
      }
    }
    expect(leaves).toBe(n)
    expect(cuts.filter((detail) => /unowned wait/.test(detail))).toEqual([])
    expect(cuts).toEqual([])
  })

  it("catches a wait the harness does not own (the negative control, design 1.1)", async () => {
    // b's send-answer returns a promise nothing the explorer owns can settle;
    // a first room makes the stubbed mesh.ts the one this import gets
    ;(await exploreRoom(options({}))).close()
    const { Mesh } = await import("../../webrtc/mesh")
    type Execute = (this: { myId: string }, peer: string, command: { kind: string }) => unknown
    const proto = Mesh.prototype as unknown as { executePeerCommand: Execute }
    const original = proto.executePeerCommand
    proto.executePeerCommand = function (peer, command) {
      if (this.myId === "b" && command.kind === "send-answer") return new Promise(() => {})
      return original.call(this, peer, command)
    }
    try {
      const room = await exploreRoom(options({ scenario: "single-offer", checkUnowned: true }))
      try {
        await fairRun(room, 40, () => room.logs().commands.some((command) => command.side === "b" && command.kind === "send-answer"))
        const error = await room.checkLeaf().catch((caught: unknown) => caught)
        expect(error).toBeInstanceOf(HarnessError)
        expect((error as HarnessError).detail).toBe("unowned wait: b>a send-answer (in flight after 50 fair steps)")
      } finally {
        room.close()
      }
    } finally {
      proto.executePeerCommand = original
    }
  })

  it("starts at every phase offset and connects from each", async () => {
    for (const phaseOffsetMs of [0, 1000, 2000] as const) {
      const room = await exploreRoom(options({ phaseOffsetMs }))
      try {
        expect(Date.now()).toBe(phaseOffsetMs)
        const connected = () => room.internals("a").conns.get("b")?.pc.connectionState === "connected"
        await fairRun(room, 40, connected)
        expect(connected()).toBe(true)
      } finally {
        room.close()
      }
    }
  })

  it("starts as useMesh does: setRound before setPeers, so the start raises no round-changed input", async () => {
    const room = await exploreRoom(options({ scenario: "rejoin-two-offers" }))
    try {
      const roundChanged = () => room.logs().accepted.filter((entry) => (entry.event as { type?: string } | undefined)?.type === "round-changed")
      const startCalls = (side: string, from = 0) => room.logs().externalFacts.slice(from).filter((fact) => fact.side === side && fact.call !== "addPeer").map((fact) => fact.call)
      expect(startCalls("a")).toEqual(["setRound", "setPeers"])
      expect(startCalls("b")).toEqual(["setRound", "setPeers"])
      expect(roundChanged()).toEqual([])
      const from = room.logs().externalFacts.length
      await room.step("env:reload:b")
      expect(startCalls("b", from)).toEqual(["close", "setRound", "setPeers"])
      expect(roundChanged()).toEqual([])
      // the roster is the app's: the peer and nobody else
      expect([...((room.internals("b") as unknown as { roster: Set<string> }).roster)]).toEqual(["a"])
    } finally {
      room.close()
    }
  })

  it("stamps the setup's facts, frames and ops as step -1 and the first label's as 0", async () => {
    const room = await exploreRoom(options({ scenario: "single-offer" }))
    try {
      const setup = room.logs()
      expect(setup.externalFacts.length).toBeGreaterThan(0)
      expect(new Set(setup.externalFacts.map((fact) => fact.step))).toEqual(new Set([-1]))
      expect(new Set(setup.wire.map((entry) => entry.step))).toEqual(new Set([-1]))
      expect(setup.ops.every((entry) => entry.step === -1)).toBe(true)
      await take(room, /^pc:a\/1:negotiationneeded$/)
      await take(room, /^pc:a\/1:sld:resolve$/)
      const sld = room.logs().ops.find((entry) => entry.pc === "a/1" && entry.op === "sld")
      expect(sld?.step).toBe(1)
      expect(room.logs().commands.every((command) => command.step >= -1)).toBe(true)
    } finally {
      room.close()
    }
  })

  it("rebuilds the whole room before it cuts a schedule on a changed fingerprint", async () => {
    const room = await exploreRoom(options({ scenario: "single-offer" }))
    const registry = (globalThis as { __jollityLegacyDecisionCaptureRegistry?: { sinks: Set<unknown> } })
    const own = !registry.__jollityLegacyDecisionCaptureRegistry
    if (own) registry.__jollityLegacyDecisionCaptureRegistry = { sinks: new Set() }
    const leaked = {}
    try {
      registry.__jollityLegacyDecisionCaptureRegistry!.sinks.add(leaked)
      const error = await room.reset().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).detail).toMatch(/^fingerprint: legacy sinks \d+ -> \d+/)
      // no half-reset room: both phones are built and the first label steps
      expect(room.internals("a").conns.get("b")).toBeDefined()
      expect(room.internals("b").conns.get("a")).toBeDefined()
      await take(room, /^pc:a\/1:negotiationneeded$/)
      registry.__jollityLegacyDecisionCaptureRegistry!.sinks.delete(leaked)
      await room.reset()
    } finally {
      registry.__jollityLegacyDecisionCaptureRegistry?.sinks.delete(leaked)
      if (own) delete registry.__jollityLegacyDecisionCaptureRegistry
      room.close()
    }
  })

  it("refuses a label that is not enabled", async () => {
    const room = await exploreRoom(options({}))
    try {
      const error = await room.step("pc:a/9:srd:resolve").catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(HarnessError)
      expect((error as HarnessError).detail).toBe("label not enabled at step 0: pc:a/9:srd:resolve")
      expect((error as HarnessError).message).toBe("label not enabled at step 0: pc:a/9:srd:resolve")
    } finally {
      room.close()
    }
  })

  it("importing the room starts no enumeration and no self-test", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const seen = new Set<string>()
    const queue = [resolve(here, "room.ts")]
    const specifiers = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const text = readFileSync(file, "utf8")
      for (const [, specifier] of text.matchAll(specifiers)) {
        if (!specifier!.startsWith(".")) continue
        const base = resolve(dirname(file), specifier!)
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
          try {
            readFileSync(candidate)
            queue.push(candidate)
            break
          } catch {
            /* not this one */
          }
        }
      }
    }
    // the closure reaches the code under test (dynamic import included)
    expect([...seen].some((file) => file.endsWith("/lib/webrtc/mesh.ts"))).toBe(true)
    const forbidden = [...seen].filter((file) => /\/core\/search\.ts$|\/mutants\/self-test\.ts$|run\.explore\.ts$/.test(file))
    expect(forbidden).toEqual([])
  })
})
