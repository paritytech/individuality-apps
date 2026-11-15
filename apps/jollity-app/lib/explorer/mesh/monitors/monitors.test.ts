// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T5: the slice-1 property monitors P1, P1b and P2 (design 6.0, 6.1),
 * the known-gap list and the slice-1 mutant specs. Each monitor fires on a
 * violating schedule (a mutant with fixed labels, or a hand-built trace) and
 * stays quiet on the unmutated room's happy paths and sampled schedules.
 */
// quiescence first: it traps the real timers before anything else loads
import "../quiescence"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { isFault, type Label, type StepRecord } from "../../core/labels"
import { loadMutant } from "../../mutants/load"
import { loadSpec, SLICE1_MUTANTS } from "../../mutants/spec"
import { validateGaps, KNOWN_GAPS } from "../known-gaps"
import { fairPick } from "../fair"
import { exploreRoom, type DeliveryLogEntry, type Room, type RoomLogs, type WireLogEntry } from "../room"
import { monitorsFor, SLICE1_MONITORS, SLICE2_MONITORS } from "./index"
import { P1 } from "./p1"
import { P2 } from "./p2"
import { p1bMonitor } from "./p1b"
import { DEADLINE } from "./deadline"
import { createPeerActorState, stepPeerActor, type PeerActorState } from "../../../state-machines/peer-actor"

const appRoot = fileURLToPath(new URL("../../../../", import.meta.url))
const consoleLog = console.log
const consoleWarn = console.warn

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

/** fair steps (oldest enabled non-fault label first) until `done` or `max` */
async function fairRun(room: Room, max: number, done: () => boolean = () => false): Promise<Label[]> {
  const since = new Map<Label, number>()
  const taken: Label[] = []
  while (taken.length < max && !done()) {
    const enabled = room.enabled()
    for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
    for (const label of enabled) if (!since.has(label)) since.set(label, taken.length)
    if (enabled.filter((label) => !isFault(label)).length === 0) break
    const label = fairPick(enabled, since)
    await room.step(label)
    taken.push(label)
  }
  return taken
}

async function steps(room: Room, labels: readonly Label[]) {
  for (const label of labels) await room.step(label)
}

const record = (index: number, frames: unknown[] = [], outcomes: unknown[] = []): StepRecord =>
  ({ index, label: "test", frames, commands: [], outcomes, accepted: [], clockMs: 0, turns: 1 })

/** a room that holds only the logs a test writes by hand */
function stubRoom(logs: Partial<RoomLogs>): Room {
  const full: RoomLogs = { inputs: [], wire: [], deliveries: [], ops: [], commands: [], outcomes: [], accepted: [], externalFacts: [], ...logs }
  return { logs: () => full } as unknown as Room
}

/** b has the leave to offer to a, in Mesh's Set */
function grantB(room: Room) {
  room.internals("b").answererMayOffer.add("a")
}

/** a's offer delivered to b, b's SRD and its answer's SLD resolved: the answer gathers */
const P1_PREFIX: Label[] = [...loadSpec("M1374s").warmup, "pc:b/1:sld:resolve"]

/** a hears b's first hello, a/1's offer is stored, b reloads and its new
 *  transport captures that offer (T0's S4 warmup; M1385's spec warmup goes on
 *  to a/2's offer since T7) */
const M1385_CAPTURED: Label[] = [
  "wire:b>a:wire-2:deliver", "pc:a/1:negotiationneeded", "pc:a/1:sld:resolve", "pc:a/1:gather",
  "env:reload:b", "wire:a>b:wire-3:capture",
]

/** that prefix, then the captured a/1 offer and a/2's fresh offer both applied to b/2 (T0's S4 shape) */
const P1B_WITNESS: Label[] = [
  ...M1385_CAPTURED,
  "wire:a>b:wire-3:deliver", "wire:b>a:wire-4:deliver",
  "pc:a/2:negotiationneeded", "pc:a/2:sld:resolve", "pc:a/2:gather",
  "wire:a>b:wire-5:deliver", "pc:b/2:srd:resolve", "pc:b/2:srd:resolve",
]
const P1B_DETAIL = "b/2 resolved offers from a/1 and a/2"

const M1374S_WITNESS: Label[] = [
  ...loadSpec("M1374s").warmup,
  "pc:b/1:sld:resolve", "env:signal-throws:b", "pc:b/1:gather",
]

