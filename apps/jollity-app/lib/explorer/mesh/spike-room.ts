// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The scheduler spike's two-phone room (spike.explore.ts), built minimally: two Meshes with the
 * peer actor driving over FakePC under an explorer controller, driven only by
 * semantic labels, one task per step followed by a watchdogged drain.
 *
 * What it models, and what it leaves to the full room (room.ts):
 * - every SRD, SLD, rollback and candidate op waits for its `pc:<s>/<n>:<op>:resolve`
 *   label; gathering ends only on `pc:<s>/<n>:gather`; a fresh channel's
 *   negotiationneeded fires only on `pc:<s>/<n>:negotiationneeded`;
 * - the statement wire is a store holding the newest frame per
 *   (from, to, sid, kind), plus each receiver's in-flight queue filled by
 *   `capture`; a sender's frames of
 *   a session the receiver left are dropped once its hello is delivered;
 * - `env:reload:b` and `clock:next`, one timer per label;
 * - P1 and P1b, the two properties S4 needs, judged from the wire and op logs.
 * Not modelled here (room.ts has them): the benign network (no pair ever connects),
 * the paired lane, rejection and drop/dup faults, getStats deferreds (FakePC's
 * getStats resolves at once, i.e. the `auto` policy), restartIce.
 */
import { vi } from "vitest"
import type { Mesh as MeshType } from "../../webrtc/mesh"
import { FakePC, sdp, type FakePCController } from "../../webrtc/test-pc"
import type { Label, Side, StepRecord } from "../core/labels"
import { drain, installFakeClock, liveRealTimers, MAX_TURNS, type FakeClock } from "./quiescence"

// What code under test sees when it captures the global at load, before fake
// timers: after quiescence.ts, the trapped real timers. The S3 control's
// variant (ii) goes through these, so the trap has to catch it.
const capturedSetTimeout = globalThis.setTimeout
const capturedClearTimeout = globalThis.clearTimeout
/** for S3: the global setTimeout this module captured at load */
export const capturedRealSetTimeout = capturedSetTimeout

export type MeshClass = typeof MeshType
type PcOp = "srd" | "sld" | "cand" | "rollback"
type Kind = "offer" | "answer" | "cand" | "hello"

export interface SpikeScenario {
  /** Mesh b is constructed this long (fake ms) after Mesh a */
  phaseOffsetMs: number
  /** `clock:next` is disabled for a timer due after this */
  horizonMs: number
  /** fault budget F (env:reload:b is the one fault label here) */
  faults: number
  /** whether `wire:…:capture` labels are enabled */
  capture: boolean
  /** the S3 negative control: b's first send-answer never settles */
  control: null | "never" | "real-timer"
}

export const REJOIN_TWO_OFFERS: SpikeScenario = { phaseOffsetMs: 1000, horizonMs: 120_000, faults: 1, capture: true, control: null }

interface QueuedOp { op: PcOp; apply: () => void; resolve: () => void; reject: (error: unknown) => void }
interface PcInfo { side: Side; n: number; queue: QueuedOp[]; offers: number; channelsHandled: number; srdOffersFrom: string[] }

export interface Frame {
  id: string
  from: Side
  to: Side
  sid: string
  kind: Kind
  gen?: string
  payload: { rtc: { desc?: { type: string; sdp?: string }; cand?: unknown; gen?: string } } | null
  xPc?: string
  xRole?: string
  xAnswers?: string
  xOffer?: string
}

export interface Violation { property: "P1" | "P1b"; step: number; detail: string }
export type Cut = "depth" | "faults" | "horizon" | "quiet" | "harness" | "violation"

interface CommandEntry { side: Side; peer: string; kind: string; settled: boolean }

const attr = (body: string | undefined, name: string): string | undefined =>
  new RegExp(`^a=${name}:(.*)$`, "m").exec(body ?? "")?.[1]?.trim()

const frameJson = (frame: Frame) => ({
  id: frame.id, from: frame.from, to: frame.to, sid: frame.sid, kind: frame.kind, gen: frame.gen ?? null,
  desc: frame.payload?.rtc.desc?.type ?? null, xPc: frame.xPc ?? null, xRole: frame.xRole ?? null,
  xAnswers: frame.xAnswers ?? null, xOffer: frame.xOffer ?? null,
})

