// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The explorer's two-phone room: its slice-1 labels, the reset and the
 * reload. Two real Meshes, `a` and `b`, with the peer actor driving them,
 * over controlled PeerConnections (controlled-pc.ts) and the statement
 * transport model (transport-model.ts). Nothing moves except
 * through a label: one label's task, a watchdogged drain, the benign network,
 * a second drain.
 *
 * How the room feeds Mesh, and why (fidelity first: the room never gives Mesh
 * an order the browser and the statement transport cannot produce):
 * - **PCs.** `RTCPeerConnection` is stubbed as a ControlledPC subclass before
 *   mesh.ts is imported (its module-level `PC` is captured once). Mesh builds
 *   PCs only in `addPeer`, and calls `this.addPeer` itself (rejoin, rebuild,
 *   roster), so each Mesh INSTANCE's `addPeer` is replaced by one that runs
 *   inside `controller.building(side, …)`. A PC built any other way throws in
 *   the Controller; Mesh catches that (its PC-construct guard), so the
 *   subclass records it and the step fails as a harness cut.
 * - **The statement wire** is the transport model, unchanged. Each Mesh has its own
 *   signal closure: once that Mesh is no longer its side's live one (a reload
 *   closed it), its signals are dropped, as the old page's closed transport
 *   sends nothing. A payload is JSON-copied, as the transport serialises it.
 *   A candidate goes out under the side's current description gen, and is
 *   dropped before any description (statementTransport.ts send). Under the
 *   controller a gather emits only the null candidate, so none is sent.
 * - **Delivery** follows useMesh's handlers (useMesh.ts:515-533) and the
 *   transport's dispatch (statementTransport.ts admitSession, onFrame,
 *   dispatchDirected): a hello whose sid is new to the receiver calls
 *   `onPeerSession` first, then `addPeer` and `markSeen` (onPeerJoined); a
 *   description or candidate calls `markSeen`, then `onRtc` without awaiting
 *   it. An offer goes over with its gen, an answer and a candidate without.
 * - **Start and reload**: each side's transport session starts
 *   (its hello goes into the presence slot), then its Mesh is built and
 *   given `setRound(1)` and then the roster through `setPeers`, in useMesh's
 *   order (useMesh.ts:620, 658), so the fresh connection sees no round
 *   change. On a reload the old Mesh closes first. The old page's bye is not modelled (its
 *   JS often dies first, statementTransport.ts close).
 * - **The heartbeat** (`hb:<side>`, a non-fault label; #1525): what the
 *   transport does every HEARTBEAT_MS (statementTransport.ts heartbeat). It
 *   is offered once 8 s of fake time have passed since that side's last beat
 *   (its session start, or its last `hb`), only where the signalling is
 *   quiet (lane frames aside), and only once the peer's transport has taken
 *   a hello of the side's current session, or that session's stored hello
 *   was dropped (the beat then puts a hello back in the store, to be
 *   delivered as the first one would have been). Once heard, its hello
 *   reaches the peer as onPeerJoined does (`addPeer`, `markSeen`), and the
 *   side re-announces its last description to the peer (same gen and SDP,
 *   a new frame id) when the store no longer holds it, unless its PC reads
 *   connected and the description is older than FRESH_DESC_MS (`setLinked`,
 *   rule 6). The re-announce is logged with fate `reannounced`, so no
 *   monitor counts it as a second send.
 * - **Not modelled:** the beat's own loss (a lost beat is a later beat), the
 *   slower hello of a stable side (STABLE_HELLO_MS), PEER_TTL_MS's
 *   onPeerLeft, the candidates' re-flush (the controller sends none),
 *   SESSION_SILENT_MS, the hello of a closed session (bye), and capture of a
 *   hello. A bundle carrying a hello and a
 *   description is read a microtask apart in the real transport
 *   (statementTransport.ts:997, onStatement awaits each frame); here each is
 *   its own label and the room drains fully between them.
 * - **The setup** (both Meshes built, before the first label) is stamped
 *   step -1 in every log; the first label is step 0.
 *
 * - **A network change** (`env:network:<side>`, a fault, in every
 *   scenario's env): what useMesh's network watcher does once its 750 ms
 *   debounce fires (useMesh.ts repairNetworkRef), `Mesh.networkChanged()`,
 *   recorded as an external fact. Enabled whenever the side's Mesh has a
 *   connection to the peer; F caps it. Its `setIceServers` after the TURN
 *   refetch is not modelled (no TURN servers here), nor any ICE drop with it.
 *
 * Fault labels (pc rejects, drop, env:*) stay listed by `enabled()` once
 * F is spent, as the search (core/search.ts) expects (it counts them as `faults` cuts); taking
 * one then is refused by `step()`.
 *
 * Harness cuts surface as a thrown `HarnessError` whose message is its detail
 * (the search reads `error.message`): "label not enabled at step k: …",
 * "watchdog", "fingerprint: …", "clock: …", a PC built outside the
 * controller, and, from `checkLeaf()`, "unowned wait: …" and "real timer: n".
 */
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { vi } from "vitest"
import { decodeChannelMessage, decodePeerConnectionSignal, USE_CASE_RENEGOTIATION, type RtcPayload } from "@jollity/statement-core"
import type { Mesh as MeshType } from "../../webrtc/mesh"
import { FakeChannel, FakePC } from "../../webrtc/test-pc"
import { missingRecoveryDeadline, type PeerActorCommand } from "../../state-machines/peer-actor"
import type { PeerRoomRunner } from "../../state-machines/peer-runner"
import { isFault, parseLabel, type Label, type Side, type StepRecord } from "../core/labels"
import { ControlledPC, Controller, type InputInjector, type OpLogEntry } from "./controlled-pc"
import { fairPick } from "./fair"
import { drain, installFakeClock, liveRealTimers, MAX_TURNS, type FakeClock } from "./quiescence"
import { CAPTURE, SCENARIOS, type Scenario } from "./scenarios"
import { createTransportModel, type TransportModel, type WireFrame } from "./transport-model"
import { monitorsFor, type Monitor } from "./monitors"
import { snapshotOf } from "./monitors/deadline"
import { findGap, KNOWN_GAPS } from "./known-gaps"

export type PropertyId = "P1" | "P1b" | "P2" | "P3" | "P6" | "P7" | "P8" | "W" | "R" | "D" | "L1"
export interface Violation {
  property: PropertyId
  atStep: number
  detail: string
  /** a difference listed in known-gaps.ts: its issue. Reported by `gaps()`, never by `violations()`. */
  issue?: number
  /** L1: the fixed point the drain ended in (times, budgets, timers); never part of the finding's identity */
  evidence?: unknown
}
export type ScenarioName = "rejoin-two-offers" | "single-offer" | "outage"
export interface ExploreRoomOptions {
  scenario: ScenarioName
  phaseOffsetMs: 0 | 1000 | 2000
  faults?: number
  horizonMs?: number
  /** run the unowned-wait check at every leaf `checkLeaf()` is called for, not only at quiet ones */
  checkUnowned?: boolean
  /** which monitors run at each step (monitors/index.ts): 1 = slice 1's, 2 = both slices' (default 1) */
  slice?: 1 | 2
  /** false: no known gaps, every difference is a violation. The mutant self-test
   *  and a mutant witness's replay judge without them, so a gap that shares a
   *  mutant's wording (as #1499's once had M1385's P1b) never blinds the explorer. */
  knownGaps?: boolean
  /** replaces the slice's monitors (tests) */
  monitors?: readonly Monitor[]
  /** an ad-hoc scenario (scenarios.ts scenarioFrom) run in place of
   *  SCENARIOS[scenario]; `scenario` still names the base it was built from */
  custom?: Scenario
  /** false: no `hb:<side>` label, as before #1525 (default true) */
  heartbeat?: boolean
  /** the sides whose offers carry video RTX (Controller.rtxOffers; default none) */
  rtxOffers?: readonly Side[]
  /** the frozen page clock (`page()`; room/frozen-clock-mesh.test.ts): each side reads its own performance.now and page visibility (default off) */
  pageClock?: boolean
}

/** One side's page under `pageClock`: page-away.ts's hiddenAt, and the frozen page's clock. */
interface PageState {
  /** performance.now() on this side's clock when the page went to the background (page-away.ts 24); null: shown */
  hiddenAt: number | null
  /** the fake clock's now when the page froze; null: running */
  frozenAt: number | null
  /** the ms this side's clock missed, frozen */
  lag: number
}

/** a frozen side's timers are moved this far out (past any horizon), then back by the frozen time at the thaw */
const FROZEN_FAR_MS = 1e12

/** L1's verdict at one state (`checkLiveness`) */
export interface LivenessResult {
  steady: boolean
  /** fake ms from the check's start to steady, or to where the drain gave up */
  ms: number
  /** labels the drain took */
  steps: number
  violation?: Violation
}

/** A harness cut: the schedule proves nothing. The message is the detail. */
export class HarnessError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "HarnessError"
  }
}

// ── the logs ─────────────────────────────────────────────────────────────────