describe("the slice-1 monitors", () => {
  beforeAll(() => {
    console.log = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.log = consoleLog
    console.warn = consoleWarn
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("registers the wire and recovery-deadline monitors for slice 1; slice 2 adds its own list", () => {
    expect(SLICE1_MONITORS.map((monitor) => monitor.id)).toEqual(["P1", "P1b", "P2", "D"])
    expect(SLICE2_MONITORS).toEqual([])
    expect(monitorsFor(1).map((monitor) => monitor.id)).toEqual(["P1", "P1b", "P2", "D"])
    expect(monitorsFor(2).map((monitor) => monitor.id)).toEqual(["P1", "P1b", "P2", "D"])
  })

  it("declares every active slice-1 monitor trace-closed", () => {
    expect(SLICE1_MONITORS.map(({ id, closed }) => [id, closed])).toEqual([
      ["P1", true],
      ["P1b", true],
      ["P2", true],
      ["D", true],
    ])
  })

  // Design B's recovery invariant (peer-actor.ts missingRecoveryDeadline): a
  // fresh connection of a peer connected before, #1562's shape, holds its
  // connectBy; with it taken away (B3b had none) D reports it.
  it("D flags a connecting actor with no connectBy, and passes the same actor with it", () => {
    const scope = { game: 1, roomEpoch: 1, peer: "b" }
    const fresh = stepPeerActor(
      createPeerActorState(scope, { everConnected: true, firstHeardAt: Date.now() - 60_000 }),
      { type: "connection-replaced-externally", roomEpoch: 1, connectionEpoch: 2, now: Date.now() },
    ).state
    fresh.lastSignalAt = Date.now()
    fresh.deadlines.freshUntil = Date.now() + 45_000
    const conn = { pc: { connectionState: "new" as RTCPeerConnectionState, signalingState: "stable" as RTCSignalingState, localDescription: null, remoteDescription: null }, channel: null, away: null, framesSeen: 0 }
    const roomWith = (actor: PeerActorState) => ({
      internals: () => ({ runner: { state: () => actor }, conns: new Map([["a", conn], ["b", conn]]) }),
    }) as unknown as Room
    const record = { index: 3 } as StepRecord
    expect(fresh.deadlines.connectBy).not.toBeNull()
    expect(DEADLINE.afterStep(roomWith(fresh), record)).toEqual([])
    const unarmed = { ...fresh, deadlines: { ...fresh.deadlines, connectBy: null } }
    expect(DEADLINE.afterStep(roomWith(unarmed), record).map((violation) => violation.detail)).toEqual([
      "a's actor for b: connecting with no connectBy",
      "b's actor for a: connecting with no connectBy",
    ])
  })

  it("P1 flags an offer-typed description sent by a send-answer", async () => {
    // b holds the leave to offer (injected, as mesh-peer-authority.test.ts does)
    // and its PC needs negotiation (an ICE restart, injected) while its answer
    // to a/1 gathers: b's own offer is set before the answer path reads
    // localDescription. M1385b drops the type check that would stop it.
    const run = async (room: Room) => {
      await room.reset()
      grantB(room)
      await steps(room, P1_PREFIX)
      ;(room.internals("b").conns.get("a")!.pc as unknown as { restartIce(): void }).restartIce()
      await steps(room, ["pc:b/1:negotiationneeded", "pc:b/1:sld:resolve", "pc:b/1:gather"])
    }
    const mutant = await loadMutant(loadSpec("M1385b"))
    try {
      const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
      try {
        await run(room)
        const p1 = room.violations("P1")
        expect(p1.map((violation) => violation.detail)).toEqual(["b/1 sent an offer description as its answer on the statement wire"])
        expect(mutant.hits[0]).toBe(1)
        // the frame P1 judged went out on the wire: b's own offer, carrying the gen of a's offer it answers
        const sent = room.logs().wire.find((entry) => entry.step === p1[0]!.atStep && entry.from === "b" && entry.meshGen !== undefined)
        expect(sent).toMatchObject({ fate: "published", xRole: "offer", meshGen: "0-a1.1" })
      } finally {
        room.close()
      }
    } finally {
      await mutant.undo()
    }
    // fixed clean: the unmutated answer path rolls the offer back and sends nothing as the answer
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      const diverged = await run(room).then(() => null, (error: unknown) => (error as Error).message)
      // the control runs every label on the unmutated code (no divergence), so it judges something
      expect(diverged).toBeNull()
      expect(room.violations("P1")).toEqual([])
    } finally {
      room.close()
    }
  })

  it("P1 flags an answer whose gen is not its offer's", () => {
    const deliveries: DeliveryLogEntry[] = [{ step: 2, frameId: "wire-3", from: "a", to: "b", kind: "offer", gen: "0-a1.1", xPc: "a/1", xOffer: "a/1#1", dup: false }]
    const answer = (meshGen: string): WireLogEntry => ({
      step: 5, channel: "statement", from: "b", to: "a", fate: "published", kind: "answer", id: "wire-4", sid: "1000-b1", gen: meshGen, meshGen,
      xPc: "b/1", xRole: "answer", xAnswers: "a/1/u0/a/1#1",
    })
    const wrong = answer("0-a1.2")
    expect(P1.afterStep(stubRoom({ wire: [wrong], deliveries }), record(5, [wrong]))).toEqual([
      { property: "P1", atStep: 5, detail: "b/1's answer to a/1#1 carries gen 0-a1.2 but that offer was delivered with gen 0-a1.1" },
    ])
    const right = answer("0-a1.1")
    expect(P1.afterStep(stubRoom({ wire: [right], deliveries }), record(5, [right]))).toEqual([])
    // an answer to an offer this side never had delivered
    expect(P1.afterStep(stubRoom({ wire: [right], deliveries: [] }), record(5, [right]))[0]?.detail).toMatch(/never delivered/)
    // a frame the transport did not take is not judged
    const refused = { ...wrong, fate: "refused" as const }
    expect(P1.afterStep(stubRoom({ wire: [refused], deliveries }), record(5, [refused]))).toEqual([])
  })

  it("P1b flags one PC applying offers from two remote PCs", async () => {
    const spec = loadSpec("M1385-on")
    const mutant = await loadMutant(spec)
    try {
      const room = await exploreRoom({ scenario: spec.scenario, phaseOffsetMs: 1000, faults: spec.bounds.faults, knownGaps: false })
      try {
        await room.replay(P1B_WITNESS)
        expect(room.violations("P1b").map((violation) => violation.detail)).toEqual([P1B_DETAIL])
        expect(room.violations("P1b")[0]!.atStep).toBe(P1B_WITNESS.length - 1)
        expect(mutant.hits[0]).toBeGreaterThan(0)
      } finally {
        room.close()
      }
    } finally {
      await mutant.undo()
    }
    // fixed clean: the same labels on the unmutated code show no P1b (or diverge)
    const room = await exploreRoom({ scenario: "rejoin-two-offers", phaseOffsetMs: 1000 })
    try {
      const diverged = await room.replay(P1B_WITNESS).then(() => null, (error: unknown) => (error as Error).message)
      // unmutated, the barrier holds a/2's offer until b/2 answers a/1: the
      // second SRD is the one label the control cannot take, and no P1b came before it
      expect(diverged).toBe(`label not enabled at step ${P1B_WITNESS.length - 1}: pc:b/2:srd:resolve`)
      expect(room.violations("P1b")).toEqual([])
    } finally {
      room.close()
    }
  })

  it("P2 flags a send-answer resolved with no answer on the wire", async () => {
    const spec = loadSpec("M1374s")
    const mutant = await loadMutant(spec)
    try {
      const room = await exploreRoom({ scenario: spec.scenario, phaseOffsetMs: 1000, faults: spec.bounds.faults, knownGaps: false })
      try {
        await room.replay(M1374S_WITNESS)
        expect(room.violations()).toEqual([
          { property: "P2", atStep: M1374S_WITNESS.length - 1, detail: "b's statement send-answer on b/1 settled resolved with 0 answers to a/1#1 on the wire" },
        ])
        // the signal was refused, so nothing reached the wire, and the effect said resolved
        expect(room.logs().wire.filter((entry) => entry.from === "b" && entry.kind === "answer").map((entry) => entry.fate)).toEqual(["refused"])
        expect(room.logs().outcomes.filter((outcome) => outcome.kind === "send-answer").map((outcome) => outcome.outcome)).toEqual(["resolved"])
        expect(mutant.hits[0]).toBe(1)
      } finally {
        room.close()
      }
    } finally {
      await mutant.undo()
    }
    // fixed clean: unmutated, the same labels settle the send-answer rejected and P2 is quiet
    const room = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000 })
    try {
      await room.replay(M1374S_WITNESS)
      expect(room.logs().outcomes.filter((outcome) => outcome.kind === "send-answer").map((outcome) => outcome.outcome)).toEqual(["rejected"])
      expect(room.violations()).toEqual([])
    } finally {
      room.close()
    }
  })

  it("P2 reads the effect's own outcome even when the reducer ignores the completion", async () => {
    const spec = loadSpec("M1374s")
    const mutant = await loadMutant(spec)
    try {
      const room = await exploreRoom({ scenario: spec.scenario, phaseOffsetMs: 1000, faults: spec.bounds.faults, knownGaps: false })
      try {
        await room.reset()
        await steps(room, M1374S_WITNESS.slice(0, -1))
        // b's send-answer is in flight; its actor stops counting it as open
        // (state injection), so the reducer will ignore its completion
        const actor = room.internals("b").runner!.state("a")!
        expect(actor.openCommands["send-answer"]).toBeDefined()
        delete actor.openCommands["send-answer"]
        const before = room.logs().accepted.length
        await room.step(M1374S_WITNESS.at(-1)!)
        const ignored = room.logs().accepted.slice(before).filter((entry) => entry.side === "b" && entry.kind === "ignored")
        expect(ignored.map((entry) => entry.reason)).toContain("stale-command")
        expect(room.logs().accepted.slice(before).some((entry) => entry.side === "b" && entry.kind === "accepted" && (entry.event as { type?: string }).type === "command-completed")).toBe(false)
        // P2 judges what the effect returned, which the spy recorded
        expect(room.violations("P2").map((violation) => violation.detail)).toEqual(["b's statement send-answer on b/1 settled resolved with 0 answers to a/1#1 on the wire"])
      } finally {
        room.close()
      }
    } finally {
      await mutant.undo()
    }
    // and on a hand-built trace: an outcome with no accepted completion at all is judged the same
    const logs: Partial<RoomLogs> = {
      ops: [{ pc: "b/1", op: "srd", outcome: "resolved", sdpRole: "offer", xPc: "a/1", xOffer: "a/1#1", step: 1 }],
      commands: [{ id: 7, step: 1, side: "b", peer: "a", kind: "send-answer", command: { kind: "send-answer", lane: false }, pcAtIssue: "b/1" }],
      accepted: [{ step: 3, side: "b", kind: "ignored", reason: "stale-command" }],
    }
    const outcome = { commandId: 7, step: 3, side: "b", peer: "a", kind: "send-answer", shape: "async", outcome: "resolved", result: { outcome: "resolved" } }
    expect(P2.afterStep(stubRoom(logs), record(3, [], [outcome])).map((violation) => violation.detail)).toEqual([
      "b's statement send-answer on b/1 settled resolved with 0 answers to a/1#1 on the wire",
    ])
    // stale with the answer on the wire is dishonest too; stale with none is not
    const answer: WireLogEntry = { step: 2, channel: "statement", from: "b", to: "a", fate: "published", kind: "answer", id: "wire-4", gen: "g", meshGen: "g", xPc: "b/1", xRole: "answer", xAnswers: "a/1/u0/a/1#1" }
    const stale = { ...outcome, outcome: "stale" }
    expect(P2.afterStep(stubRoom({ ...logs, wire: [answer] }), record(3, [], [stale]))).toHaveLength(1)
    expect(P2.afterStep(stubRoom(logs), record(3, [], [stale]))).toEqual([])
    // a skipped answer (the transport kept it out of its store) is not on the wire
    expect(P2.afterStep(stubRoom({ ...logs, wire: [{ ...answer, fate: "skipped" }] }), record(3, [], [outcome]))).toHaveLength(1)
    expect(P2.afterStep(stubRoom({ ...logs, wire: [answer] }), record(3, [], [outcome]))).toEqual([])
  })

  it("P2 leaves a send-answer superseded by a newer offer quiet, and judges a skipped answer without one", () => {
    // b/1 resolved a/1#1 and answered it with gen .1; a/1#2 (gen .2) reached b
    // before the publish, so the transport skipped the answer as stale
    const base: Partial<RoomLogs> = {
      ops: [{ pc: "b/1", op: "srd", outcome: "resolved", sdpRole: "offer", xPc: "a/1", xOffer: "a/1#1", step: 1 }],
      commands: [{ id: 3, step: 1, side: "b", peer: "a", kind: "send-answer", command: { kind: "send-answer", lane: false }, pcAtIssue: "b/1" }],
    }
    const offer1: DeliveryLogEntry = { step: 0, frameId: "wire-3", from: "a", to: "b", kind: "offer", gen: "0-a1.1", xPc: "a/1", xOffer: "a/1#1", dup: false }
    const offer2: DeliveryLogEntry = { step: 2, frameId: "wire-5", from: "a", to: "b", kind: "offer", gen: "0-a1.2", xPc: "a/1", xOffer: "a/1#2", dup: false }
    const skipped: WireLogEntry = { step: 4, channel: "statement", from: "b", to: "a", fate: "skipped", kind: "answer", id: "wire-6", gen: "0-a1.1", meshGen: "0-a1.1", xPc: "b/1", xRole: "answer", xAnswers: "a/1/u0/a/1#1" }
    const resolved = { commandId: 3, step: 4, side: "b", peer: "a", kind: "send-answer", shape: "async", outcome: "resolved", result: { outcome: "resolved" } }
    const judge = (deliveries: DeliveryLogEntry[], wire: WireLogEntry[] = [skipped]) => P2.afterStep(stubRoom({ ...base, deliveries, wire }), record(4, [], [resolved]))
    expect(judge([offer1, offer2])).toEqual([])
    // no newer offer: the skip is not explained, so resolved with nothing on the wire stays a violation
    expect(judge([offer1])).toHaveLength(1)
    // a newer offer delivered only after the publish explains nothing either
    expect(judge([offer1, { ...offer2, step: 5 }])).toHaveLength(1)
    // a re-delivery of the answered offer itself is not a newer one
    expect(judge([offer1, { ...offer1, step: 2, dup: true }])).toHaveLength(1)
    // a refused answer is never superseded
    expect(judge([offer1, offer2], [{ ...skipped, fate: "refused" }])).toHaveLength(1)
  })


  it("P1b reports an exact gap's detail with its issue and any other pair as a violation", () => {
    const op = (pc: string, xPc: string, step: number) => ({ pc, op: "srd", outcome: "resolved" as const, sdpRole: "offer" as const, xPc, step })
    const gaps = [{ property: "P1b" as const, match: "b/2 resolved offers from a/1 and a/2", exact: true, issue: 1499, note: "fixture" }]
    const gapped = p1bMonitor(gaps).afterStep(stubRoom({ ops: [op("b/2", "a/1", 3), op("b/2", "a/2", 5)] }), record(5))
    expect(gapped).toEqual([{ property: "P1b", atStep: 5, detail: "b/2 resolved offers from a/1 and a/2", issue: 1499 }])
    const other = p1bMonitor(gaps).afterStep(stubRoom({ ops: [op("b/1", "a/1", 3), op("b/1", "a/2", 5)] }), record(5))
    expect(other).toEqual([{ property: "P1b", atStep: 5, detail: "b/1 resolved offers from a/1 and a/2" }])
    // with the default list (no P1b gap since #1500) the same pair is a violation
    expect(p1bMonitor().afterStep(stubRoom({ ops: [op("b/2", "a/1", 3), op("b/2", "a/2", 5)] }), record(5))[0]!.issue).toBeUndefined()
  })

  it("validateGaps throws on an entry whose issue is 0 or missing", () => {
    expect(() => validateGaps(KNOWN_GAPS)).not.toThrow()
    expect(() => validateGaps([{ property: "P6", match: "x", issue: 3, note: "" }])).toThrow(/property/)
    expect(() => validateGaps([{ property: "P1b", match: "b/2 resolved offers from a/1 and a/2", issue: 3, note: "", exact: true }])).not.toThrow()
    // a P1b gap names one exact pair, never a substring
    expect(() => validateGaps([{ property: "P1b", match: "resolved offers", issue: 3, note: "" }])).toThrow(/P1b gap must be exact/)
  })

  it("loadSpec reads every slice-1 mutant JSON and each find text occurs exactly once in its target", async () => {
    for (const id of SLICE1_MUTANTS) {
      const spec = loadSpec(id)
      expect(spec.id).toBe(id)
      const text = readFileSync(`${appRoot}${spec.target}`, "utf8")
      for (const { find } of spec.hunks) {
        const at = text.indexOf(find)
        expect(at, `${id}: ${find}`).toBeGreaterThanOrEqual(0)
        expect(text.indexOf(find, at + 1), `${id}: ${find}`).toBe(-1)
      }
      // the warmup is real enabled labels on the unmutated room
      const room = await exploreRoom({ scenario: spec.scenario, phaseOffsetMs: 1000, faults: spec.bounds.faults, knownGaps: false })
      try {
        for (const label of spec.warmup) {
          expect(room.enabled(), `${id}: ${label}`).toContain(label)
          await room.step(label)
        }
      } finally {
        room.close()
      }
    }
    expect(() => loadSpec("no-such-mutant")).toThrow()
  })

  it("all slice-1 monitors are silent on both scenarios' happy paths", async () => {
    const n = Number(process.env.MONITORS_SAMPLE_N ?? 200)
    for (const scenario of ["rejoin-two-offers", "single-offer"] as const) {
      const room = await exploreRoom({ scenario, phaseOffsetMs: 1000 })
      try {
        // the fair run connects the pair and keeps it
        const taken = await fairRun(room, 80)
        expect(taken.length).toBeGreaterThan(20)
        expect(room.violations(), `${scenario} fair`).toEqual([])
        expect(room.gaps()).toEqual([])
        // and seeded schedules of every non-fault label, in any order (a
        // happy path is one with no fault; faults are the search's to judge)
        const random = rng(scenario.length * 7 + 2)
        for (let k = 0; k < n; k++) {
          await room.reset()
          const labels: Label[] = []
          while (labels.length < 12 && !room.horizonReached()) {
            const enabled = room.enabled().filter((label) => !isFault(label))
            if (enabled.length === 0) break
            const label = enabled[Math.floor(random() * enabled.length)]!
            labels.push(label)
            await room.step(label)
          }
          expect(room.violations(), `${scenario}: ${labels.join(" ")}`).toEqual([])
        }
      } finally {
        room.close()
      }
    }
  })

  it("does not count an answer the transport skipped as stale as on the wire", async () => {
    // a/1's offer (counter 1) and a/2's (counter 2) of one a session both reach the new b;
    // an answer b then sends with the first offer's gen is skipped by the transport
    const room = await exploreRoom({ scenario: "rejoin-two-offers", phaseOffsetMs: 1000 })
    try {
      await steps(room, M1385_CAPTURED)
      const first = room.logs().wire.find((entry) => entry.from === "a" && entry.kind === "offer")!
      const hello = room.logs().wire.filter((entry) => entry.from === "b" && entry.kind === "hello")[1]!
      await room.step(`wire:b>a:${hello.id}:deliver`)
      const offers = () => room.logs().wire.filter((entry) => entry.from === "a" && entry.kind === "offer" && entry.fate === "published")
      const since = new Map<Label, number>()
      for (let k = 0; k < 40 && offers().length < 2; k++) {
        const enabled = room.enabled().filter((label) => !/^(wire:|env:|lane:)/.test(label))
        for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
        for (const label of enabled) if (!since.has(label)) since.set(label, k)
        await room.step(fairPick(enabled, since))
      }
      const second = offers()[1]!
      await room.step(`wire:a>b:${first.id}:deliver`)
      await room.step(`wire:a>b:${second.id}:deliver`)
      const outGen = () => (room as unknown as { outGen: Record<string, string | undefined> }).outGen.b
      const genBefore = outGen()
      const wireBefore = room.logs().wire.length
      // b's Mesh signals an answer to the first offer (its own signal callback)
      const signal = (room.internals("b") as unknown as { signal(to: string, data: unknown): void }).signal
      signal("a", { rtc: { desc: { type: "answer", sdp: "v=0\r\na=x-pc:b/2\r\na=x-role:answer\r\n" }, gen: first.gen } })
      const entry = room.logs().wire.slice(wireBefore).find((logged) => logged.kind === "answer")!
      expect(entry).toMatchObject({ fate: "skipped", meshGen: first.gen })
      expect(outGen()).toBe(genBefore)
      expect(room.enabled().some((label) => label.includes(`:${entry.id}:`))).toBe(false)
    } finally {
      room.close()
    }
  })
})