type MeshInternals = {
  actorWork: Map<string, Set<Promise<unknown>>>
  answering: Map<string, unknown>
  executePeerCommand(peer: string, command: { kind: string; connectionEpoch?: number; commandEpoch?: number; cause?: string; lane?: boolean }): unknown
  addPeer(peer: string, initiate?: boolean, replacedExternally?: boolean): void
}

export class SpikeRoom implements FakePCController {
  private clock!: FakeClock
  private pcs = new Map<FakePC, PcInfo>()
  private pcCount: Record<Side, number> = { a: 0, b: 0 }
  private meshes: MeshType[] = []
  private mesh!: Record<Side, MeshType>
  private sid!: Record<Side, string>
  /** knows[to][from]: the sender session the receiver currently adopts */
  private knows!: Record<Side, Record<Side, string>>
  private left!: Record<Side, Set<string>>
  private store = new Map<string, Frame>()
  private captured = new Set<string>()
  private inFlight!: Record<Side, Frame[]>
  private frameCount = 0
  private genCount = new Map<string, number>()
  private deliveredOfferGen = new Map<string, string>()
  private sessions!: Record<Side, number>
  private faultsLeft = 0
  private stepIndex = 0
  private stepFrames: unknown[] = []
  private stepCommands: unknown[] = []
  private stepOutcomes: unknown[] = []
  private outcomeCount = 0
  private commandsByPromise = new Map<Promise<unknown>, CommandEntry>()
  private controlUsed = false
  private controlTimer: unknown = null
  private firstEnabled = new Map<Label, number>()
  readonly records: StepRecord[] = []
  readonly violations: Violation[] = []
  /** set when the schedule must end as a harness cut */
  harness: string[] = []
  /** Date.now() and monoNow() read at the schedule's start, after the reset */
  startClock = { date: -1, mono: -1 }

  constructor(
    private readonly Mesh: MeshClass,
    private readonly monoNow: () => number,
    private readonly scenario: SpikeScenario,
  ) {}

  /** whether the S3 control was handed out in this schedule */
  get controlReached() { return this.controlUsed }

  // ── FakePCController ──────────────────────────────────────────────────────

  enqueue(pc: FakePC, op: PcOp, apply: () => void): Promise<void> {
    const info = this.pcs.get(pc)
    if (!info) return Promise.reject(new Error("explorer: an op on a PC the room never saw built"))
    if (pc.signalingState === "closed") return Promise.reject(new DOMException("The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError"))
    return new Promise<void>((resolve, reject) => info.queue.push({ op, apply, resolve, reject }))
  }

  sdpFor(pc: FakePC, type: "offer" | "answer"): string {
    const info = this.pcs.get(pc)!
    const id = `${info.side}/${info.n}`
    const lines = [`a=x-pc:${id}`, `a=x-role:${type}`]
    if (type === "offer") lines.push(`a=x-offer:${id}#${++info.offers}`)
    else {
      const remote = pc.remoteDescription?.sdp
      lines.push(`a=x-answers:${attr(remote, "x-pc") ?? "?"}/${attr(remote, "ice-ufrag") ?? "?"}/${attr(remote, "x-offer") ?? "?"}`)
    }
    return `${sdp(`${info.side}${info.n}`)}${lines.join("\r\n")}\r\n`
  }