/** Every signal() call and every lane send, with the identity ControlledPC wrote. */
export interface WireLogEntry {
  step: number
  channel: "statement" | "lane"
  from: Side
  to: Side
  /** statement: `published` went to the model and into its store (on the
   *  wire), `skipped` went to the model, which kept it out of the store as a
   *  stale answer (statementTransport.ts send; model.stored), `refused` threw
   *  (env:signal-throws), `closed` came from a Mesh a reload closed, `no-gen`
   *  was a candidate before any description, `reannounced` is the heartbeat
   *  putting a dropped description back (same gen and SDP, a new id). lane: `sent`. */
  fate: "published" | "skipped" | "refused" | "closed" | "no-gen" | "sent" | "reannounced"
  kind: "offer" | "answer" | "cand" | "hello" | "other"
  /** the model's frame id (statement, published or skipped) */
  id?: string
  sid?: string
  gen?: string
  /** statement: the gen Mesh put on the payload itself. Only its answer path
   *  echoes one (sendStatementAnswer), whatever the description's type; the
   *  model mints `gen` anew for anything offer-typed. */
  meshGen?: string
  /** the SDP's identity lines */
  xPc?: string
  xRole?: string
  xAnswers?: string
  xOffer?: string
  /** lane: the sending PC */
  pc?: string
  error?: string
}
/** each statement frame the room handed to a Mesh (deliver or dup), as handed */
export interface DeliveryLogEntry { step: number; frameId: string; from: Side; to: Side; kind: WireFrame["kind"]; gen?: string; xPc?: string; xOffer?: string; dup: boolean }
export interface CommandLogEntry { id: number; step: number; side: Side; peer: string; kind: string; command: unknown; pcAtIssue: string | null }
/** the effect's own outcome, whatever the reducer later makes of it */
interface OutcomeLogEntry { commandId: number; step: number; side: Side; peer: string; kind: string; shape: "sync" | "async" | "none"; outcome: string; result: unknown }
export interface AcceptedLogEntry { step: number; side: Side; kind: "accepted" | "ignored"; event?: unknown; reason?: unknown }
/** each call the harness makes into a Mesh, with the op log's view of that side's current PC */
interface ExternalFact { step: number; side: Side; peer: string; call: string; pc: string | null; localRole: "offer" | "answer" | null; threw?: string }
/** Every harness entry into one side, appended before product code runs. */
interface InputLogEntry { step: number; clockMs: number; side: Side; kind: string; value: unknown }
export interface RoomLogs {
  inputs: InputLogEntry[]
  wire: WireLogEntry[]
  deliveries: DeliveryLogEntry[]
  ops: OpLogEntry[]
  commands: CommandLogEntry[]
  outcomes: OutcomeLogEntry[]
  accepted: AcceptedLogEntry[]
  externalFacts: ExternalFact[]
}

interface MeshConn {
  pc: FakePC
  channel: FakeChannel | null
  decisionConnectionEpoch: number
  [field: string]: unknown
}
interface RoomCollisionState {
  enabled: { key: string; label: Label }[]
  workCounters: string
  findings: string[]
  gaps: string[]
}
interface RoomCollisionDrain {
  outcome: string
  workCounters: string
  findings: string[]
  gaps: string[]
}
/** Mesh's own record, read through a cast (mesh-peer-authority.test.ts:20-44). */
interface MeshInternals {
  conns: Map<string, MeshConn>
  runner: PeerRoomRunner | null
  answererMayOffer: Set<string>
  actorWork: Map<string, Set<Promise<unknown>>>
  answering: Map<string, unknown>
  addPeer(peerId: string, initiate?: boolean, replacedExternally?: boolean): void
  executePeerCommand(peerId: string, command: PeerActorCommand): unknown
}

export interface Room {
  enabled(): Label[]
  step(label: Label): Promise<StepRecord>
  replay(labels: readonly Label[]): Promise<StepRecord[]>
  logs(): RoomLogs
  /** Canonical SHA-256 of the complete explorer state. */
  fingerprint(): string
  collisionState(): RoomCollisionState
  collisionDrain(): Promise<RoomCollisionDrain>
  internals(side: Side): MeshInternals
  workCounters(): string
  violations(property?: PropertyId): Violation[]
  /** differences a monitor matched to a known-gaps.ts entry (with its issue) */
  gaps(property?: PropertyId): Violation[]
  faultsLeft(): number
  horizonReached(): boolean
  /** `pageClock` only: one side's page goes to the background (hide), is
   *  suspended with its clock stopped (freeze), or comes back (show), as
   *  page-away.ts drives Mesh: setSelfAway(true), then setSelfAway(false,
   *  performance.now() - hiddenAt). Frozen, the side's timers do not run and
   *  its performance.now() stands still; thawed, both resume where they
   *  stopped. Returns hiddenForMs on a show. The caller keeps every label
   *  of a frozen side (its pc ops, frames to it, its beat) out of the schedule. */
  page(side: Side, action: "hide" | "freeze" | "show"): number | undefined
  /** L1, eventually steady: from here, a fair drain of the clock and the
   *  heartbeat (no faults, H ignored) must reach a steady link with nothing
   *  but the clock, beats and faults left, within `withinMs` (default
   *  LIVENESS_MS) of fake time. A miss is an L1 violation (or a known gap)
   *  at the last step taken before the check. It steps the room on: call it last. */
  checkLiveness(withinMs?: number): Promise<LivenessResult>
  /** End-of-schedule checks; throws a HarnessError. The unowned-wait check
   *  runs when `checkUnowned` is set or the room is quiet; it
   *  steps the room (a fair drain), so call it last. Then the real-timer trap. */
  checkLeaf(): Promise<void>
  reset(): Promise<void>
  close(): void
}

// ── the PC the room stubs in ─────────────────────────────────────────────────

/** construction errors Mesh's PC guard swallowed (mesh.ts addPeer) */
const pcBuildErrors: string[] = []

class RoomPC extends ControlledPC {
  constructor(config?: RTCConfiguration) {
    try {
      super(config)
    } catch (error) {
      pcBuildErrors.push(error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}

/** The PeerConnection controller (controlled-pc.ts), with lane sends reported to the room's wire log */
class RoomController extends Controller {
  onLane: ((channel: FakeChannel, data: unknown, fate: "sent" | "refused", error?: unknown) => void) | null = null
  send(channel: FakeChannel, data: unknown): void {
    try {
      super.send(channel, data)
      this.onLane?.(channel, data, "sent")
    } catch (error) {
      this.onLane?.(channel, data, "refused", error)
      throw error
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const other = (side: Side): Side => (side === "a" ? "b" : "a")
const attr = (body: string | undefined, name: string): string | undefined =>
  new RegExp(`^a=${name}:(.*)$`, "m").exec(body ?? "")?.[1]?.trim()
const clone = (value: unknown): unknown => {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const frameNumber = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0)
const identity = (sdp: string | undefined) => ({
  xPc: attr(sdp, "x-pc"),
  xRole: attr(sdp, "x-role"),
  xAnswers: attr(sdp, "x-answers"),
  xOffer: attr(sdp, "x-offer"),
})
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T

type MeshClass = typeof MeshType

const FAIR_STEPS = 50
const FAIR_CAP = 150

/** statementTransport.ts HEARTBEAT_MS: a side beats this long after its last beat */
const HEARTBEAT_MS = 8_000
/** statementTransport.ts FRESH_DESC_MS: a linked side still re-announces a description this young */
const FRESH_DESC_MS = 30_000
/** L1's bound: answerWaitMs 30 s, the stranded re-offer's 30 s more, backoffMaxMs 20 s, and a margin */
const LIVENESS_MS = 90_000
/** L1's drain stops here whatever the clock says (a harness cut: a drain that never lets time pass) */
const LIVENESS_CAP = 5_000

const bytes = (value: ArrayBuffer | ArrayBufferView): Uint8Array => value instanceof ArrayBuffer
  ? new Uint8Array(value)
  : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

/** Where a value sits in the fingerprint walk: its parent and its own path
 *  segment. The path text ("$/sides/0/mesh/…") is built only when it is read
 *  (pathOf), which is rare: a repeated object's $ref, and the room's /log/ test. */
export interface FingerprintPath {
  readonly parent: FingerprintPath | undefined
  readonly segment: string
}

export const pathOf = (at: FingerprintPath): string => {
  const segments: string[] = []
  for (let node: FingerprintPath | undefined = at; node !== undefined; node = node.parent) segments.push(node.segment)
  return segments.reverse().join("/")
}

export interface FingerprintWalkHooks {
  /** a replacement value, written as JSON as it is (not walked further), or undefined to walk the value */
  transform?(value: unknown, key: string | undefined, at: FingerprintPath): { value: unknown } | undefined
  orderKey?(value: unknown): string
}

/** the keys Object.fromEntries would put first, in numeric order: array indices */
const isArrayIndex = (key: string): boolean => {
  const first = key.charCodeAt(0)
  return first >= 48 && first <= 57 && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295
}

/**
 * The one fingerprint walk used by both the room and its field-coverage
 * contract: the canonical JSON text of the state. It writes the text as it
 * walks; it is byte-identical to building the canonical value (sorted keys,
 * `$bigint`, `$undefined`, `$promise`, `$bytes`, `$date`, `$ref` to the first
 * visit's path, `$map`, `$set`, functions and symbols dropped) and then
 * JSON.stringify-ing it, which is what it replaced (fingerprint-reference.ts,
 * checked by fingerprint-stream.test.ts), so saved fingerprints still match.
 */
export function canonicalFingerprintValue(root: unknown, hooks: FingerprintWalkHooks = {}): string {
  const seen = new WeakMap<object, FingerprintPath>()
  const transform = hooks.transform
  const orderKey = hooks.orderKey
  let out = ""
  /** Write `prefix` and the value, unless the value walks to nothing (a
   *  function or symbol), and say whether it wrote. `inArray`: a replacement
   *  JSON cannot hold is null there, as JSON.stringify writes it. */
  const write = (value: unknown, parent: FingerprintPath | undefined, segment: string, key: string | undefined, prefix: string, inArray: boolean): boolean => {
    const at: FingerprintPath = { parent, segment }
    if (transform !== undefined) {
      const transformed = transform(value, key, at)
      if (transformed !== undefined) {
        if (transformed.value === undefined) return false
        const text = JSON.stringify(transformed.value) as string | undefined
        if (text === undefined && !inArray) return false
        out += prefix + (text ?? "null")
        return true
      }
    }
    switch (typeof value) {
      case "string":
      case "number":
        out += prefix + JSON.stringify(value)
        return true
      case "boolean":
        out += prefix + (value ? "true" : "false")
        return true
      case "bigint":
        out += `${prefix}{"$bigint":${JSON.stringify(value.toString())}}`
        return true
      case "undefined":
        out += `${prefix}{"$undefined":true}`
        return true
      case "function":
      case "symbol":
        return false
    }
    if (value === null) {
      out += `${prefix}null`
      return true
    }
    if (value instanceof Promise) {
      out += `${prefix}{"$promise":true}`
      return true
    }
    if (value instanceof ArrayBuffer || (ArrayBuffer.isView(value) && !(value instanceof DataView))) {
      out += `${prefix}{"$bytes":"${createHash("sha256").update(bytes(value)).digest("hex")}"}`
      return true
    }
    if (value instanceof DataView) throw new HarnessError("fingerprint: exotic object: DataView")
    if (value instanceof Date) {
      out += `${prefix}{"$date":${JSON.stringify(value.getTime())}}`
      return true
    }
    const object = value as object
    const prior = seen.get(object)
    if (prior !== undefined) {
      out += `${prefix}{"$ref":${JSON.stringify(pathOf(prior))}}`
      return true
    }
    seen.set(object, at)
    if (Array.isArray(value)) {
      out += `${prefix}[`
      let first = true
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) continue // a hole: flatMap skips it
        if (write(value[index], at, String(index), undefined, first ? "" : ",", true)) first = false
      }
      out += "]"
      return true
    }
    if (value instanceof Map) {
      const entries = orderKey === undefined
        ? [...value]
        : [...value].sort(([left], [right]) => orderKey(left).localeCompare(orderKey(right)))
      out += `${prefix}{"$map":[`
      for (let index = 0; index < entries.length; index++) {
        const [mapKey, item] = entries[index]!
        out += index === 0 ? "[" : ",["
        if (!write(mapKey, at, `k${index}`, undefined, "", true)) out += "null"
        if (!write(item, at, `v${index}`, undefined, ",", true)) out += ",null"
        out += "]"
      }
      out += "]}"
      return true
    }
    if (value instanceof Set) {
      const values = orderKey === undefined
        ? [...value]
        : [...value].sort((left, right) => orderKey(left).localeCompare(orderKey(right)))
      out += `${prefix}{"$set":[`
      let first = true
      for (let index = 0; index < values.length; index++) {
        if (write(values[index], at, String(index), undefined, first ? "" : ",", true)) first = false
      }
      out += "]}"
      return true
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const constructor = (value as { constructor?: { name?: string } }).constructor
    if (constructor !== Object && keys.length === 0) throw new HarnessError(`fingerprint: exotic object: ${constructor?.name ?? "unknown"}`)
    if (!keys.some(isArrayIndex)) {
      out += `${prefix}{`
      let first = true
      for (const objectKey of keys) {
        if (write(record[objectKey], at, objectKey, objectKey, `${first ? "" : ","}${JSON.stringify(objectKey)}:`, false)) first = false
      }
      out += "}"
      return true
    }
    // Object.fromEntries put array-index keys first, in numeric order; the
    // walk (and so every $ref path) still goes in sorted key order
    const written: [string, string][] = []
    for (const objectKey of keys) {
      const before = out
      out = ""
      const wrote = write(record[objectKey], at, objectKey, objectKey, "", false)
      const text = out
      out = before
      if (wrote) written.push([objectKey, text])
    }
    const ordered = [
      ...written.filter(([objectKey]) => isArrayIndex(objectKey)).sort(([left], [right]) => Number(left) - Number(right)),
      ...written.filter(([objectKey]) => !isArrayIndex(objectKey)),
    ]
    out += `${prefix}{${ordered.map(([objectKey, text]) => `${JSON.stringify(objectKey)}:${text}`).join(",")}}`
    return true
  }
  if (!write(root, undefined, "$", undefined, "", false)) return undefined as unknown as string
  return out
}

export function canonicalizeFrameIds(value: string, aliases: ReadonlyMap<string, string>): string {
  return value.replace(/(?<![A-Za-z0-9_-])wire-\d+(?![A-Za-z0-9_-])/g, (raw) => aliases.get(raw) ?? raw)
}

class MeshRoom implements Room {
  private readonly scenario: Scenario
  private readonly faults: number
  private readonly horizonMs: number
  private readonly inputOwner = new AsyncLocalStorage<Side>()
  private readonly controller = new RoomController(((side, kind, value, run) => this.inject(side, kind, value, run)) as InputInjector)
  private clock!: FakeClock
  private clockInstalled = false
  private model!: TransportModel
  private schedule = 0
  private meshes: MeshType[] = []
  private meshHistory: Array<{ side: Side; session: number; mesh: MeshType }> = []
  private mesh = {} as Record<Side, MeshType>
  private sessions: Record<Side, number> = { a: 1, b: 1 }
  /** the gen of each side's last description, for its candidates */
  private outGen: Record<Side, string | undefined> = { a: undefined, b: undefined }
  private signalThrows: Record<Side, boolean> = { a: false, b: false }
  private signalThrowsUsed: Record<Side, boolean> = { a: false, b: false }
  /** env:ice spent, once per side (the outage scenario) */
  private iceUsed: Record<Side, boolean> = { a: false, b: false }
  /** the fake time of each side's last heartbeat: its session's start, or its last `hb` */
  private beatAt: Record<Side, number> = { a: 0, b: 0 }
  /** the fake time each side last stored a description (FRESH_DESC_MS) */
  private descAt: Record<Side, number | null> = { a: null, b: null }
  /** the last fault taken and when (L1's evidence) */
  private lastFault: { label: Label; atMs: number; step: number } | null = null
  private captured = new Set<string>()
  private duplicated = new Set<string>()
  private faultBudget = 0
  private stepIndex = 0
  private log: RoomLogs = { inputs: [], wire: [], deliveries: [], ops: [], commands: [], outcomes: [], accepted: [], externalFacts: [] }
  private stepBuffer = { frames: [] as unknown[], commands: [] as unknown[], outcomes: [] as unknown[], accepted: [] as unknown[] }
  private commandCount = 0
  private commandsByPromise = new Map<Promise<unknown>, { side: Side; peer: string; kind: string; settled: boolean }>()
  private found: Violation[] = []
  private foundGaps: Violation[] = []
  private readonly monitors: readonly Monitor[]
  private readonly heartbeat: boolean
  private pages: Record<Side, PageState> = { a: { hiddenAt: null, frozenAt: null, lag: 0 }, b: { hiddenAt: null, frozenAt: null, lag: 0 } }
  private readonly baseFingerprint: { legacySinks: number; logEntries: number; resumeProbe: boolean }

  constructor(
    private readonly Mesh: MeshClass,
    private readonly logEntries: () => number,
    private readonly resume: { take(peer: string): unknown; reset(): void },
    private readonly options: ExploreRoomOptions,
  ) {
    this.scenario = options.custom ?? SCENARIOS[options.scenario]
    this.faults = options.faults ?? this.scenario.defaults.faults
    this.horizonMs = options.horizonMs ?? this.scenario.defaults.horizonMs
    this.monitors = options.monitors ?? monitorsFor(options.slice ?? 1, options.knownGaps === false ? [] : undefined)
    this.heartbeat = options.heartbeat !== false
    this.baseFingerprint = this.leakFingerprint(false)
    this.controller.onLane = (channel, data, fate, error) => this.laneSent(channel, data, fate, error)
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async reset(): Promise<void> {
    this.closeMeshes()
    if (this.meshes.length > 0) await drain(this)
    this.schedule++
    this.controller.reset()
    this.controller.rtxOffers = new Set(this.options.rtxOffers ?? [])
    FakePC.controller = this.controller
    FakePC.last = []
    pcBuildErrors.length = 0
    this.model = createTransportModel()
    this.meshes = []
    this.meshHistory = []
    this.mesh = {} as Record<Side, MeshType>
    this.sessions = { a: 1, b: 1 }
    this.outGen = { a: undefined, b: undefined }
    this.signalThrows = { a: false, b: false }
    this.signalThrowsUsed = { a: false, b: false }
    this.iceUsed = { a: false, b: false }
    this.beatAt = { a: 0, b: 0 }
    this.descAt = { a: null, b: null }
    this.lastFault = null
    this.captured.clear()
    this.duplicated.clear()
    this.faultBudget = this.faults
    this.stepIndex = 0
    this.log = { inputs: [], wire: [], deliveries: [], ops: [], commands: [], outcomes: [], accepted: [], externalFacts: [] }
    this.commandCount = 0
    this.commandsByPromise.clear()
    this.found = []
    this.foundGaps = []
    this.stepBuffer = { frames: [], commands: [], outcomes: [], accepted: [] }
    // read before the clock is reinstalled: a claimed probe's timer goes with the old clock
    const now = this.leakFingerprint(this.clockInstalled)
    const base = this.baseFingerprint
    const changed = now.legacySinks !== base.legacySinks || now.logEntries < base.logEntries || now.resumeProbe !== base.resumeProbe
      ? `fingerprint: legacy sinks ${base.legacySinks} -> ${now.legacySinks}, log entries ${base.logEntries} -> ${now.logEntries}, resume probe ${base.resumeProbe} -> ${now.resumeProbe}`
      : null
    this.resume.reset()
    this.clock = installFakeClock({
      owner: () => this.inputOwner.getStore() ?? null,
      fire: (timer, run) => {
        if (timer.owner === null) run()
        else this.inject(timer.owner, "timer:fire", {
          identity: timer.identity,
          due: timer.due,
          rank: timer.rank,
          periodMs: timer.periodMs,
          isInterval: timer.isInterval,
        }, run)
      },
    })
    this.clockInstalled = true
    if (this.options.pageClock) this.installPageClock()
    // an ICE timeout is a deadline the clock must be able to reach: a timer that does nothing
    this.controller.wake = (delayMs) => void setTimeout(() => {}, delayMs)
    if (Date.now() !== 0 || performance.now() !== 0) throw new HarnessError(`clock: reinstalled at ${Date.now()}/${performance.now()}`)
    this.stepIndex = -1 // the setup's facts, frames and ops are step -1
    this.controller.step = -1
    this.build("a")
    const offset = this.options.phaseOffsetMs
    const due = this.clock.dueTimes()[0]
    // b starts out of phase; advancing must not fire a timer (one timer per label)
    if (due !== undefined && due <= offset) throw new HarnessError(`clock: a timer is due at ${due}, within b's phase offset ${offset}`)
    vi.advanceTimersByTime(offset)
    this.build("b")
    await this.scenario.setup(this)
    const turns = await drain(this)
    if (turns > MAX_TURNS) throw new HarnessError("watchdog")
    this.throwBuildErrors()
    // the setup's quiescent point is checked too (a violation there has atStep -1)
    this.runMonitors({ index: -1, label: "(setup)", ...this.stepBuffer, clockMs: Date.now(), turns })
    this.stepIndex = 0
    // the room is whole again; the schedule it would start is still cut
    if (changed) throw new HarnessError(changed)
  }

  /** `pageClock`: performance.now() and document.visibilityState as the side whose code runs reads them (the input owner: a call, a timer, a continuation). */
  private installPageClock() {
    this.pages = { a: { hiddenAt: null, frozenAt: null, lag: 0 }, b: { hiddenAt: null, frozenAt: null, lag: 0 } }
    const fake = globalThis.performance
    const raw = fake.now.bind(fake)
    const local = (side: Side | undefined) => {
      if (!side) return raw()
      const page = this.pages[side]
      return (page.frozenAt ?? raw()) - page.lag
    }
    Object.defineProperty(fake, "now", { configurable: true, writable: true, value: () => local(this.inputOwner.getStore()) })
    // pageHidden() (page-lifecycle.ts 9-11): supervise() does nothing on a hidden page (mesh.ts 2796)
    const pages = this.pages
    const owner = () => this.inputOwner.getStore()
    vi.stubGlobal("document", {
      get visibilityState() {
        const side = owner()
        return side && pages[side].hiddenAt !== null ? "hidden" : "visible"
      },
      addEventListener() {},
      removeEventListener() {},
    })
  }

  page(side: Side, action: "hide" | "freeze" | "show"): number | undefined {
    if (!this.options.pageClock) throw new HarnessError("page: exploreRoom({ pageClock: true }) only")
    const page = this.pages[side]
    const mesh = this.mesh[side] as unknown as { setSelfAway(away: boolean, hiddenForMs?: number): void }
    if (action === "hide") {
      if (page.hiddenAt !== null) throw new HarnessError(`page: ${side} is already hidden`)
      // page-away.ts 24-26: hiddenAt ??= performance.now(), then setSelfAway(true)
      this.inject(side, "page:hide", {}, () => {
        page.hiddenAt = performance.now()
        mesh.setSelfAway(true)
      })
      return undefined
    }
    if (action === "freeze") {
      if (page.hiddenAt === null || page.frozenAt !== null) throw new HarnessError(`page: ${side} must be hidden and running to freeze`)
      page.frozenAt = Date.now()
      this.clock.shift(side, FROZEN_FAR_MS)
      return undefined
    }
    if (page.hiddenAt === null) throw new HarnessError(`page: ${side} is not hidden`)
    if (page.frozenAt !== null) {
      const frozenFor = Date.now() - page.frozenAt
      page.lag += frozenFor
      page.frozenAt = null
      this.clock.shift(side, frozenFor - FROZEN_FAR_MS)
    }
    // page-away.ts 28-30: hiddenForMs = performance.now() - hiddenAt, then setSelfAway(false, hiddenForMs)
    return this.inject(side, "page:show", {}, () => {
      const hiddenForMs = performance.now() - page.hiddenAt!
      page.hiddenAt = null
      mesh.setSelfAway(false, hiddenForMs)
      return hiddenForMs
    })
  }

  close(): void {
    this.closeMeshes()
    this.schedule++
    this.meshes = []
    if (FakePC.controller === this.controller) FakePC.controller = null
    vi.useRealTimers()
  }

  private closeMeshes() {
    for (const mesh of this.meshes) {
      try {
        mesh.close()
      } catch {
        /* a Mesh that fails to close is still gone with the schedule */
      }
    }
  }

  /** Module state a schedule may not change. resume-reload's
   *  pending return probe is private: it is read by claiming it (which also
   *  clears it), only once a fake clock exists to hold a claimed probe's timer. */
  private leakFingerprint(readResumeProbe: boolean) {
    const registry = (globalThis as { __jollityLegacyDecisionCaptureRegistry?: { sinks: Set<unknown> } }).__jollityLegacyDecisionCaptureRegistry
    const resumeProbe = readResumeProbe && this.resume.take("explorer-fingerprint") !== null
    return { legacySinks: registry?.sinks.size ?? 0, logEntries: this.logEntries(), resumeProbe }
  }

  fingerprint(): string {
    return this.fingerprintWith(canonicalFingerprintValue)
  }

  /** The fingerprint through a given canonical walk: the tests compare the
   *  walk with the reference one it replaced (fingerprint-stream.test.ts). */
  fingerprintWith(canonical: (root: unknown, hooks: FingerprintWalkHooks) => string): string {
    const frameIds = this.frameAliases()
    const commandIds = new Map<number, string>()
    const perSide: Record<Side, number> = { a: 0, b: 0 }
    for (const entry of this.log.commands) commandIds.set(entry.id, `${entry.side}#${++perSide[entry.side]}`)
    const timers = this.clock.timers()
    const timerHandles = new Map(timers.map(({ handle, rank }) => [handle, rank]))

    const hooks: FingerprintWalkHooks = {
      orderKey: (value: unknown): string => {
        if (value instanceof FakePC) return `pc:${this.controller.pcId(value)}`
        if (value instanceof FakeChannel) return `channel:${this.controller.channelId(value)}`
        if (value === null || typeof value !== "object") return `${typeof value}:${String(value)}`
        try {
          return `${value.constructor?.name ?? "object"}:${JSON.stringify(value, (_key, item) => typeof item === "function" ? undefined : item)}`
        } catch {
          return `${value.constructor?.name ?? "object"}:${Object.keys(value).sort().join(",")}`
        }
      },
      transform: (value: unknown, key: string | undefined, at: FingerprintPath): { value: unknown } | undefined => {
        if (typeof value === "string" && frameIds.has(value)) return { value: frameIds.get(value) }
        if (typeof value === "number") {
          if ((key === "id" || key === "commandId") && commandIds.has(value) && pathOf(at).includes("/log/")) return { value: commandIds.get(value) }
          const rank = timerHandles.get(value)
          if (rank !== undefined) return { value: { $timer: rank } }
        }
        if (value instanceof FakePC) return { value: { $pc: this.controller.pcId(value) } }
        if (value instanceof FakeChannel) return { value: { $channel: this.controller.channelId(value) } }
        // These four private Mesh caches are deliberately opaque: their
        // contents are derived from the per-side input history. Keep the
        // whitelist exact so any new unwalkable field is a harness cut.
        if (value instanceof WeakMap && ["senderWrites", "statsLinks", "sdpMemo"].includes(key ?? "")) return { value: { $opaque: key } }
        if (value instanceof WeakSet && key === "closedByActor") return { value: { $opaque: key } }
        return undefined
      },
    }
    const projectLogs = (side: Side) => {
      const typed = [
        ...this.log.inputs.filter((entry) => entry.side === side).map((entry) => ({ type: "input", entry })),
        ...this.log.wire.filter((entry) => entry.from === side).map((entry) => ({ type: "wire", entry })),
        ...this.log.deliveries.filter((entry) => entry.to === side).map((entry) => ({ type: "delivery", entry })),
        ...this.controller.opLog().filter((entry) => entry.pc.startsWith(`${side}/`)).map((entry) => ({ type: "op", entry })),
        ...this.log.commands.filter((entry) => entry.side === side).map((entry) => ({ type: "command", entry })),
        ...this.log.outcomes.filter((entry) => entry.side === side).map((entry) => ({ type: "outcome", entry })),
        ...this.log.accepted.filter((entry) => entry.side === side).map((entry) => ({ type: "accepted", entry })),
        ...this.log.externalFacts.filter((entry) => entry.side === side).map((entry) => ({ type: "external", entry })),
      ]
      const steps = [...new Set(typed.map(({ entry }) => entry.step))].sort((left, right) => left - right)
      return steps.map((step) => typed.filter(({ entry }) => entry.step === step).map(({ type, entry }) => ({
        type,
        ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "step")),
      })))
    }
    const controllerState = this.controller.fingerprintState() as {
      pcs: { id: string }[]
      lanes: { direction: string; source: string; target: string; data: unknown }[]
      connected: unknown
      drops: unknown[]
      stats: unknown
    }
    const sides = (["a", "b"] as const).map((side) => {
      const mesh = this.mesh[side]
      const internals = mesh as unknown as MeshInternals
      return {
        side,
        actor: internals.runner?.state(other(side)),
        mesh,
        controller: controllerState.pcs.filter(({ id }) => id.startsWith(`${side}/`)),
        log: projectLogs(side),
      }
    })
    const state = {
      global: {
        now: Date.now(),
        faultsLeft: this.faultBudget,
        sessions: this.sessions,
        signalThrows: this.signalThrows,
        signalThrowsUsed: this.signalThrowsUsed,
        // only once spent, so a scenario without env:ice keeps its fingerprints
        ...(this.iceUsed.a || this.iceUsed.b ? { iceUsed: this.iceUsed } : {}),
        // what the heartbeat reads: when each side may beat, and its re-announce's freshness
        ...(this.heartbeat ? { beatAt: this.beatAt, descAt: this.descAt } : {}),
      },
      timers: timers.map(({ due, rank, isInterval, periodMs, owner }) => ({ due, rank, isInterval, periodMs, owner })),
      sides,
      meshes: this.meshHistory,
      transport: {
        model: this.model.fingerprintState(),
        outGen: this.outGen,
        captureKeys: [...this.captured].map((key) => {
          const split = key.indexOf("|")
          const id = key.slice(split + 1)
          return `${key.slice(0, split + 1)}${frameIds.get(id) ?? id}`
        }),
        duplicated: this.duplicated,
        connected: controllerState.connected,
        ...(controllerState.drops.length > 0 ? { drops: controllerState.drops } : {}),
        pendingStats: controllerState.stats,
      },
      lanes: controllerState.lanes.map(({ data, ...lane }) => ({
        ...lane,
        data: createHash("sha256").update(canonical(data, hooks)).digest("hex"),
      })),
    }
    return createHash("sha256").update(canonical(state, hooks)).digest("hex")
  }

  private frameAliases(): Map<string, string> {
    const aliases = new Map<string, string>()
    const perSender: Record<Side, number> = { a: 0, b: 0 }
    for (const entry of this.log.wire) {
      if (entry.id && !aliases.has(entry.id)) aliases.set(entry.id, `${entry.from}#${++perSender[entry.from]}`)
    }
    return aliases
  }

  private collisionText(value: string): string {
    return canonicalizeFrameIds(value, this.frameAliases())
  }

  collisionState(): RoomCollisionState {
    const enabled = this.horizonReached()
      ? []
      : this.enabled().filter((label) => this.faultBudget > 0 || !isFault(label))
    const findings = (values: Violation[]) => values.map((value) =>
      this.collisionText(`${value.property}|${value.issue ?? ""}|${value.detail}`),
    ).sort()
    return {
      enabled: enabled.map((label) => ({ key: this.collisionText(label), label })),
      workCounters: this.collisionText(this.workCounters()),
      findings: findings(this.found),
      gaps: findings(this.foundGaps),
    }
  }

  async collisionDrain(): Promise<RoomCollisionDrain> {
    let outcome = "clean"
    try {
      await this.checkLeaf()
    } catch (error) {
      outcome = message(error)
    }
    const state = this.collisionState()
    return {
      outcome: this.collisionText(outcome),
      workCounters: state.workCounters,
      findings: state.findings,
      gaps: state.gaps,
    }
  }

  private sid(side: Side) {
    return `${Date.now()}-${side}${this.sessions[side]}`
  }

  /** a new Mesh for `side`, its transport session started, wired to the room */
  private build(side: Side): MeshType {
    const schedule = this.schedule
    const sid = this.sid(side)
    this.model.hello(side, sid)
    // the transport's first beat is its open (statementTransport.ts heartbeat)
    this.beatAt[side] = Date.now()
    this.descAt[side] = null
    const hello = this.model.deliverable().find((frame) => frame.kind === "hello" && frame.from === side && frame.sid === sid)
    this.pushWire({ step: this.stepIndex, channel: "statement", from: side, to: other(side), fate: "published", kind: "hello", id: hello?.id, sid })
    const track = { kind: "video", id: `${side}-camera`, readyState: "live", enabled: true, getSettings: () => ({ width: 720, height: 1280 }), addEventListener() {}, removeEventListener() {} }
    const local = { id: `${side}-local`, getVideoTracks: () => [track], getTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream
    let instance: MeshType | null = null
    const mesh = this.inject(side, "mesh:construct", { sid }, () => new this.Mesh(
      side, local, {},
      (to, data) => {
        if (schedule === this.schedule) this.signal(instance, side, to as Side, data)
      },
      () => {}, () => {}, () => {},
      { members: [other(side), side], decisionRoom: "g42", decisionRoomEpoch: 1 },
    ))
    instance = mesh
    const internals = mesh as unknown as MeshInternals
    // every PC Mesh builds, its own addPeer calls included, learns its side
    const addPeer = internals.addPeer.bind(mesh)
    internals.addPeer = (peerId, initiate, replacedExternally) => this.controller.building(side, () => addPeer(peerId, initiate, replacedExternally))
    const execute = internals.executePeerCommand.bind(mesh)
    internals.executePeerCommand = (peerId, command) => {
      if (schedule !== this.schedule) return execute(peerId, command)
      return this.executed(side, internals, peerId, command, () => execute(peerId, command))
    }
    const summary = (mesh as unknown as { actorSummary: { accepted(event: unknown): void; ignored(reason: unknown): void } | null }).actorSummary
    if (summary) {
      const accepted = summary.accepted.bind(summary)
      const ignored = summary.ignored.bind(summary)
      summary.accepted = (event) => {
        if (schedule === this.schedule) this.pushAccepted({ step: this.stepIndex, side, kind: "accepted", event: clone(event) })
        accepted(event)
      }
      summary.ignored = (reason) => {
        if (schedule === this.schedule) this.pushAccepted({ step: this.stepIndex, side, kind: "ignored", reason: clone(reason) })
        ignored(reason)
      }
    }
    this.meshes.push(mesh)
    this.meshHistory.push({ side, session: this.sessions[side], mesh })
    this.mesh[side] = mesh
    const peer = other(side)
    // useMesh's order: setRound, then the roster (useMesh.ts:620, 658), so
    // the fresh connection sees no round change
    this.call(side, peer, "setRound", () => mesh.setRound(1))
    this.call(side, peer, "setPeers", () => mesh.setPeers([peer], []))
    if (!(internals.conns.get(peer)?.pc instanceof RoomPC)) {
      this.throwBuildErrors()
      throw new HarnessError("mesh.ts holds another RTCPeerConnection than the room's (imported before exploreRoom stubbed it?)")
    }
    return mesh
  }

  private throwBuildErrors() {
    if (pcBuildErrors.length > 0) throw new HarnessError(`pc built outside controller.building: ${pcBuildErrors[0]}`)
  }

  // ── the logs ──────────────────────────────────────────────────────────────

  private inject<T>(side: Side, kind: string, value: unknown, run: () => T): T {
    this.log.inputs.push({ step: this.stepIndex, clockMs: Date.now(), side, kind, value: clone(value) })
    return this.inputOwner.run(side, run)
  }

  private pushWire(entry: WireLogEntry) {
    const clean = defined(entry)
    this.log.wire.push(clean)
    this.stepBuffer.frames.push(clean)
  }

  private pushAccepted(entry: AcceptedLogEntry) {
    this.log.accepted.push(entry)
    this.stepBuffer.accepted.push(entry)
  }

  private pcOf(side: Side, peer: string): string | null {
    const conn = (this.mesh[side] as unknown as MeshInternals | undefined)?.conns.get(peer)
    if (!conn) return null
    try {
      return this.controller.pcId(conn.pc)
    } catch {
      return null
    }
  }

  /** the role of `pc`'s local description, from the harness's own op log */
  private localRole(pc: string | null, ops: OpLogEntry[]): "offer" | "answer" | null {
    if (!pc) return null
    for (let k = ops.length - 1; k >= 0; k--) {
      const entry = ops[k]!
      if (entry.pc !== pc || entry.outcome !== "resolved") continue
      if (entry.op === "rollback") return null
      if (entry.op === "sld") return entry.sdpRole ?? null
    }
    return null
  }

  /** a call into a Mesh, recorded as an external fact; what Mesh throws or
   *  rejects with is recorded too (the transport's handler would swallow it) */
  private call(side: Side, peer: string, name: string, run: () => unknown) {
    const pc = this.pcOf(side, peer)
    const fact: ExternalFact = { step: this.stepIndex, side, peer, call: name, pc, localRole: this.localRole(pc, this.controller.opLog()) }
    this.log.externalFacts.push(fact)
    try {
      const result = this.inject(side, `mesh:${name}`, { peer, call: name, pc, localRole: fact.localRole }, run)
      if (result && typeof (result as Promise<unknown>).then === "function") {
        ;(result as Promise<unknown>).catch((error: unknown) => { fact.threw = message(error) })
      }
    } catch (error) {
      fact.threw = message(error)
    }
  }

  private executed(side: Side, internals: MeshInternals, peer: string, command: PeerActorCommand, run: () => unknown): unknown {
    const id = ++this.commandCount
    const conn = internals.conns.get(peer)
    let pcAtIssue: string | null = null
    if (conn) {
      try {
        pcAtIssue = this.controller.pcId(conn.pc)
      } catch {
        pcAtIssue = null
      }
    }
    const entry: CommandLogEntry = { id, step: this.stepIndex, side, peer, kind: command.kind, command: clone(command), pcAtIssue }
    this.log.commands.push(entry)
    this.stepBuffer.commands.push(entry)
    const schedule = this.schedule
    const note = (shape: OutcomeLogEntry["shape"], outcome: string, result: unknown) => {
      if (schedule !== this.schedule) return
      const recorded: OutcomeLogEntry = { commandId: id, step: this.stepIndex, side, peer, kind: command.kind, shape, outcome, result: clone(result) }
      this.log.outcomes.push(recorded)
      this.stepBuffer.outcomes.push(recorded)
    }
    const effect = run()
    if (effect && typeof (effect as Promise<unknown>).then === "function") {
      const promise = effect as Promise<unknown>
      const held = { side, peer, kind: command.kind, settled: false }
      this.commandsByPromise.set(promise, held)
      promise.then(
        (value) => { held.settled = true; note("async", (value as { outcome?: string } | undefined)?.outcome ?? "resolved", value) },
        (error) => { held.settled = true; note("async", "rejected", message(error)) },
      )
    } else if (effect === undefined) note("none", "none", undefined)
    else note("sync", (effect as { outcome?: string }).outcome ?? "none", effect)
    return effect
  }

  // ── the wire ──────────────────────────────────────────────────────────────

  private signal(instance: MeshType | null, side: Side, to: Side, data: unknown) {
    const step = this.stepIndex
    const raw = (data as RtcPayload | undefined)?.rtc
    const kind: WireLogEntry["kind"] = raw?.desc ? (raw.desc.type === "offer" ? "offer" : "answer") : raw?.cand ? "cand" : "other"
    const ids = identity(raw?.desc?.sdp)
    if (instance === null || this.mesh[side] !== instance) {
      this.pushWire({ step, channel: "statement", from: side, to, fate: "closed", kind, ...ids })
      return
    }
    if (this.signalThrows[side]) {
      this.signalThrows[side] = false
      this.pushWire({ step, channel: "statement", from: side, to, fate: "refused", kind, ...ids, error: "signal refused" })
      throw new Error("signal refused")
    }
    if (!raw || kind === "other") return // the transport sends only an RTC payload
    // the transport serialises what it sends
    const payload = clone(data) as RtcPayload
    if (kind === "cand") {
      const gen = this.outGen[side]
      if (!gen) {
        this.pushWire({ step, channel: "statement", from: side, to, fate: "no-gen", kind })
        return
      }
      payload.rtc.gen = gen
    }
    const meshGen = kind === "cand" ? undefined : raw.gen
    const frame = this.model.publish(side, to, payload)
    // the transport skipped a stale answer (statementTransport.ts send): nothing went on the wire
    const fate = this.model.stored(frame.id) ? "published" : "skipped"
    if (fate === "published" && kind !== "cand" && frame.gen) this.outGen[side] = frame.gen
    if (fate === "published" && kind !== "cand") this.descAt[side] = Date.now()
    this.pushWire({ step, channel: "statement", from: side, to, fate, kind, id: frame.id, sid: frame.sid, gen: frame.gen, meshGen, ...ids })
  }

  private laneSent(channel: FakeChannel, data: unknown, fate: "sent" | "refused", error?: unknown) {
    let from: Side | null = null
    let pc: string | undefined
    for (const side of ["a", "b"] as const) {
      const mesh = this.mesh[side] as unknown as MeshInternals | undefined
      for (const conn of mesh?.conns.values() ?? []) {
        if (conn.channel === channel) {
          from = side
          try {
            pc = this.controller.pcId(conn.pc)
          } catch {
            pc = undefined
          }
        }
      }
    }
    if (!from) return
    let kind: WireLogEntry["kind"] = "other"
    let sdp: string | undefined
    try {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      const frame = decodeChannelMessage(bytes)
      if (frame.id === USE_CASE_RENEGOTIATION) {
        const signal = decodePeerConnectionSignal(frame.data)
        if (signal.tag === "Offer" || signal.tag === "Answer") {
          kind = signal.tag === "Offer" ? "offer" : "answer"
          sdp = signal.value
        } else kind = "cand"
      }
    } catch {
      kind = "other"
    }
    this.pushWire({
      step: this.stepIndex,
      channel: "lane",
      from,
      to: other(from),
      fate,
      kind,
      pc,
      ...(error === undefined ? {} : { error: message(error) }),
      ...identity(sdp),
    })
  }

  /** hand a frame the transport took to the receiving Mesh (useMesh's handlers) */
  private handOff(frame: WireFrame, newSession: boolean) {
    const { from, to } = frame
    const mesh = this.mesh[to]
    if (frame.kind === "hello") {
      if (newSession) this.call(to, from, "onPeerSession", () => mesh.onPeerSession(from))
      this.call(to, from, "addPeer", () => mesh.addPeer(from))
      this.call(to, from, "markSeen", () => mesh.markSeen(from))
      return
    }
    const rtc = frame.payload.rtc
    const handed: RtcPayload = frame.kind === "offer"
      ? { rtc: { desc: rtc.desc, gen: frame.gen } }
      : frame.kind === "answer" ? { rtc: { desc: rtc.desc } } : { rtc: { cand: rtc.cand } }
    this.call(to, from, "markSeen", () => mesh.markSeen(from))
    this.call(to, from, "onRtc", () => mesh.onRtc(from, handed))
  }

  // ── labels ────────────────────────────────────────────────────────────────

  enabled(): Label[] {
    return this.enabledWith(false)
  }

  /** the slice-1 labels, in their fixed order */
  private enabledWith(ignoreHorizon: boolean): Label[] {
    const labels: Label[] = []
    const pending = this.controller.pending()
    for (const { pc, op } of pending) labels.push(`pc:${pc}:${op}:resolve`)
    for (const { pc, op } of pending) {
      for (const [rejectOp, cls] of this.scenario.rejections) if (rejectOp === op) labels.push(`pc:${pc}:${op}:reject:${cls}`)
    }
    for (const pc of this.controller.gathering()) labels.push(`pc:${pc}:gather`)
    for (const pc of this.controller.negotiationNeeded()) labels.push(`pc:${pc}:negotiationneeded`)
    for (const pc of this.controller.iceTimedOut()) labels.push(`pc:${pc}:ice-timeout-failed`)
    const deliverable = this.model.deliverable().sort((x, y) => (x.from === y.from ? frameNumber(x.id) - frameNumber(y.id) : x.from < y.from ? -1 : 1))
    const flight = new Set([...this.model.inFlight("a"), ...this.model.inFlight("b")].map((frame) => frame.id))
    const wire = (frame: WireFrame, action: string) => `wire:${frame.from}>${frame.to}:${frame.id}:${action}`
    for (const frame of deliverable) labels.push(wire(frame, "deliver"))
    for (const frame of deliverable) labels.push(wire(frame, "drop"))
    // no `dup` label: with the persisted store a dup of a frame not
    // yet delivered is that frame's `deliver`, and a delivered frame is no
    // longer deliverable (the transport's dedupe), so a dup only spent F and
    // branched the tree. The label grammar keeps it.
    if (this.scenario.env.includes(CAPTURE)) {
      for (const frame of deliverable) {
        if (frame.kind !== "hello" && !flight.has(frame.id) && !this.captured.has(this.captureKey(frame))) labels.push(wire(frame, "capture"))
      }
    }
    for (const { from, to } of this.controller.lanes()) labels.push(`lane:${from}>${to}:deliver`)
    const due = this.clock.dueTimes()[0]
    if (due !== undefined && (ignoreHorizon || due <= this.horizonMs)) labels.push("clock:next")
    // the heartbeat only where the signalling is quiet (no op, gather,
    // negotiation or statement frame waiting), so it adds few branches. Lane
    // frames do not count: a connected pair always has some in flight, and
    // the beat is the store's, not the link's
    const signallingQuiet = pending.length === 0 && this.controller.gathering().length === 0 && this.controller.negotiationNeeded().length === 0
      && deliverable.length === 0
    const quiet = signallingQuiet && this.controller.lanes().length === 0
    if (this.heartbeat && signallingQuiet && (ignoreHorizon || Date.now() <= this.horizonMs)) {
      for (const side of ["a", "b"] as const) {
        // before the peer has heard this session, a beat matters only once its stored hello is gone
        if (Date.now() - this.beatAt[side] >= HEARTBEAT_MS && (this.model.heard(other(side), side) || this.model.helloLost(side))) labels.push(`hb:${side}`)
      }
    }
    for (const side of ["a", "b"] as const) {
      if (this.scenario.env.includes(`env:reload:${side}`) && this.sessions[side] < 2) labels.push(`env:reload:${side}`)
    }
    for (const side of ["a", "b"] as const) {
      if (this.scenario.env.includes(`env:signal-throws:${side}`) && !this.signalThrowsUsed[side]) labels.push(`env:signal-throws:${side}`)
    }
    // env:ice (the outage scenario): once per side, only while that side's
    // PC reads connected and the room is quiet, so it adds few branches
    for (const side of ["a", "b"] as const) {
      if (!quiet || this.iceUsed[side] || (this.mesh[side] as unknown as MeshInternals | undefined)?.conns.get(other(side))?.pc.connectionState !== "connected") continue
      for (const state of ["disconnected", "failed"] as const) {
        if (this.scenario.env.includes(`env:ice:${side}:${state}`)) labels.push(`env:ice:${side}:${state}`)
      }
    }
    // env:network: whenever the side's Mesh holds a connection to the peer
    // (Mesh.networkChanged walks its connections, so with none it does
    // nothing). Neither latched nor quiet-gated: F caps it, and a network
    // change on every phone lands at one instant (the room's network-all
    // run), not after the first phone's repair has settled
    for (const side of ["a", "b"] as const) {
      if (this.scenario.env.includes(`env:network:${side}`) && (this.mesh[side] as unknown as MeshInternals | undefined)?.conns.has(other(side))) labels.push(`env:network:${side}`)
    }
    return labels
  }

  /** a stored frame is read once per receiving session */
  private captureKey(frame: WireFrame) {
    return `${frame.to}${this.sessions[frame.to]}|${frame.id}`
  }

  step(label: Label): Promise<StepRecord> {
    return this.stepWith(label, false)
  }

  private async stepWith(label: Label, ignoreHorizon: boolean): Promise<StepRecord> {
    if (!this.enabledWith(ignoreHorizon).includes(label)) throw new HarnessError(`label not enabled at step ${this.stepIndex}: ${label}`)
    const fault = isFault(label)
    if (fault && this.faultBudget <= 0) throw new HarnessError(`fault budget spent at step ${this.stepIndex}: ${label}`)
    this.stepBuffer = { frames: [], commands: [], outcomes: [], accepted: [] }
    this.controller.step = this.stepIndex
    if (fault) {
      this.faultBudget--
      this.lastFault = { label, atMs: Date.now(), step: this.stepIndex }
    }
    this.perform(label)
    let turns = await drain(this)
    if (turns > MAX_TURNS) throw new HarnessError("watchdog")
    this.controller.applyBenignNetwork()
    const more = await drain(this)
    if (more > MAX_TURNS) throw new HarnessError("watchdog")
    turns += more
    this.throwBuildErrors()
    const record: StepRecord = {
      index: this.stepIndex, label,
      frames: this.stepBuffer.frames, commands: this.stepBuffer.commands, outcomes: this.stepBuffer.outcomes, accepted: this.stepBuffer.accepted,
      clockMs: Date.now(), turns,
    }
    // not in checkLeaf's fair drain: its steps lie past the schedule, so a
    // witness cut at atStep would not replay (search.ts slices the labels)
    // TODO: judge the fair drain too (a property over the drain needs it),
    // reported against the leaf's last label, and call each monitor's atEnd at
    // the same point.
    if (!ignoreHorizon) this.runMonitors(record)
    this.stepIndex++
    return record
  }

  /** one label's task; nothing Mesh returns is awaited */
  private perform(label: Label): void {
    const parsed = parseLabel(label)
    switch (parsed.kind) {
      case "pc-operation": {
        const id = `${parsed.side}/${parsed.pc}`
        if (parsed.outcome === "resolve") this.controller.resolve(id, parsed.operation)
        else this.controller.reject(id, parsed.operation, parsed.error)
        return
      }
      case "pc-gather":
        this.controller.gather(`${parsed.side}/${parsed.pc}`)
        return
      case "pc-negotiationneeded":
        this.controller.fireNegotiationNeeded(`${parsed.side}/${parsed.pc}`)
        return
      case "pc-ice-timeout":
        this.controller.failIce(`${parsed.side}/${parsed.pc}`)
        return
      case "wire": {
        if (parsed.action === "drop") {
          this.model.drop(parsed.frameId)
          return
        }
        if (parsed.action === "capture") {
          const frame = this.model.deliverable().find((candidate) => candidate.id === parsed.frameId)!
          this.model.capture(parsed.frameId)
          this.captured.add(this.captureKey(frame))
          return
        }
        const dup = parsed.action === "dup"
        if (dup) this.duplicated.add(parsed.frameId)
        const { frame, newSession } = this.model.take(parsed.frameId, dup)
        if (frame.kind !== "hello") {
          const ids = identity(frame.payload.rtc.desc?.sdp)
          this.log.deliveries.push(defined({ step: this.stepIndex, frameId: frame.id, from: frame.from, to: frame.to, kind: frame.kind, gen: frame.gen, xPc: ids.xPc, xOffer: ids.xOffer, dup }))
        }
        this.handOff(frame, newSession)
        return
      }
      case "lane":
        this.controller.deliverLane(parsed.from, parsed.to)
        return
      case "clock-next":
        this.clock.next()
        return
      case "heartbeat":
        this.inject(parsed.side, "hb", {}, () => this.beat(parsed.side))
        return
      case "environment":
        if (parsed.action === "reload") return this.inject(parsed.side, "env:reload", {}, () => this.reload(parsed.side))
        if (parsed.action === "signal-throws") {
          this.inject(parsed.side, "env:signal-throws", {}, () => {
            this.signalThrows[parsed.side] = true
            this.signalThrowsUsed[parsed.side] = true
          })
          return
        }
        break
      case "environment-ice": {
        const { side, state } = parsed
        this.inject(side, "env:ice", { state }, () => {
          this.iceUsed[side] = true
          this.controller.setIceState(this.controller.pcId(this.internals(side).conns.get(other(side))!.pc), state)
        })
        return
      }
      case "environment-network": {
        // useMesh's repair once its 750 ms debounce fires (repairNetworkRef):
        // Mesh.networkChanged, each link's actor choosing an ICE restart or a
        // rebuild. Not modelled: its setIceServers after retryIceServers (the
        // room has no TURN servers) and any ICE drop (a network change breaks
        // no link by itself; env:ice is the drop)
        const { side } = parsed
        this.inject(side, "env:network", {}, () => this.call(side, other(side), "networkChanged", () => this.mesh[side].networkChanged()))
        return
      }
      default:
        break
    }
    throw new HarnessError(`label not in slice 1: ${label}`)
  }

  /** One heartbeat of `side`'s transport (statementTransport.ts heartbeat):
   *  its hello reaches the peer (useMesh's onPeerJoined: addPeer, markSeen),
   *  and its last description goes back into the store if it was dropped,
   *  unless the link reads connected and the description is older than
   *  FRESH_DESC_MS (setLinked). */
  private beat(side: Side) {
    const peer = other(side)
    const now = Date.now()
    this.beatAt[side] = now
    const receiver = this.mesh[peer]
    if (this.model.heard(peer, side)) {
      this.call(peer, side, "addPeer", () => receiver.addPeer(side))
      this.call(peer, side, "markSeen", () => receiver.markSeen(side))
    } else {
      // the session's first hello was lost: this beat's hello goes into the
      // store, and reaches the peer as any first hello does (a wire label)
      const hello = this.model.rehello(side)
      if (hello) this.pushWire({ step: this.stepIndex, channel: "statement", from: side, to: peer, fate: "reannounced", kind: "hello", id: hello.id, sid: hello.sid })
    }
    const linked = (this.mesh[side] as unknown as MeshInternals).conns.get(peer)?.pc.connectionState === "connected"
    const descAt = this.descAt[side]
    if (linked && (descAt === null || now - descAt > FRESH_DESC_MS)) return
    const frame = this.model.reannounce(side, peer)
    if (!frame) return
    this.pushWire({ step: this.stepIndex, channel: "statement", from: side, to: peer, fate: "reannounced", kind: frame.kind === "offer" ? "offer" : "answer", id: frame.id, sid: frame.sid, gen: frame.gen, ...identity(frame.payload.rtc.desc?.sdp) })
  }

  /** the reload: the old Mesh closes, a new session, a new Mesh */
  private reload(side: Side) {
    const old = this.mesh[side]
    this.call(side, other(side), "close", () => old.close())
    this.sessions[side]++
    this.outGen[side] = undefined
    this.build(side)
  }

  async replay(labels: readonly Label[]): Promise<StepRecord[]> {
    await this.reset()
    const records: StepRecord[] = []
    for (const label of labels) records.push(await this.step(label))
    return records
  }

  // ── reading the room ──────────────────────────────────────────────────────

  logs(): RoomLogs {
    return { ...this.log, ops: this.controller.opLog() }
  }

  internals(side: Side): MeshInternals {
    return this.mesh[side] as unknown as MeshInternals
  }

  violations(property?: PropertyId): Violation[] {
    return property ? this.found.filter((violation) => violation.property === property) : [...this.found]
  }

  gaps(property?: PropertyId): Violation[] {
    return property ? this.foundGaps.filter((gap) => gap.property === property) : [...this.foundGaps]
  }

  /** Every monitor at each quiescent point. A condition that
   *  persists is reported once, at the step it first appeared. */
  private runMonitors(record: StepRecord) {
    for (const monitor of this.monitors) {
      for (const violation of monitor.afterStep(this, record)) {
        const list = violation.issue === undefined ? this.found : this.foundGaps
        if (!list.some((seen) => seen.property === violation.property && seen.detail === violation.detail)) list.push(violation)
      }
    }
  }

  faultsLeft(): number {
    return this.faultBudget
  }

  /** nothing the search may take is enabled, and a timer waits beyond H */
  horizonReached(): boolean {
    const takeable = this.enabled().filter((label) => !isFault(label) || this.faultBudget > 0)
    return takeable.length === 0 && this.clock.dueTimes().length > 0
  }

  /** The drain's counters: any pending work moves one of them. */
  workCounters(): string {
    const parts: (string | number)[] = []
    parts.push(this.controller.pending().map(({ pc, op, index }) => `${pc}:${op}:${index}`).join(","))
    parts.push(`g${this.controller.gathering().join(",")}`, `n${this.controller.negotiationNeeded().join(",")}`, `s${this.controller.pendingStats().join(",")}`)
    parts.push(`l${this.controller.lanes().map(({ from, to, size }) => `${from}${to}${size}`).join(",")}`)
    parts.push(`t${this.clock.dueTimes().join(",")}`)
    parts.push(`w${this.log.wire.length}`, `d${this.model.deliverableCount()}`, `i${this.model.inFlightCount("a")},${this.model.inFlightCount("b")}`)
    parts.push(`c${this.log.commands.length}`, `o${this.log.outcomes.length}`, `x${this.log.accepted.length}`, `e${this.log.externalFacts.length}`)
    for (const mesh of this.meshes) {
      const internals = mesh as unknown as MeshInternals
      let work = 0
      for (const set of internals.actorWork.values()) work += set.size
      parts.push(`m${work}:${internals.answering.size}`)
      for (const conn of internals.conns.values()) parts.push(`${conn.pc.signalingState}:${conn.pc.connectionState}:${conn.pc.iceGatheringState}:${conn.channel?.readyState ?? "-"}`)
    }
    return parts.join("|")
  }

  // ── end of schedule ───────────────────────────────────────────────────────

  async checkLeaf(): Promise<void> {
    const quiet = this.enabled().filter((label) => !isFault(label)).length === 0
    if (this.options.checkUnowned || quiet) await this.checkUnownedWaits()
    const real = liveRealTimers()
    if (real > 0) throw new HarnessError(`real timer: ${real}`)
  }

  /** both links connected and stable with the channel open, and nothing
   *  left but the clock, beats and faults (anchors.ts steadyLink and settled) */
  private steadyNow(): boolean {
    const linked = (["a", "b"] as const).every((side) => {
      const conn = this.internals(side).conns.get(other(side))
      return conn?.pc.connectionState === "connected" && conn.pc.signalingState === "stable" && conn.channel?.readyState === "open"
    })
    return linked && this.enabledWith(true).every((label) => label === "clock:next" || label.startsWith("hb:") || isFault(label))
  }

  /** The product and the room use the same exemptions for the actor's
   * recovery-deadline invariant. */
  private missingRecoveryDeadline(): string | null {
    for (const side of ["a", "b"] as const) {
      const internals = this.internals(side)
      const peer = other(side)
      const actor = internals.runner?.state(peer)
      if (!actor) continue
      const missing = missingRecoveryDeadline(actor, Date.now(), snapshotOf(internals.conns.get(peer) as Parameters<typeof snapshotOf>[0]))
      if (missing) return `${side}'s actor for ${peer}: ${missing}`
    }
    return null
  }

  async checkLiveness(withinMs = LIVENESS_MS): Promise<LivenessResult> {
    const atStep = this.stepIndex - 1
    const start = Date.now()
    const deadline = start + withinMs
    const since = new Map<Label, number>()
    let steps = 0
    let missingDeadline = this.missingRecoveryDeadline()
    while (!missingDeadline && !this.steadyNow() && Date.now() < deadline) {
      if (steps >= LIVENESS_CAP) throw new HarnessError(`liveness drain cap: ${steps} labels in ${Date.now() - start} ms of fake time`)
      const enabled = this.enabledWith(true).filter((label) => !isFault(label))
      if (enabled.length === 0) break
      for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
      for (const label of enabled) if (!since.has(label)) since.set(label, steps)
      const label = fairPick(enabled, since)
      // the next timer lies past the bound: time would only run out
      if (label === "clock:next" && (this.clock.dueTimes()[0] ?? Number.POSITIVE_INFINITY) > deadline) break
      await this.stepWith(label, true)
      steps++
      missingDeadline = this.missingRecoveryDeadline()
    }
    const ms = Date.now() - start
    if (this.steadyNow()) return { steady: true, ms, steps }
    const detail = missingDeadline ? `recovery deadline invariant: ${missingDeadline}` : this.livenessSignature(withinMs)
    const gap = findGap("L1", detail, this.options.knownGaps === false ? [] : KNOWN_GAPS)
    const violation: Violation = { property: "L1", atStep, detail, ...(gap ? { issue: gap.issue } : {}), evidence: this.livenessEvidence(start, steps) }
    const list = gap ? this.foundGaps : this.found
    if (!list.some((seen) => seen.property === "L1" && seen.detail === detail)) list.push(violation)
    return { steady: false, ms, steps, violation }
  }

  /** L1's finding: each side's actor region and away mark, PC and channel.
   *  No times, so one stuck shape is one finding however it was reached. */
  private livenessSignature(withinMs: number): string {
    const sides = (["a", "b"] as const).map((side) => {
      const internals = this.internals(side)
      const actor = internals.runner?.state(other(side))
      const conn = internals.conns.get(other(side))
      const pc = conn ? `${conn.pc.signalingState}/${conn.pc.connectionState}` : "no connection"
      const away = actor?.away ? ` away ${String(actor.away)}` : ""
      return `${side}: ${actor ? String(actor.link) : "no actor"}${away}, pc ${pc}, channel ${conn?.channel?.readyState ?? "none"}`
    })
    return `not steady within ${withinMs / 1000} s of fair clock and heartbeat (${sides.join("; ")})`
  }

  /** the fixed point the drain ended in: what a reader needs to see why */
  private livenessEvidence(start: number, steps: number): unknown {
    const sides = Object.fromEntries((["a", "b"] as const).map((side) => {
      const internals = this.internals(side)
      const actor = internals.runner?.state(other(side))
      const conn = internals.conns.get(other(side)) as Record<string, unknown> | undefined
      const fields: Record<string, unknown> = {}
      if (conn) {
        for (const [key, value] of Object.entries(conn)) {
          if (typeof value === "number" || typeof value === "boolean" || typeof value === "string" || value === null) fields[key] = value
        }
        const pc = conn.pc as FakePC
        fields.pc = `${this.controller.pcId(pc)} ${pc.signalingState}/${pc.connectionState}`
        fields.channel = (conn.channel as FakeChannel | null)?.readyState ?? null
      }
      return [side, {
        actor: actor && clone({ link: actor.link, away: actor.away, initiator: actor.initiator, lastAttemptAt: actor.lastAttemptAt, lastSignalAt: actor.lastSignalAt, budgets: actor.budgets, openCommands: actor.openCommands }),
        conn: fields,
        beatAt: this.beatAt[side],
      }]
    }))
    return {
      startedAtMs: start,
      endedAtMs: Date.now(),
      drainSteps: steps,
      lastFault: this.lastFault,
      sides,
      timers: this.clock.timers().map(({ due, periodMs, isInterval, owner }) => ({ due, periodMs, isInterval, owner })),
      enabled: this.enabledWith(true),
    }
  }

  /** Every awaited actor command in flight must settle within 50 fair steps
   *  of being watched, under a fair drain that ignores H.
   *  Commands the drain itself issues are watched from the step that issued
   *  them; the drain stops at FAIR_CAP steps. */
  private async checkUnownedWaits(): Promise<void> {
    const watched = new Map<{ side: Side; peer: string; kind: string; settled: boolean }, number>()
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
    const since = new Map<Label, number>()
    let fair = 0
    for (; fair < FAIR_CAP && owed(fair); fair++) {
      const enabled = this.enabledWith(true)
      for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
      for (const label of enabled) if (!since.has(label)) since.set(label, fair)
      if (!enabled.some((label) => label === "clock:next" || !isFault(label))) break
      await this.stepWith(fairPick(enabled, since), true)
      watch(fair + 1)
    }
    for (const [entry, from] of watched) {
      if (entry.settled) continue
      if (fair - from >= FAIR_STEPS || !owed(fair)) throw new HarnessError(`unowned wait: ${entry.side}>${entry.peer} ${entry.kind} (in flight after 50 fair steps)`)
      throw new HarnessError(`fair drain cap: ${entry.side}>${entry.peer} ${entry.kind} (in flight after ${fair - from} of 50 fair steps)`)
    }
  }
}

/** Build a room and reset it to its scenario's start. mesh.ts is imported
 *  here, after the stub, so a mutant loaded before (mutants/load.ts) is the
 *  Mesh the room runs. */
export async function exploreRoom(options: ExploreRoomOptions): Promise<Room> {
  vi.stubGlobal("RTCPeerConnection", RoomPC)
  const { Mesh } = await import("../../webrtc/mesh")
  const { getDevLogEntries } = await import("../../debug/log-store")
  const { takeReturnCandidateProbe, resetResumeReloadForTests } = await import("../../resume-reload")
  const room = new MeshRoom(Mesh, () => getDevLogEntries().length, { take: takeReturnCandidateProbe, reset: resetResumeReloadForTests }, options)
  await room.reset()
  return room
}