  onClose(pc: FakePC): void {
    const info = this.pcs.get(pc)
    if (!info) return
    const queued = info.queue.splice(0)
    for (const item of queued) item.reject(new DOMException("The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError"))
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** A fresh room: old Meshes closed and drained, controller and wire reset,
   *  the fake clock reinstalled at 0, both Meshes built. No module reset. */
  async reset(): Promise<void> {
    for (const mesh of this.meshes) mesh.close()
    if (this.meshes.length > 0) await drain(this)
    if (this.controlTimer !== null) capturedClearTimeout(this.controlTimer as ReturnType<typeof setTimeout>)
    this.controlTimer = null
    FakePC.controller = this
    FakePC.last = []
    this.pcs.clear()
    this.pcCount = { a: 0, b: 0 }
    this.meshes = []
    this.store.clear()
    this.captured.clear()
    this.inFlight = { a: [], b: [] }
    this.frameCount = 0
    this.genCount.clear()
    this.deliveredOfferGen.clear()
    this.sessions = { a: 1, b: 1 }
    this.sid = { a: "a1", b: "b1" }
    this.knows = { a: { a: "a1", b: "b1" }, b: { a: "a1", b: "b1" } }
    this.left = { a: new Set(), b: new Set() }
    this.faultsLeft = this.scenario.faults
    this.stepIndex = 0
    this.outcomeCount = 0
    this.commandsByPromise.clear()
    this.controlUsed = false
    this.firstEnabled.clear()
    this.records.length = 0
    this.violations.length = 0
    this.harness = []
    this.clock = installFakeClock()
    this.startClock = { date: Date.now(), mono: this.monoNow() }
    const a = this.build("a")
    vi.advanceTimersByTime(this.scenario.phaseOffsetMs) // b starts out of phase (no timer is due this early)
    const b = this.build("b")
    this.mesh = { a, b }
    const turns = await drain(this)
    if (turns > MAX_TURNS) this.harness.push("watchdog")
  }

  private build(side: Side): MeshType {
    const peer: Side = side === "a" ? "b" : "a"
    const sid = this.sid[side]
    const track = { kind: "video", id: `${side}-camera`, readyState: "live", getSettings: () => ({ width: 720, height: 1280 }), addEventListener() {}, removeEventListener() {} }
    const local = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
    const mesh = new this.Mesh(
      side, local, {},
      (to, data) => this.publish(side, sid, to as Side, data as Frame["payload"]),
      () => {}, () => {}, () => {},
      { decisionRoom: "g42", decisionRoomEpoch: 1 },
    )
    const internals = mesh as unknown as MeshInternals
    const addPeer = internals.addPeer.bind(mesh)
    internals.addPeer = (peerId, initiate, replacedExternally) => {
      const before = FakePC.last.length
      addPeer(peerId, initiate, replacedExternally)
      for (const pc of FakePC.last.slice(before)) {
        this.pcs.set(pc, { side, n: ++this.pcCount[side], queue: [], offers: 0, channelsHandled: 0, srdOffersFrom: [] })
      }
    }
    const execute = internals.executePeerCommand.bind(mesh)
    internals.executePeerCommand = (peerId, command) => {
      this.stepCommands.push({ side, peer: peerId, kind: command.kind, cause: command.cause ?? null, lane: command.lane ?? null, connectionEpoch: command.connectionEpoch ?? null })
      let effect: unknown
      if (this.scenario.control && side === "b" && command.kind === "send-answer" && !this.controlUsed) {
        this.controlUsed = true
        effect = this.scenario.control === "never"
          ? new Promise(() => {})
          : new Promise((resolve) => { this.controlTimer = capturedSetTimeout(() => resolve({ outcome: "resolved" }), 60_000) })
      } else effect = execute(peerId, command)
      this.recordOutcome(side, peerId, command.kind, effect)
      return effect
    }
    this.meshes.push(mesh)
    mesh.addPeer(peer)
    mesh.setRound(1)
    return mesh
  }

  private recordOutcome(side: Side, peer: string, kind: string, effect: unknown) {
    const note = (outcome: unknown) => {
      this.outcomeCount++
      this.stepOutcomes.push({ side, peer, kind, outcome })
    }
    if (effect && typeof (effect as Promise<unknown>).then === "function") {
      const promise = effect as Promise<unknown>
      const entry: CommandEntry = { side, peer, kind, settled: false }
      this.commandsByPromise.set(promise, entry)
      promise.then(
        (value) => { entry.settled = true; note((value as { outcome?: string } | undefined)?.outcome ?? "resolved") },
        () => { entry.settled = true; note("rejected") },
      )
    } else note(effect === undefined ? "none" : (effect as { outcome?: string }).outcome ?? "none")
  }

  // ── the wire ──────────────────────────────────────────────────────────────

  private publish(from: Side, sid: string, to: Side, payload: Frame["payload"]) {
    const rtc = payload!.rtc
    const desc = rtc.desc
    const kind: Kind = desc ? (desc.type === "offer" ? "offer" : "answer") : "cand"
    const frame: Frame = { id: `f${++this.frameCount}`, from, to, sid, kind, payload }
    if (desc) {
      frame.xPc = attr(desc.sdp, "x-pc")
      frame.xRole = attr(desc.sdp, "x-role")
      frame.xAnswers = attr(desc.sdp, "x-answers")
      frame.xOffer = attr(desc.sdp, "x-offer")
    }
    // the transport mints an offer's gen; an answer carries the gen Mesh echoes
    if (kind === "offer") {
      const n = (this.genCount.get(sid) ?? 0) + 1
      this.genCount.set(sid, n)
      frame.gen = `${sid}.${n}`
    } else frame.gen = rtc.gen
    this.checkP1(frame)
    this.put(frame)
  }

  private put(frame: Frame) {
    this.store.set(`${frame.from}>${frame.to}|${frame.sid}|${frame.kind}`, frame)
    this.stepFrames.push(frameJson(frame))
  }

  /** P1: a frame Mesh published with an echoed gen is an answer-path frame
   *  (Mesh's offers carry none); it must be an answer, to the offer whose
   *  delivery carried that gen. */
  private checkP1(frame: Frame) {
    if (!frame.payload?.rtc.desc || frame.payload.rtc.gen === undefined) return
    const where = `frame ${frame.id} from ${frame.xPc ?? frame.from}`
    if (frame.xRole !== "answer") {
      this.violations.push({ property: "P1", step: this.stepIndex, detail: `${where} went out as the answer to gen ${frame.gen} but is an ${frame.xRole ?? "?"}` })
      return
    }
    const offer = /^.+?\/\d+\/[^/]+\/(.+)$/.exec(frame.xAnswers ?? "")?.[1]
    const gen = offer ? this.deliveredOfferGen.get(offer) : undefined
    if (gen !== frame.gen) this.violations.push({ property: "P1", step: this.stepIndex, detail: `${where} answers ${offer ?? "?"} (delivered with gen ${gen ?? "none"}) but carries gen ${frame.gen}` })
  }

  private deliverable(): Frame[] {
    const out: Frame[] = []
    for (const frame of this.store.values()) if (this.passes(frame)) out.push(frame)
    for (const side of ["a", "b"] as const) for (const frame of this.inFlight[side]) if (this.passes(frame) && !out.includes(frame)) out.push(frame)
    return out.sort((x, y) => (x.from === y.from ? Number(x.id.slice(1)) - Number(y.id.slice(1)) : x.from < y.from ? -1 : 1))
  }

  private passes(frame: Frame): boolean {
    if (this.left[frame.to].has(frame.sid)) return false
    if (frame.kind === "hello") return true
    return this.knows[frame.to][frame.from] === frame.sid
  }

  // ── labels ────────────────────────────────────────────────────────────────

  private pcName(info: PcInfo) { return `${info.side}/${info.n}` }

  private sortedPcs(): [FakePC, PcInfo][] {
    return [...this.pcs].sort(([, x], [, y]) => (x.side === y.side ? x.n - y.n : x.side < y.side ? -1 : 1))
  }

  private negotiationNeeded(pc: FakePC, info: PcInfo): boolean {
    if (pc.channelCreations.length <= info.channelsHandled || !pc.onnegotiationneeded || pc.signalingState !== "stable") return false
    return ![pc.localDescription?.sdp, pc.remoteDescription?.sdp].some((body) => /^m=application/m.test(body ?? ""))
  }

  private earliestDue(): number | undefined { return this.clock.dueTimes()[0] }

  /** The enabled labels, in a fixed order. `ignoreHorizon`
   *  and `faults: false` serve the fair drain. */
  enabled({ ignoreHorizon = false, faults = true } = {}): Label[] {
    const labels: Label[] = []
    const pcs = this.sortedPcs()
    for (const [, info] of pcs) if (info.queue.length > 0) labels.push(`pc:${this.pcName(info)}:${info.queue[0].op}:resolve`)
    for (const [pc, info] of pcs) if (pc.iceGatheringState === "gathering" && pc.signalingState !== "closed") labels.push(`pc:${this.pcName(info)}:gather`)
    for (const [pc, info] of pcs) if (this.negotiationNeeded(pc, info)) labels.push(`pc:${this.pcName(info)}:negotiationneeded`)
    const deliverable = this.deliverable()
    for (const frame of deliverable) labels.push(`wire:${frame.from}>${frame.to}:${frame.id}:deliver`)
    if (this.scenario.capture) {
      for (const frame of deliverable) {
        if (frame.kind !== "hello" && !this.captured.has(frame.id) && this.storeHolds(frame)) labels.push(`wire:${frame.from}>${frame.to}:${frame.id}:capture`)
      }
    }
    const due = this.earliestDue()
    if (due !== undefined && (ignoreHorizon || due <= this.scenario.horizonMs)) labels.push("clock:next")
    if (faults && this.faultsLeft > 0 && this.sessions.b < 2) labels.push("env:reload:b")
    for (const label of labels) if (!this.firstEnabled.has(label)) this.firstEnabled.set(label, this.stepIndex)
    return labels
  }

  /** why a node with no enabled label is a leaf */
  idleCut(): Cut {
    if (this.faultsLeft === 0 && this.sessions.b < 2) return "faults"
    if (this.earliestDue() !== undefined) return "horizon"
    return "quiet"
  }

  private storeHolds(frame: Frame) {
    return this.store.get(`${frame.from}>${frame.to}|${frame.sid}|${frame.kind}`) === frame
  }

  private findFrame(id: string): Frame | undefined {
    for (const frame of this.store.values()) if (frame.id === id) return frame
    for (const side of ["a", "b"] as const) for (const frame of this.inFlight[side]) if (frame.id === id) return frame
    return undefined
  }

  private pcByName(name: string): [FakePC, PcInfo] {
    for (const entry of this.pcs) if (this.pcName(entry[1]) === name) return entry
    throw new Error(`explorer: no PC ${name}`)
  }

  /** One label's task. Nothing Mesh returns is awaited. */
  private perform(label: Label): void {
    const parts = label.split(":")
    if (parts[0] === "pc") {
      const [pc, info] = this.pcByName(parts[1])
      if (parts[2] === "gather") {
        pc.iceGatheringState = "complete"
        pc.emitCandidate(null)
        pc.onicegatheringstatechange?.()
        pc.dispatch("icegatheringstatechange")
        return
      }
      if (parts[2] === "negotiationneeded") {
        info.channelsHandled = pc.channelCreations.length
        void pc.onnegotiationneeded?.()
        return
      }
      const item = info.queue.shift()!
      try {
        item.apply()
      } catch (error) {
        item.reject(error)
        return
      }
      if (item.op === "srd" && pc.remoteDescription?.type === "offer") this.checkP1b(info, pc.remoteDescription.sdp)
      item.resolve()
      return
    }
    if (parts[0] === "wire") {
      const [from, to] = parts[1].split(">") as [Side, Side]
      const frame = this.findFrame(parts[2])!
      if (parts[3] === "capture") {
        this.captured.add(frame.id)
        this.inFlight[to].push(frame)
        return
      }
      // deliver: a frame is handed to onRtc once, from the receiver's
      // in-flight queue or from the store (a second copy is the dup fault, not modelled here)
      const queued = this.inFlight[to].indexOf(frame)
      if (queued >= 0) this.inFlight[to].splice(queued, 1)
      if (this.storeHolds(frame)) this.store.delete(`${frame.from}>${frame.to}|${frame.sid}|${frame.kind}`)
      if (frame.kind === "hello") {
        const previous = this.knows[to][from]
        this.left[to].add(previous)
        this.knows[to][from] = frame.sid
        // the receiver's transport drops every frame of the session it left
        for (const [key, held] of this.store) if (held.to === to && held.sid === previous) this.store.delete(key)
        this.inFlight[to] = this.inFlight[to].filter((held) => held.sid !== previous)
        this.mesh[to].onPeerSession(from)
        return
      }
      const rtc = { ...frame.payload!.rtc, ...(frame.gen !== undefined ? { gen: frame.gen } : {}) }
      if (frame.kind === "offer" && frame.xOffer && frame.gen) this.deliveredOfferGen.set(frame.xOffer, frame.gen)
      void this.mesh[to].onRtc(from, { rtc } as never)
      return
    }
    if (label === "clock:next") {
      this.clock.next()
      return
    }
    if (label === "env:reload:b") {
      this.faultsLeft--
      this.mesh.b.close()
      this.sessions.b++
      this.sid.b = `b${this.sessions.b}`
      this.inFlight.b = [] // the old page's transport is gone
      this.mesh.b = this.build("b")
      const hello: Frame = { id: `f${++this.frameCount}`, from: "b", to: "a", sid: this.sid.b, kind: "hello", payload: null }
      this.put(hello)
      return
    }
    throw new Error(`explorer: unknown label ${label}`)
  }

  /** P1b: one PC resolves offers from two different remote PCs. */
  private checkP1b(info: PcInfo, body: string | undefined) {
    const from = attr(body, "x-pc") ?? "?"
    if (!info.srdOffersFrom.includes(from)) info.srdOffersFrom.push(from)
    if (info.srdOffersFrom.length > 1) {
      this.violations.push({ property: "P1b", step: this.stepIndex, detail: `${this.pcName(info)} resolved offers from ${info.srdOffersFrom.join(" and ")}` })
    }
  }

  workCounters(): string {
    const parts: (string | number)[] = []
    for (const [pc, info] of this.sortedPcs()) parts.push(`${this.pcName(info)}:${info.queue.length}:${pc.iceGatheringState}:${pc.signalingState}:${pc.channelCreations.length - info.channelsHandled}`)
    parts.push(`t${this.clock.dueTimes().join(",")}`, `f${this.frameCount}`, `s${this.store.size}`, `i${this.inFlight.a.length},${this.inFlight.b.length}`, `o${this.outcomeCount}`)
    for (const mesh of this.meshes) {
      const internals = mesh as unknown as MeshInternals
      let work = 0
      for (const set of internals.actorWork.values()) work += set.size
      parts.push(`w${work}`, `n${internals.answering.size}`)
    }
    return parts.join("|")
  }

  /** One step: the label's task, then the drain. */
  async step(label: Label): Promise<StepRecord> {
    if (!this.enabled().includes(label)) throw new Error(`label not enabled at step ${this.stepIndex}: ${label}`)
    this.stepFrames = []
    this.stepCommands = []
    this.stepOutcomes = []
    this.perform(label)
    const turns = await drain(this)
    if (turns > MAX_TURNS) this.harness.push("watchdog")
    const record: StepRecord = {
      index: this.stepIndex, label, frames: this.stepFrames, commands: this.stepCommands, outcomes: this.stepOutcomes,
      accepted: [], clockMs: Date.now(), turns,
    }
    this.stepIndex++
    this.records.push(record)
    return record
  }

  /** The unowned-wait check: every awaited actor command in
   *  flight must settle within 50 fair steps of being watched, under a fair
   *  drain that ignores the horizon. Commands the drain itself issues are
   *  watched too, each from the step that issued it, so a wait that starts
   *  inside the check is caught as well; the drain stops at FAIR_CAP steps.
   *  A command still in flight after its 50 steps is an unowned wait; one the
   *  cap cut short is reported as such. No real timer handle may be live
   *  either. Adds harness details. */
  async checkUnowned(): Promise<void> {
    const FAIR_STEPS = 50
    const FAIR_CAP = 150
    const watched = new Map<CommandEntry, number>() // entry → the fair step it was first watched at
    const watch = (fair: number) => {
      for (const mesh of this.meshes) {
        for (const set of (mesh as unknown as MeshInternals).actorWork.values()) {
          for (const promise of set) {
            const entry = this.commandsByPromise.get(promise)
            if (entry && !entry.settled && !watched.has(entry)) watched.set(entry, fair)
          }
        }
      }
    }
    watch(0)
    const owed = (fair: number) => [...watched].some(([entry, from]) => !entry.settled && fair - from < FAIR_STEPS)
    let fair = 0
    for (; fair < FAIR_CAP && owed(fair); fair++) {
      const labels = this.enabled({ ignoreHorizon: true, faults: false })
      const others = labels.filter((label) => label !== "clock:next")
      const pool = others.length > 0 ? others : labels
      if (pool.length === 0) break
      let oldest = pool[0]
      for (const label of pool) if ((this.firstEnabled.get(label) ?? 0) < (this.firstEnabled.get(oldest) ?? 0)) oldest = label
      await this.step(oldest)
      watch(fair + 1)
    }
    const details = new Set<string>()
    for (const [entry, from] of watched) {
      if (entry.settled) continue
      if (fair - from >= FAIR_STEPS || !owed(fair)) details.add(`unowned wait: ${entry.side}>${entry.peer} ${entry.kind} (in flight after 50 fair steps)`)
      else details.add(`fair drain cap: ${entry.side}>${entry.peer} ${entry.kind} (in flight after ${fair - from} of 50 fair steps)`)
    }
    this.harness.push(...details)
    const real = liveRealTimers()
    if (real > 0) this.harness.push(`real timer: ${real}`)
  }

  /** the pending fake timers' due times, earliest first */
  dueTimes(): number[] { return this.clock.dueTimes() }

  /** Close everything, clear the control's real timer, release FakePC and the clock. */
  async dispose(): Promise<void> {
    for (const mesh of this.meshes) mesh.close()
    if (this.meshes.length > 0) await drain(this)
    if (this.controlTimer !== null) capturedClearTimeout(this.controlTimer as ReturnType<typeof setTimeout>)
    this.controlTimer = null
    this.meshes = []
    FakePC.controller = null
    vi.useRealTimers()
  }

  /** replay a label list from a fresh reset */
  async replay(labels: readonly Label[]): Promise<void> {
    await this.reset()
    for (const label of labels) await this.step(label)
  }
}
