// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The abstract multi-phone room. N phones (3 by default); phone i holds one
 * half toward every other phone j. A half is a real `ActorWorld` (the actor
 * explorer's world, actor/world.ts) driven by the real `stepPeerActor`; the
 * room owns the clock, the fault budget and each phone's one runner FIFO.
 *
 * What is caused here and free in the single-actor world: a remote
 * description arrives only when the other phone's actor published it, a
 * peer is heard only when its hello is read, a link comes up only when both
 * current connections hold each other's current descriptions, and a reload
 * of phone k reaches a peer only through k's new session on its hello. Each
 * caused fact is still built by the actor alphabet's own entry, on the
 * receiving half: when that entry refuses a fact the transport says is real,
 * the room builds it the way Mesh does (meshStatement below) and records an
 * inclusion gap.
 *
 * Abstracted away (the README lists them too):
 * - the bundle (per-pair statement slots only), candidates, the offer
 *   counter's ordering gates (only its generation's identity is kept, below),
 *   the heartbeat (a hello is re-readable at any time instead),
 *   SESSION_SILENT_MS, store capacity;
 * - the phone labels hide/show, camera, round, roster and standby: every
 *   peer is active, every camera live, round 0;
 * - ICE beyond "up when the two current connections match": an ICE restart
 *   always works, and a network change does not break a link by itself;
 * - the channel closing on its own, and superseded lane offers (a test-only
 *   hook: offerOnLane's `current()` is true without `expected`, which only
 *   no current mesh path sets it).
 *
 * The codec guard (#559) is modelled: a phone's engine is RTX-safe or not
 * (`Phone.rtxUnsafe`, fixed at its start, ROOM_RTX_UNSAFE), and on an unsafe
 * phone a lane offer may carry RTX, which Mesh rolls back and replaces
 * (codecGuard below).
 *
 * The frozen page clock (a hidden page whose clock stands still) is
 * modelled behind ROOM_FROZEN (default off; see "the frozen page clock" below):
 * a listed phone may hide, freeze and show, and while frozen its clock stands
 * still while the others' run.
 *
 * Remote connection identity: a frame carries the sender's
 * connection as `session * 1000 + connection epoch`. Each receiving half
 * keeps `heldRemote` (the sender connection its PC accepted a remote
 * description from) and `answering` (the offer being answered, Mesh's
 * answering entry), and `left` (leftSessions). held = the frame's
 * connection differs from heldRemote ?? answering ?? the connection of the
 * answer still being set (answerSetting): Mesh's newSessionOver after #1500
 * and #1777. This is the one piece of Mesh effect code the room
 * re-implements (with meshStatement, onRtc's own steps for a description the
 * alphabet refuses).
 *
 * Generations (statementTransport.ts dispatchDirected and send): a statement
 * frame also carries the transport's generation, the `${sid}.${offers}` the
 * offering phone minted, which an answer echoes. Each half keeps the
 * transport's `out` gen toward its peer (its last offer's gen, or the gen of
 * the offer it last answered), reset by a reload and by admitting the peer's
 * new session (resetNegotiation). An answer whose gen is not `out` is read
 * and dropped by the transport before Mesh sees it: it admits the sender's
 * session and nothing else (no markSeen, no onRtc), as `if (desc.type ===
 * "answer" && f.gen !== out.get(f.from)?.gen) return` does. So newSessionOver
 * and meshStatement only ever see an answer that passed the gate.
 */
import { createPeerActorState, KICK_AFTER_HIDDEN_MS, stepPeerActor, type PeerActorCommand, type PeerActorEvent, type PeerActorState, type PeerActorStep } from "../../state-machines/peer-actor"
import { ALPHABET, type AlphabetEvent } from "../actor/alphabet"
import { applyCommand, completion } from "../actor/effects"
import { SAT } from "../actor/canon"
import { cloneWorld, freshBook, freshFacts, meshLeave, nextDeadline, quietUntil, ROOM, START_NOW, stamp, superviseHead, tickEvent, type ActorWorld, type PendingCommand, type Queued } from "../actor/world"

export const ENTRY: ReadonlyMap<string, AlphabetEvent> = new Map(ALPHABET.map((entry) => [entry.key, entry]))

/** A remote connection's identity: its phone's session and its connection epoch. */
export type ConnId = number
export const connId = (session: number, epoch: number): ConnId => session * 1000 + epoch
export const sessionOf = (id: ConnId): number => Math.floor(id / 1000)
export const epochOf = (id: ConnId): number => id % 1000

/** Mesh keeps at most 8 left sessions per peer (leaveSession). */
const LEFT_KEPT = 8
/** A lane direction holds at most this many frames in flight; more is a model error. */
const LANE_KEPT = 4
/** A statement heartbeat has had time to re-announce an old slot after this delay. */
export const DROP_DELAY_MS = 30_000

/** A statement generation: the phone that minted it, its session then, and that phone's statement offer count toward the peer (the transport's `${sid}.${offers}`). */
export interface Gen {
  by: number
  session: number
  n: number
}

const sameGen = (a: Gen | null, b: Gen | null): boolean => a !== null && b !== null && a.by === b.by && a.session === b.session && a.n === b.n

export interface HalfExtra {
  /** the statement offers this half sent in this session (the transport's offer counter) */
  offers: number
  /** each earlier session's final offer count (kept across a reload, never keyed itself): the origin its gens stay keyed against */
  ended: { session: number; offers: number }[]
  /** the transport's current outgoing gen toward the peer (out.get(peer).gen; null: none, an answer is dropped) */
  out: Gen | null
  /** the gen of the held statement description (statementInbound's gen) */
  inboundGen: Gen | null
  /** the gen of the offer being answered, which the answer echoes (null with `answering`) */
  answeringGen: Gen | null
  /** the sender connection the PC accepted a statement description from (null: none yet) */
  heldRemote: ConnId | null
  /** the offer being applied and answered (Mesh's answering entry), until its answer is set */
  answering: ConnId | null
  /** the sender of the held statement description (statementInbound) */
  inbound: ConnId | null
  /** the remote connections the peer left (leftSessions) */
  left: ConnId[]
  /** each pending statement set-remote-description and whose description it applies */
  srd: { commandEpoch: number; from: ConnId | null }[]
  /** the codec guard holding a lane offer of this half (absent: none); see codecGuard below */
  guard?: CodecGuard
  /** this connection reached failed by ICE consent expiry (the frozen clock's ice:silent): it does not come up again until an ICE restart or a new connection; absent: not */
  consentLost?: true
}

/**
 * The codec guard over one lane offer (mesh.ts guardOfferRtxByActor 4193-4204,
 * guardOfferForActor 4209-4219): Mesh settles the guard's rollback, then its
 * stripped send-offer, then the lane offer it holds, in that order.
 */
interface CodecGuard {
  /** the connection epoch the guard's offer was set on */
  epoch: number
  /** the guarded lane send-offer's command epoch (offerOnLane's own promise) */
  original: number
  /** the guard's rollback settled resolved (true), otherwise (false); null while it runs */
  rolled: boolean | null
  /** the guard's stripped send-offer resolved (true), otherwise (false); null while it runs */
  offered: boolean | null
}

export interface StatementFrame {
  kind: "offer" | "answer"
  from: ConnId
  /** the transport generation: an offer's own, an answer's the offer's it answers */
  gen: Gen | null
  /** the receiver session that read it; the store keeps it for a later session */
  readBy: number | null
  /** when this description was last published */
  publishedAt: number
}

export interface LaneFrame {
  kind: "offer" | "answer"
  from: ConnId
  to: ConnId
}

interface PhoneQueued {
  peer: number
  item: Queued
}

export interface Phone {
  session: number
  /** the runner's one FIFO, each item tagged with the half it is for; at rest it is empty or starts with a choice */
  queue: PhoneQueued[]
  /** an advance happened since this phone last swept: it must sweep before the next advance */
  owesSweep: boolean
  /** the beat label (ROOM_BEAT): when this phone last beat, null when it has not since its boot; absent without the beat */
  lastBeat?: number | null
  /** this phone's engine is not RTX-safe (rtxSafeEngine false, mesh.ts 343-354): fixed at its start, kept over a reload (the same browser); absent: safe */
  rtxUnsafe?: true
  /** this phone may hide and freeze (ROOM_FROZEN); absent: it is always shown */
  freezable?: true
  /** hidden: the phone's own clock (localNow) when the page went to the background (page-away.ts 24-26 hiddenAt); absent: shown */
  hiddenAt?: number
  /** frozen: the room time the page froze (iOS suspends a hidden page and its monotonic clock stops); absent: running */
  frozenAt?: number
  /** the room time this phone's clock has missed, frozen, so far: its clock reads room.now - lag; absent: 0 */
  lag?: number
}

export interface Room {
  n: number
  /** the beat label replaces the free hello reads (ROOM_BEAT=1); absent otherwise */
  beat?: true
  now: number
  faultsLeft: number
  phones: Phone[]
  /** halves[i][j]: phone i's actor world toward j; halves[i][i] is unused. At rest a half's queue is [] and its now is stale: the room's now is the clock. */
  halves: ActorWorld[][]
  extras: HalfExtra[][]
  /** slots[from][to]: the statement store's description slot for that direction */
  slots: (StatementFrame | null)[][]
  /** lanes[from][to]: lane frames in flight on the open channel, in order */
  lanes: LaneFrame[][][]
  /** admitted[receiver][sender]: the sender session the receiver's transport admitted (null: none yet) */
  admitted: (number | null)[][]
}

const emptyExtra = (): HalfExtra => ({ offers: 0, ended: [], out: null, inboundGen: null, answeringGen: null, heldRemote: null, answering: null, inbound: null, left: [], srd: [] })

/** A fresh half, as startActor seeds it (mesh.ts:4717-4745) and the actor explorer's initialWorlds make it. */
function freshHalf(i: number, j: number): ActorWorld {
  const initiator = i < j
  return {
    actor: createPeerActorState({ game: ROOM.game, roomEpoch: ROOM.roomEpoch, peer: initiator ? "b" : "a" }, { initiator, standby: false, cameraLive: true, connectionEpoch: 1, connectingSince: START_NOW }),
    meshConnectionEpoch: 1,
    now: START_NOW,
    facts: freshFacts({}, initiator),
    pending: [],
    nextReadSequence: 1,
    faultsLeft: 0,
    queue: [],
    mesh: freshBook(initiator, { cameraLive: true }),
  }
}

const square = <T>(n: number, make: (i: number, j: number) => T): T[][] => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => make(i, j)))

/** The beat label is on when ROOM_BEAT=1 (read where a room is made, so forked workers see it too). */
export const beatFromEnv = (): boolean => process.env.ROOM_BEAT === "1"

/** Network-run entry points default to the beat without changing explicit model fixtures. */
export function defaultRoomBeat(): void {
  if (process.env.ROOM_BEAT === undefined) process.env.ROOM_BEAT = "1"
}

/** ROOM_NO_LANE_OTHER=1 drops every charged lane rejection with reason "other" (Mesh cannot produce one). Off by default; read once per process (forked workers inherit the env). */
export const noLaneOtherFromEnv = (): boolean => process.env.ROOM_NO_LANE_OTHER === "1"
let noLaneOther = noLaneOtherFromEnv()
/** Tests only: re-read ROOM_NO_LANE_OTHER. */
export function refreshNoLaneOther(): void {
  noLaneOther = noLaneOtherFromEnv()
}

/** The phones whose engine is not RTX-safe, from ROOM_RTX_UNSAFE (comma-separated indices; read where a room is made, so forked workers see it too). */
export const rtxUnsafeFromEnv = (): number[] => (process.env.ROOM_RTX_UNSAFE ?? "").split(",").filter((part) => part.trim() !== "").map(Number)

/** The phones that may hide and freeze, from ROOM_FROZEN (comma-separated indices; read where a room is made, so forked workers see it too). Default none: the frozen clock is off. */
export const frozenFromEnv = (): number[] => (process.env.ROOM_FROZEN ?? "").split(",").filter((part) => part.trim() !== "").map(Number)

/** `rtxUnsafe`: the phones whose engine is not RTX-safe (default none; both values are explored from explicit roots). `freezable`: the phones that may hide and freeze (default none). */
export function initialRoom(n: number, faults: number, beat: boolean = beatFromEnv(), rtxUnsafe: readonly number[] = rtxUnsafeFromEnv(), freezable: readonly number[] = frozenFromEnv()): Room {
  for (const i of rtxUnsafe) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`no phone ${i} to make RTX-unsafe in a room of ${n}`)
  for (const i of freezable) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`no phone ${i} to freeze in a room of ${n}`)
  return {
    n,
    ...(beat ? { beat: true as const } : {}),
    now: START_NOW,
    faultsLeft: faults,
    phones: Array.from({ length: n }, (_, i) => ({ session: 1, queue: [], owesSweep: false, ...(beat ? { lastBeat: null } : {}), ...(rtxUnsafe.includes(i) ? { rtxUnsafe: true as const } : {}), ...(freezable.includes(i) ? { freezable: true as const } : {}) })),
    halves: square(n, (i, j) => (i === j ? (undefined as unknown as ActorWorld) : freshHalf(i, j))),
    extras: square(n, () => emptyExtra()),
    slots: square(n, () => null),
    lanes: square(n, () => []),
    admitted: square(n, () => null),
  }
}

/** Phone i's own clock (Mesh's monoNow, mesh.ts 147: performance.now() + 1): the room's now less the time it spent frozen, standing still while frozen. Without the frozen clock it is the room's now. */
export const localNow = (room: Room, i: number): number => {
  const phone = room.phones[i]!
  return (phone.frozenAt ?? room.now) - (phone.lag ?? 0)
}

const isFrozen = (room: Room, i: number): boolean => room.phones[i]!.frozenAt !== undefined

export const halfId = (room: Room, i: number, j: number): ConnId => connId(room.phones[i]!.session, room.halves[i]![j]!.meshConnectionEpoch)

/** Both current connections hold each other's current descriptions: the benign network may connect them. */
export function matched(room: Room, i: number, j: number): boolean {
  const a = room.halves[i]![j]!
  const b = room.halves[j]![i]!
  return room.extras[i]![j]!.heldRemote === halfId(room, j, i) && room.extras[j]![i]!.heldRemote === halfId(room, i, j)
    && a.facts.localDescription && a.facts.remoteDescription && b.facts.localDescription && b.facts.remoteDescription
}

export const pairsOf = (n: number): [number, number][] => {
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j])
  return out
}

export const quiet = (room: Room): boolean => room.phones.every((phone) => phone.queue.length === 0)

/** The statement transport's heartbeat period while any link of a phone is forming or down, and its stable-hello period once every link is up (statementTransport.ts:186-190). */
const HEARTBEAT_MS = 8_000
export const STABLE_HELLO_MS = 16_000

/** Every open link of phone i is connected with its lane open: the beat slows to STABLE_HELLO_MS. */
const allLinksUp = (room: Room, i: number): boolean => {
  for (let j = 0; j < room.n; j++) {
    if (j === i) continue
    const world = room.halves[i]![j]!
    if (world.actor.link === "closed") continue
    if (world.facts.browserConnectionState !== "connected" || !world.facts.laneOpen) return false
  }
  return true
}

/** When phone i's next beat is due (the beat label only): at once after a boot, else one period after the last beat. */
export const beatDueAt = (room: Room, i: number): number => {
  const last = room.phones[i]!.lastBeat
  return last === null || last === undefined ? localNow(room, i) : last + (allLinksUp(room, i) ? STABLE_HELLO_MS : HEARTBEAT_MS)
}

/** Is any phone's beat due now? A beat is not optional: time does not pass a due beat. */
export const beatDue = (room: Room): boolean => room.beat === true && room.phones.some((_, i) => !isFrozen(room, i) && beatDueAt(room, i) <= localNow(room, i))

// ── one edge ──

export interface RoomStep {
  phone: number
  peer: number
  event: PeerActorEvent
  before: PeerActorState
  result: PeerActorStep
}

/** One half's sub-sequence in an edge: the actor steps it ran from one start (an alphabet entry the room built, the head choice, or a queued broadcast item the drain reached) to the end of its own drain. */
export interface InclusionRecord {
  phone: number
  peer: number
  /** the actor alphabet entry this sub-sequence stands for; `unmapped:…` when a drained item has none */
  key: string
  /** entry: built by sub() or a choice; drained: started by a queued item the drain reached; gap: the room's own fallback (an inclusion gap, never compared) */
  kind: "entry" | "drained" | "gap"
  /** the projected world before the sub-sequence (queue = this half's items, faultsLeft 99) */
  before: ActorWorld
  /** the projected world when its drain finished; null when another half's item still waits ahead of one of its own; undefined while open */
  after?: ActorWorld | null
  /** the actor steps attributed to it */
  steps: number
}

export interface InclusionGap {
  phone: number
  peer: number
  key: string
  why: string
}

export interface RoomViolation {
  property: string
  detail: string
}

/** The working state of one edge: the room copied shallowly, a half cloned on first touch. */
export class Edge {
  readonly room: Room
  readonly steps: RoomStep[] = []
  readonly commands: { phone: number; peer: number; command: PeerActorCommand; event: PeerActorEvent }[] = []
  readonly inclusion: InclusionRecord[] = []
  /** the sub-sequence each half is in now (recording only) */
  readonly open = new Map<string, InclusionRecord>()
  /** actor steps run with no open sub-sequence: a hole in the inclusion check's coverage */
  unattributed = 0
  readonly gaps: InclusionGap[] = []
  readonly violations: RoomViolation[] = []
  /** completions of statement SRDs: whose description each applied */
  private readonly ownHalves = new Set<string>()
  private readonly ownExtras = new Set<string>()
  private readonly ownPhones = new Set<number>()
  private ownSlots = false
  private ownLanes = false
  private ownAdmitted = false

  constructor(readonly parent: Room, readonly recordInclusion: boolean) {
    this.room = { ...parent, phones: [...parent.phones], halves: parent.halves.map((row) => [...row]), extras: parent.extras.map((row) => [...row]), slots: parent.slots, lanes: parent.lanes, admitted: parent.admitted }
  }

  half(i: number, j: number): ActorWorld {
    const key = `${i},${j}`
    if (!this.ownHalves.has(key)) {
      const copy = cloneWorld(this.room.halves[i]![j]!)
      copy.queue = []
      this.room.halves[i]![j] = copy
      this.ownHalves.add(key)
    }
    const world = this.room.halves[i]![j]!
    world.now = localNow(this.room, i)
    return world
  }

  setHalf(i: number, j: number, world: ActorWorld): void {
    this.room.halves[i]![j] = world
    this.ownHalves.add(`${i},${j}`)
  }

  extra(i: number, j: number): HalfExtra {
    const key = `${i},${j}`
    if (!this.ownExtras.has(key)) {
      const old = this.room.extras[i]![j]!
      this.room.extras[i]![j] = { ...old, left: [...old.left], srd: old.srd.map((entry) => ({ ...entry })) }
      this.ownExtras.add(key)
    }
    return this.room.extras[i]![j]!
  }

  phone(i: number): Phone {
    if (!this.ownPhones.has(i)) {
      const old = this.room.phones[i]!
      this.room.phones[i] = { ...old, queue: [...old.queue] }
      this.ownPhones.add(i)
    }
    return this.room.phones[i]!
  }

  slots(): (StatementFrame | null)[][] {
    if (!this.ownSlots) {
      this.room.slots = this.room.slots.map((row) => row.map((frame) => (frame ? { ...frame } : null)))
      this.ownSlots = true
    }
    return this.room.slots
  }

  lanes(): LaneFrame[][][] {
    if (!this.ownLanes) {
      this.room.lanes = this.room.lanes.map((row) => row.map((frames) => [...frames]))
      this.ownLanes = true
    }
    return this.room.lanes
  }

  admitted(): (number | null)[][] {
    if (!this.ownAdmitted) {
      this.room.admitted = this.room.admitted.map((row) => [...row])
      this.ownAdmitted = true
    }
    return this.room.admitted
  }

  /** the halves this edge changed, as `i,j` */
  touched(): ReadonlySet<string> {
    return this.ownHalves
  }
}

/** The half's world as the actor explorer would hold it: the room's now, this half's queued items in phone order, a large fault budget (the room charges faults). */
function project(room: Room, i: number, j: number): ActorWorld {
  const world = cloneWorld(room.halves[i]![j]!)
  world.now = localNow(room, i)
  world.faultsLeft = 99
  world.queue = room.phones[i]!.queue.filter((entry) => entry.peer === j).map((entry) => entry.item)
  return world
}

/** One actor step on half (i, j), its commands run as executePeerCommand does, the follow-ups appended to the phone's FIFO. */
function run(edge: Edge, i: number, j: number, event: PeerActorEvent): void {
  const world = edge.half(i, j)
  const before = world.actor
  const result = stepPeerActor(before, event)
  world.actor = result.state
  const leave = meshLeave(world.mesh.leave, before, event, result)
  if (leave !== world.mesh.leave) world.mesh = { ...world.mesh, leave }
  edge.steps.push({ phone: i, peer: j, event, before, result })
  if (edge.recordInclusion) {
    const record = edge.open.get(`${i},${j}`)
    if (record) record.steps += 1
    else edge.unattributed += 1
  }
  for (const command of result.commands) {
    edge.commands.push({ phone: i, peer: j, command, event })
    // RP4: a statement offer from the answering half needs Mesh's leave to offer
    if (statementOfferWithoutLeave(before.initiator, world.mesh.leave, command)) {
      edge.violations.push({ property: "RP4", detail: `phone ${i}'s answering half toward ${j} issued a statement offer without the leave to offer (${event.type})` })
    }
    apply(edge, i, j, world, command)
  }
  flush(edge, i, j, world)
}

/** RP4: a statement offer issued by the pair's answering half while Mesh holds no leave to offer for it (the leave as the step left it). */
export function statementOfferWithoutLeave(initiator: boolean, leave: boolean, command: PeerActorCommand): boolean {
  return command.kind === "send-offer" && !command.lane && !initiator && !leave
}

function apply(edge: Edge, i: number, j: number, world: ActorWorld, command: PeerActorCommand): void {
  const epochBefore = world.meshConnectionEpoch
  const pendingBefore = world.pending.length
  applyCommand(world, command)
  if (world.meshConnectionEpoch !== epochBefore) {
    const extra = edge.extra(i, j)
    extra.heldRemote = null
    extra.answering = null
    extra.answeringGen = null
    // a new connection: the guard's offers settle on the old one, as any overtaken promise
    delete extra.guard
    delete extra.consentLost
  }
  if (command.kind === "set-remote-description" && !command.lane && world.pending.length > pendingBefore) {
    const entry = world.pending[world.pending.length - 1]!
    const extra = edge.extra(i, j)
    extra.srd.push({ commandEpoch: entry.commandEpoch, from: extra.inbound })
    // beginAnswering: the offer being applied is the PC's record until its answer is set
    if (entry.description !== "answer") {
      extra.answering = extra.inbound
      extra.answeringGen = extra.inboundGen
    }
  }
}

function flush(edge: Edge, i: number, j: number, world: ActorWorld): void {
  if (world.queue.length === 0) return
  const phone = edge.phone(i)
  for (const item of world.queue) phone.queue.push({ peer: j, item })
  world.queue = []
}

/** Open a sub-sequence for half (i, j) (recording only). */
function openRecord(edge: Edge, i: number, j: number, key: string, kind: InclusionRecord["kind"], before: ActorWorld): InclusionRecord | null {
  if (!edge.recordInclusion) return null
  const record: InclusionRecord = { phone: i, peer: j, key, kind, before, steps: 0 }
  edge.inclusion.push(record)
  edge.open.set(`${i},${j}`, record)
  return record
}

/** Close every open sub-sequence of phone i (all phones when i is null) at its settled view. */
function closeRecords(edge: Edge, i: number | null): void {
  for (const [key, record] of edge.open) {
    if (i !== null && record.phone !== i) continue
    record.after = settledView(edge.room, record.phone, record.peer)
    edge.open.delete(key)
  }
}

/** The actor entry a queued item stands for when the drain reaches it as the start of its half's sub-sequence. */
function drainedKey(item: Queued): string {
  if (item.type === "sweep") return "supervisor-tick"
  if (item.type === "event" && item.event.type === "network-changed") return "network-changed"
  return `unmapped:${item.type === "event" ? `event:${item.event.type}` : item.type}`
}

/** The phone's drain: up to an empty FIFO or a choice at its head. A half reached here with no open sub-sequence (a broadcast item queued behind another half's choice) starts one. */
function drain(edge: Edge, i: number): void {
  const phone = edge.phone(i)
  while (phone.queue.length > 0 && phone.queue[0]!.item.type !== "choice") {
    const { peer, item } = phone.queue.shift()!
    const start = () => {
      if (edge.recordInclusion && !edge.open.has(`${i},${peer}`)) openRecord(edge, i, peer, drainedKey(item), "drained", project(edge.room, i, peer))
    }
    if (item.type === "event") {
      start()
      run(edge, i, peer, item.event)
    } else if (item.type === "tick") {
      start()
      run(edge, i, peer, tickEvent(edge.half(i, peer)))
    } else if (item.type === "sweep") {
      const world = edge.half(i, peer)
      if (world.actor.hidden || world.actor.link === "closed") continue
      start()
      const event = superviseHead(world)
      // supervise's freshness fact: its tick goes to the head, behind the fact
      if (world.queue.length > 0) {
        phone.queue.unshift(...world.queue.map((queued) => ({ peer, item: queued })))
        world.queue = []
      }
      run(edge, i, peer, event)
    }
  }
}

/** One alphabet entry on half (i, j), as the actor explorer's successor runs it, then the phone's drain. Returns false when the entry builds nothing. */
function sub(edge: Edge, i: number, j: number, key: string, front?: number): boolean {
  const entry = ENTRY.get(key)
  if (!entry) throw new Error(`no alphabet entry ${key}`)
  const before = project(edge.room, i, j)
  // `front`: the pending command this completion settles, moved ahead of older ones of its family
  // (the alphabet settles the oldest). Not an actor-explorer step, so it is recorded as a gap.
  if (front !== undefined) {
    const at = before.pending.findIndex((entry) => entry.commandEpoch === front)
    if (at < 0) return false
    before.pending.unshift(...before.pending.splice(at, 1))
  }
  const built = entry.build(before)
  if (!built) return false
  const record = openRecord(edge, i, j, front === undefined ? key : `gap:${key}`, front === undefined ? "entry" : "gap", before)
  const world = built.world
  const items = world.queue
  world.queue = []
  edge.setHalf(i, j, world)
  // a builder's own follow-ups (a peer-away ahead of a description) go first
  if (items.length > 0) {
    const phone = edge.phone(i)
    phone.queue = phone.queue.filter((entry) => entry.peer !== j)
    for (const item of items) phone.queue.push({ peer: j, item })
  }
  run(edge, i, j, built.event)
  drain(edge, i)
  if (record) {
    record.after = settledView(edge.room, i, j)
    edge.open.delete(`${i},${j}`)
  }
  return true
}

/** Complete a promise from a connection Mesh has already replaced. The actor alphabet calls the
 * equivalent generic edge `complete:overtaken`; the room keeps the real promise's stale label. */
function completeMovedStale(edge: Edge, i: number, j: number, key: string, pending: PendingCommand, site: "lane" | "statement-answer"): boolean {
  const before = project(edge.room, i, j)
  const world = cloneWorld(before)
  const index = world.pending.findIndex((entry) => entry.commandEpoch === pending.commandEpoch && entry.connectionEpoch === pending.connectionEpoch)
  if (index < 0) return false
  world.pending.splice(index, 1)
  const record = openRecord(edge, i, j, key, "gap", before)
  edge.setHalf(i, j, world)
  run(edge, i, j, completion(world, pending, { outcome: "stale", site }))
  drain(edge, i)
  if (record) {
    record.after = settledView(edge.room, i, j)
    edge.open.delete(`${i},${j}`)
  }
  return true
}

// ── the codec guard (#559) ──
//
// Mesh (oracle, mesh.ts at this commit):
// - offerOnLane sets the lane offer (2252), then runs the guard (2262-2264) unless
//   the connection moved or a remote offer came in first (2254-2261, the stale bails).
// - codecGuardNeeded (2187-2193): the guard runs only when this engine is not RTX-safe
//   (thisEngineRtxSafe, 357-360; rtxSafeEngine 343-354) AND the offer just set carries
//   RTX (rtxIn, 432-434). Whether it carries RTX is up to the browser: Mesh asks for no
//   RTX through setCodecPreferences on an unsafe engine (setVideoCodecPreferences 445-450),
//   and only says so when that call is missing or refused (1939). In 30 days of
//   telemetry every guard event was reason offer-rtx, none prefs-missing or
//   prefs-refused: the
//   preferences were set and the offer still carried RTX on some offers and not on
//   others. The room cannot derive it, so on an unsafe phone it is a choice: the
//   codec-guard-rtx fact (not a fault), or the lane offer settling without it.
// - The fact goes to the actor (guardOfferRtxByActor, 4193-4204; observePeerInput
//   dispatches it from an await continuation, so the runner is idle and the actor
//   takes it at once, peer-runner.ts enqueue). The actor issues rollback(codec-guard)
//   and send-offer(lane) (peer-actor.ts codec-guard-rtx); rollbackForActor starts the
//   rollback (4159-4164, rollbackLocal 2197-2204) and offerForActor hands the
//   send-offer to guardOfferForActor (4138-4144).
// - guardOfferForActor (4209-4219) awaits the rollback: not resolved -> stale; else
//   stripAndSetOffer (2210-2231): stale when the connection is no longer stable
//   (a remote offer, a rebuild), rejected when createOffer or the SLD throws,
//   resolved once the stripped offer is set. Then `finished` releases offerOnLane.
// - offerOnLane (2262-2264): the guard's offer not resolved -> stale (done: set-lane);
//   resolved -> the one lane offer is sent (2271-2279) and it resolves.
// So: the rollback settles first, then the guard's send-offer, then the guarded offer,
// and exactly one lane frame goes out, at the guarded offer's resolve.
// The guard's stash lives only while the fact is dispatched (withStash, 2308-2314):
// once the guard's offer settles nothing of it is left.

/** The current guard of half (i, j), if it is on the half's current connection. */
function guardOf(room: Room, i: number, j: number): CodecGuard | null {
  const guard = room.extras[i]![j]!.guard
  return guard && guard.epoch === room.halves[i]![j]!.meshConnectionEpoch ? guard : null
}

/** A remote offer came in over our lane offer: offerOnLane's and stripAndSetOffer's "no longer ours" (2254-2261, 2212-2219). */
function laneOfferCrossed(world: ActorWorld, after: number): boolean {
  return world.mesh.signaling === "have-remote-offer"
    || world.pending.some((entry) => entry.kind === "set-remote-description" && entry.lane === true && entry.description === "offer" && entry.commandEpoch > after)
}

/** The lane offer the guard may hold: offerOnLane's own, on the current connection, not yet settled. */
function guardableOffer(world: ActorWorld): PendingCommand | undefined {
  return world.pending.find((entry) => entry.kind === "send-offer" && entry.lane === true && entry.cause === undefined && entry.connectionEpoch === world.meshConnectionEpoch)
}

/** h:<i>><j>:codec-guard-rtx: on an RTX-unsafe phone, its pending lane offer carried RTX. */
function codecGuardStart(edge: Edge, i: number, j: number): boolean {
  const room = edge.room
  if (!room.phones[i]!.rtxUnsafe || guardOf(room, i, j)) return false
  const world = room.halves[i]![j]!
  const original = guardableOffer(world)
  if (!original || laneOfferCrossed(world, original.commandEpoch)) return false
  if (!sub(edge, i, j, "codec-guard-rtx")) return false
  const after = edge.room.halves[i]![j]!
  const taken = after.pending.some((entry) => entry.kind === "rollback" && entry.cause === "codec-guard" && entry.connectionEpoch === after.meshConnectionEpoch)
  // the actor did not take it: nothing may be sent (4203), the guarded offer goes stale
  edge.extra(i, j).guard = { epoch: after.meshConnectionEpoch, original: original.commandEpoch, rolled: taken ? null : false, offered: taken ? null : false }
  if (!taken) edge.half(i, j).mesh.codecGuard = false
  return true
}

const LANE_OFFER_DONE = /^complete:send-offer:lane:(resolved|stale:lane|rejected:lane:.+)$/

/**
 * A lane send-offer's completion while a guard holds the half: the guard's own
 * offer, then the guarded one, in Mesh's order. Null: not the guard's business
 * (no guard, or a completion of another family). False: not enabled.
 */
function codecGuardComplete(edge: Edge, i: number, j: number, key: string, charge: () => boolean): boolean | null {
  const room = edge.room
  const guard = guardOf(room, i, j)
  const outcome = LANE_OFFER_DONE.exec(key)?.[1]
  if (!guard || !outcome) return null
  const world = room.halves[i]![j]!
  const own = world.pending.find((entry) => entry.kind === "send-offer" && entry.lane === true && entry.cause === "codec-guard" && entry.connectionEpoch === guard.epoch)
  if (own) {
    // guardOfferForActor awaits the rollback first (4212)
    if (guard.rolled === null) return false
    // a failed rollback: stale only (4212). A remote lane offer crossing the guard: stale, or any
    // outcome, as the base lane-offer rule allows: stripAndSetOffer re-reads the signalling state only
    // at its awaits (still(), 2213-2228), so a remote SRD queued on the PC's operation chain behind the
    // stripped SLD still leaves have-local-offer, and offerOnLane then sends (2266-2279).
    // Otherwise the stripped offer is set or refused, never stale.
    const stale = outcome === "stale:lane"
    if (!guard.rolled ? !stale : stale && !laneOfferCrossed(world, own.commandEpoch)) return false
    if (isFaultEntry(key) && !charge()) return false
    if (!sub(edge, i, j, key, own.commandEpoch)) return false
    // a refused stripped offer may replace the connection: the guard went with it (apply)
    if (edge.room.halves[i]![j]!.meshConnectionEpoch === guard.epoch) edge.extra(i, j).guard = { ...guard, offered: outcome === "resolved" }
    // the guard's stash is gone (withStash 2308-2314): a later lane offer is offerOnLane's own
    if (outcome !== "resolved") edge.half(i, j).mesh.codecGuard = false
    return true
  }
  const original = world.pending.find((entry) => entry.commandEpoch === guard.original && entry.connectionEpoch === guard.epoch)
  if (!original) return null
  // offerOnLane waits for the guard's offer (`finished`, 4204), then sends or bails (2262-2264)
  if (guard.offered === null) return false
  if (outcome !== (guard.offered ? "resolved" : "stale:lane")) return false
  if (!sub(edge, i, j, key)) return false
  if (guard.offered) publish(edge, i, j, key)
  delete edge.extra(i, j).guard
  return true
}

/** The half's projected world when its own drain has finished: no other half's item waits ahead of one of its own. */
function settledView(room: Room, i: number, j: number): ActorWorld | null {
  const queue = room.phones[i]!.queue
  const firstOwn = queue.findIndex((entry) => entry.peer === j)
  if (firstOwn > 0 && queue.slice(0, firstOwn).some((entry) => entry.peer !== j)) return null
  return project(room, i, j)
}

/** A fact Mesh delivers to every half of phone i in insertion order (a sweep, a network change): each runs with its whole drain, and those behind a choice wait in the FIFO. */
function broadcast(edge: Edge, i: number, key: string, item: (j: number) => Queued | null): void {
  const room = edge.room
  for (let j = 0; j < room.n; j++) {
    if (j === i) continue
    if (edge.room.phones[i]!.queue.length === 0) {
      sub(edge, i, j, key)
    } else {
      const queued = item(j)
      if (queued) edge.phone(i).queue.push({ peer: j, item: queued })
    }
  }
}

// ── statement descriptions as Mesh's onRtc builds them ──

/** onRtc's own steps for a statement description the actor alphabet refuses (actor/alphabet.ts statementDescription, the same text): the peer heard, the description held, the away mark cleared ahead of it. */
function meshStatement(world: ActorWorld, kind: "offer" | "answer", held: boolean): PeerActorEvent {
  world.facts.lastSignalAt = world.now
  if (world.facts.firstHeardAt === null) world.facts.firstHeardAt = world.now
  world.mesh.statementInbound = kind
  const offering = world.pending.some((entry) => entry.kind === "send-offer" && entry.connectionEpoch === world.meshConnectionEpoch)
  const collision = !held && kind === "offer" && (offering || world.mesh.signaling !== "stable")
  const event: PeerActorEvent = collision && world.actor.initiator
    ? { type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false, ...stamp(world) }
    : { type: "description-observed", departedSession: false, lane: false, description: kind, ...(held ? { newRemoteSession: { at: world.now } } : {}), ...stamp(world) }
  // onSignal tells the actor the peer was heard first, then the away mark goes
  if (world.facts.away !== null && !held) world.queue.push({ type: "event", event: { type: "peer-away", away: "back", ...stamp(world) } })
  world.queue.push({ type: "event", event })
  return { type: "peer-heard", at: world.now, ...stamp(world) }
}

/** The fallback when the alphabet refuses a caused fact: Mesh's own event, recorded as an inclusion gap. */
function fallback(edge: Edge, i: number, j: number, key: string, why: string, make: (world: ActorWorld) => PeerActorEvent | null): void {
  edge.gaps.push({ phone: i, peer: j, key, why })
  openRecord(edge, i, j, `gap:${key}`, "gap", project(edge.room, i, j))
  const world = project(edge.room, i, j)
  world.queue = []
  const event = make(world)
  if (!event) return
  const items = world.queue
  world.queue = []
  edge.setHalf(i, j, world)
  for (const item of items) edge.phone(i).queue.push({ peer: j, item })
  run(edge, i, j, event)
  drain(edge, i)
  closeRecords(edge, i)
}

// ── labels ──

/** The actor alphabet entries a half takes on its own (the half-local family). */
export const HALF_LOCAL: readonly string[] = [
  "local-offer-requested",
  "stats:advance",
  "stats:same",
  "stats:reset",
  "stats:no-inbound",
  "stats:no-video-deadline",
  "stats:heal-held",
  "stats:peer-cannot-see-us",
  "stats:probe",
  "stats:held",
  ...ALPHABET.filter((entry) => entry.key.startsWith("complete:") && !entry.key.startsWith("complete:restart-ice")).map((entry) => entry.key),
]

/**
 * The one half-local entry of an RTX-unsafe phone only (codecGuardStart gates it). Kept out of
 * HALF_LOCAL and emitted only for an unsafe phone, after that pair's HALF_LOCAL labels, so an
 * all-safe room's candidateLabels() is exactly what it was before the guard: a tiled path is a
 * label's position in that list (tiled.ts STEP_BYTES), and older runs must still resume.
 */
export const UNSAFE_LOCAL: readonly string[] = ["codec-guard-rtx"]

/** Actor entries the room replaces by caused labels (the remote side is modelled). */
export const CAUSED: Readonly<Record<string, string>> = {
  "peer-heard": "hello:<i>@<j> and every statement delivery (markSeen)",
  "peer-session-changed": "hello:<i>@<j> with a new session (onPeerSession)",
  "description:statement-offer": "w:<i>><j>:deliver",
  "description:statement-offer:from-answerer": "w:<i>><j>:deliver",
  "description:statement-answer": "w:<i>><j>:deliver",
  "description:statement-offer:new-session": "w:<i>><j>:deliver from another remote connection",
  "description:statement-answer:new-session": "w:<i>><j>:deliver from another remote connection",
  "description:departed": "w:<i>><j>:deliver from a left connection",
  "description:lane-offer": "lane:<i>><j>:deliver",
  "description:lane-offer:from-answerer": "lane:<i>><j>:deliver",
  "description:lane-answer": "lane:<i>><j>:deliver",
  "connection-observed:connected": "ice:<lo>-<hi>:up",
  "connection-observed:disconnected": "ice:<lo>-<hi>:drop (fault) or ice:<i>><j>:lost",
  "connection-observed:failed": "ice:<i>><j>:lost",
  "channel-observed:open": "chan:<lo>-<hi>:open",
  "network-changed": "ph:<i>:network (fault)",
  "supervisor-tick": "tick:<i>, advance:<i>, advance-jb:<i>",
  "advance": "advance:<i>",
  "advance:just-before": "advance-jb:<i>",
  "complete:restart-ice:resolved": "choice:<i>:resolved",
  "complete:restart-ice:rejected": "choice:<i>:rejected (fault)",
}

/** Actor entries the room leaves out, with why (most need a phone label the room does not model yet). */
export const DROPPED: Readonly<Record<string, string>> = {
  "peer-away:said": "needs the peer's hide: caused by vis:<i>:hide only with ROOM_FROZEN (not modelled otherwise)",
  "peer-away:back": "needs the peer's hide: caused by vis:<i>:show only with ROOM_FROZEN (not modelled otherwise)",
  "connection-observed:connected-again": "the second ICE report changes nothing the key holds; left out to keep the branching down",
  "channel-observed:closed": "the channel closing alone is not modelled",
  "local-offer-superseded:held": "no current mesh path supersedes a local offer",
  "local-offer-superseded:left": "no current mesh path supersedes a local offer",
  "stats:camera-down": "camera is a phone label (not modelled yet)",
  "stats:camera-up": "camera is a phone label (not modelled yet)",
  "visibility:hide": "phone label: vis:<i>:hide only with ROOM_FROZEN (not modelled otherwise)",
  "visibility:show": "phone label: vis:<i>:show only with ROOM_FROZEN, with the phone's own hiddenForMs (not modelled otherwise)",
  "visibility:show-long": "phone label: vis:<i>:show only with ROOM_FROZEN, with the phone's own hiddenForMs (not modelled otherwise)",
  "visibility:kick-unmarked": "phone label (not modelled yet)",
  "standby:on": "roster and standby (not modelled yet)",
  "standby:off": "roster and standby (not modelled yet)",
  "ice-policy-changed": "the ICE policy change is not modelled yet",
  "round-changed": "phone label (not modelled yet)",
  "peer-removed": "the roster is fixed",
  "room-closed": "the roster is fixed",
  "connection-replaced-externally": "rebuildAll (an ICE policy change) is not modelled yet",
}

/** Every label that might be enabled in this room, cheaply gated; `step` decides. */
export function candidateLabels(room: Room): string[] {
  const out: string[] = []
  const n = room.n
  const busy = room.phones.findIndex((phone) => phone.queue.length > 0)
  if (busy >= 0) {
    // a synchronous drain is atomic: only the head choice of a busy phone is enabled, room-wide
    for (let i = 0; i < n; i++) if (room.phones[i]!.queue[0]?.item.type === "choice") out.push(`choice:${i}:resolved`, `choice:${i}:rejected`)
    return out
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      for (const key of HALF_LOCAL) out.push(`h:${i}>${j}:${key}`)
      if (room.phones[i]!.rtxUnsafe) for (const key of UNSAFE_LOCAL) out.push(`h:${i}>${j}:${key}`)
      if (!room.beat) out.push(`hello:${i}@${j}`)
      out.push(`w:${i}>${j}:deliver`, `w:${i}>${j}:drop`, `lane:${i}>${j}:deliver`, `ice:${i}>${j}:lost`)
    }
  }
  for (const [lo, hi] of pairsOf(n)) out.push(`ice:${lo}-${hi}:up`, `ice:${lo}-${hi}:drop`, `chan:${lo}-${hi}:open`)
  for (let i = 0; i < n; i++) out.push(`tick:${i}`, `advance:${i}`, `advance-jb:${i}`, `ph:${i}:network`, `ph:${i}:reload`)
  if (room.beat) for (let i = 0; i < n; i++) out.push(`beat:${i}`)
  // the frozen page clock's labels come last, only for a freezable phone, so a room without one keeps every label's position (tiled paths)
  for (let i = 0; i < n; i++) {
    if (!room.phones[i]!.freezable) continue
    out.push(`vis:${i}:hide`, `vis:${i}:hide-quiet`, `vis:${i}:freeze`, `vis:${i}:show`)
    for (let j = 0; j < n; j++) if (j !== i) out.push(`ice:${j}>${i}:silent`)
  }
  return out
}

const pairOf = (label: string): [number, number] => {
  const match = /^(\w+):(\d+)[>@-](\d+)/.exec(label)
  if (!match) throw new Error(`no pair in ${label}`)
  return [Number(match[2]), Number(match[3])]
}

export interface Successor {
  room: Room
  edge: Edge
  fault: boolean
}

export interface StepOptions {
  /** record each sub-step's projected world for the inclusion check */
  inclusion?: boolean
  /** take no fault labels (the fair continuation) */
  noFaults?: boolean
}

/** The room's next instant for `advance`: the next flip of any half, else the quiet until every distance saturates. */
function nextRoomDeadline(room: Room): number | null {
  // each phone's instants are on its own clock: back to the room's by its lag; a frozen phone has none (its timers do not run)
  let next: number | null = null
  for (let i = 0; i < room.n; i++) for (let j = 0; j < room.n; j++) {
    if (i === j || isFrozen(room, i)) continue
    const world = project(room, i, j)
    const local = nextDeadline(world)
    const at = local === null ? null : local + (room.phones[i]!.lag ?? 0)
    if (at !== null && (next === null || at < next)) next = at
  }
  if (room.beat) {
    for (let i = 0; i < room.n; i++) {
      if (isFrozen(room, i)) continue
      const at = beatDueAt(room, i) + (room.phones[i]!.lag ?? 0)
      if (at > room.now && (next === null || at < next)) next = at
    }
  }
  if (next !== null) return next
  for (let i = 0; i < room.n; i++) for (let j = 0; j < room.n; j++) {
    if (i === j || isFrozen(room, i)) continue
    const local = quietUntil(project(room, i, j), SAT)
    const at = local === null ? null : local + (room.phones[i]!.lag ?? 0)
    if (at !== null && (next === null || at < next)) next = at
  }
  return next
}

/** Is any half of phone i due a sweep at the room's now? */
const sweepDue = (room: Room, i: number): boolean => {
  for (let j = 0; j < room.n; j++) {
    if (j === i) continue
    const world = room.halves[i]![j]!
    if (!world.actor.hidden && world.actor.link !== "closed" && world.mesh.tickedAt !== localNow(room, i)) return true
  }
  return false
}

function sweep(edge: Edge, i: number): void {
  edge.phone(i).owesSweep = false
  // supervise() returns at once while the page is hidden (mesh.ts 2796)
  if (edge.room.phones[i]!.hiddenAt !== undefined) return
  broadcast(edge, i, "supervisor-tick", (j) => {
    const world = edge.room.halves[i]![j]!
    return world.mesh.tickedAt === localNow(edge.room, i) ? null : { type: "sweep" }
  })
}

/** The statement frame on (from > to) the receiver's transport would read now, or null. An answer it reads may still be stale (`staleAnswer`): then it is dropped before Mesh. */
export function deliverable(room: Room, from: number, to: number): StatementFrame | null {
  const frame = room.slots[from]![to]
  if (!frame || frame.readBy === room.phones[to]!.session) return null
  const admitted = room.admitted[to]![from]
  if (admitted !== null && admitted !== sessionOf(frame.from)) return null
  if (room.halves[to]![from]!.actor.link === "closed") return null
  return frame
}

/** The transport's answer gate (statementTransport.ts dispatchDirected): an answer not for our current outgoing gen is dropped. */
export const staleAnswer = (room: Room, from: number, to: number, frame: StatementFrame): boolean => frame.kind === "answer" && !sameGen(frame.gen, room.extras[to]![from]!.out)

function deliverStatement(edge: Edge, from: number, to: number, frame: StatementFrame): void {
  const room = edge.room
  edge.slots()[from]![to] = { ...frame, readBy: room.phones[to]!.session }
  // admitSession runs before the generation gate: a dropped answer still admits its sender's session
  if (room.admitted[to]![from] === null) edge.admitted()[to]![from] = sessionOf(frame.from)
  if (staleAnswer(room, from, to, frame)) return
  // onSignal: markSeen before onRtc
  sub(edge, to, from, "peer-heard")
  if (edge.room.phones[to]!.queue.length > 0) {
    throw new Error("unreachable: markSeen queued a choice before statement delivery")
  }
  const extra = edge.extra(to, from)
  const departed = extra.left.includes(frame.from)
  const holder = departed ? null : extra.heldRemote ?? extra.answering ?? answerSetting(room, to, from)
  const held = holder !== null && holder !== frame.from ? holder : null
  const initiator = edge.room.halves[to]![from]!.actor.initiator
  const key = departed
    ? "description:departed"
    : frame.kind === "offer"
      ? held !== null ? "description:statement-offer:new-session" : initiator ? "description:statement-offer:from-answerer" : "description:statement-offer"
      : held !== null ? "description:statement-answer:new-session" : "description:statement-answer"
  if (!departed) {
    if (held !== null) {
      extra.left.push(held)
      if (extra.left.length > LEFT_KEPT) extra.left.shift()
    }
    extra.inbound = frame.from
    extra.inboundGen = frame.gen
  }
  if (sub(edge, to, from, key)) return
  if (departed) {
    fallback(edge, to, from, key, "a description from a left connection before this link negotiated", (world) => ({ type: "description-observed", departedSession: true, lane: false, description: frame.kind, ...stamp(world) }))
    return
  }
  const world = project(room, to, from)
  const why = held !== null
    ? `a ${frame.kind} from another remote connection while the link reads ${world.facts.browserConnectionState}${world.facts.localDescription || world.facts.remoteDescription ? "" : ", not negotiated"}${frame.kind === "answer" && world.mesh.localOfferWire !== "statement" ? ", with no statement offer of ours" : ""}`
    : frame.kind === "answer" ? `an answer with our local offer on ${world.mesh.localOfferWire ?? "no wire"}` : "an offer the alphabet does not build here"
  fallback(edge, to, from, key, why, (target) => meshStatement(target, frame.kind, held !== null))
}

/** Mesh's answerSetting (#1777): the remote connection of the statement answer this half's current connection is still setting, the latest one, or null. */
function answerSetting(room: Room, i: number, j: number): ConnId | null {
  const world = room.halves[i]![j]!
  const srd = room.extras[i]![j]!.srd
  for (let k = srd.length - 1; k >= 0; k--) {
    const entry = world.pending.find((pending) => pending.commandEpoch === srd[k]!.commandEpoch)
    if (entry?.description === "answer" && entry.connectionEpoch === world.meshConnectionEpoch) return srd[k]!.from
  }
  return null
}

function publish(edge: Edge, i: number, j: number, key: string): void {
  const room = edge.room
  const id = halfId(room, i, j)
  if (key === "complete:send-offer:statement:resolved") {
    // send(): a new local offer mints a new generation
    const extra = edge.extra(i, j)
    extra.offers += 1
    extra.out = { by: i, session: room.phones[i]!.session, n: extra.offers }
    edge.slots()[i]![j] = { kind: "offer", from: id, gen: extra.out, readBy: null, publishedAt: room.now }
  } else if (key === "complete:send-answer:statement:resolved") {
    // send(): an answer echoes the gen of the offer it answers (Mesh hands it back, F7), else the last adopted one
    const extra = edge.extra(i, j)
    const gen = extra.answeringGen ?? extra.inboundGen
    if (gen !== null) extra.out = gen
    edge.slots()[i]![j] = { kind: "answer", from: id, gen, readBy: null, publishedAt: room.now }
  } else if (key === "complete:send-offer:lane:resolved" || key === "complete:send-answer:lane:resolved") {
    const lane = edge.lanes()[i]![j]!
    lane.push({ kind: key.includes("send-offer") ? "offer" : "answer", from: id, to: halfId(room, j, i) })
    if (lane.length > LANE_KEPT) throw new Error(`lane ${i}>${j} holds more than ${LANE_KEPT} frames`)
  }
}

/** A completion's bookkeeping on the room side: which statement SRD settled, what it applied (RP6), and the answering entry. */
function settle(edge: Edge, i: number, j: number, key: string, pendingBefore: readonly Pick<PendingCommand, "kind" | "commandEpoch" | "connectionEpoch" | "lane">[]): void {
  const world = edge.room.halves[i]![j]!
  const gone = pendingBefore.filter((entry) => !world.pending.some((now) => now.commandEpoch === entry.commandEpoch))
  // endAnswering ends only this connection's own entry: an answer settling on a replaced connection,
  // or one whose completion rebuilt it (#1786's displaced rejoin), leaves the new connection's (#1797)
  if (key.startsWith("complete:send-answer:statement") && gone.some((entry) => entry.kind === "send-answer" && !entry.lane && entry.connectionEpoch === world.meshConnectionEpoch)) {
    const extra = edge.extra(i, j)
    extra.answering = null
    extra.answeringGen = null
  }
  if (gone.length === 0) return
  const extra = edge.extra(i, j)
  for (const entry of gone) {
    const index = extra.srd.findIndex((srd) => srd.commandEpoch === entry.commandEpoch)
    if (index < 0) continue
    const [srd] = extra.srd.splice(index, 1)
    const applied = key.startsWith("complete:set-remote-description:statement") && key.endsWith(":resolved")
    if (!applied || srd!.from === null) continue
    // RP6 (P1b): one connection applies descriptions from two remote connections
    if (extra.heldRemote !== null && extra.heldRemote !== srd!.from) {
      edge.violations.push({ property: "RP6", detail: `phone ${i}'s connection ${world.meshConnectionEpoch} toward ${j} applied descriptions from two remote connections (${extra.heldRemote} and ${srd!.from})` })
    }
    extra.heldRemote = srd!.from
  }
}

/** The connection-scoped room state no live connection can reach any more. */
function collect(edge: Edge): void {
  const room = edge.room
  for (let i = 0; i < room.n; i++) for (let j = 0; j < room.n; j++) {
    if (i === j) continue
    const lane = room.lanes[i]![j]!
    if (lane.length > 0 && lane.some((frame) => frame.from !== halfId(room, i, j) || frame.to !== halfId(room, j, i))) {
      edge.lanes()[i]![j] = room.lanes[i]![j]!.filter((frame) => frame.from === halfId(room, i, j) && frame.to === halfId(room, j, i))
    }
    const slot = room.slots[i]![j]
    const admitted = room.admitted[j]![i]
    if (slot && admitted !== null && sessionOf(slot.from) < admitted) edge.slots()[i]![j] = null
    const extra = room.extras[i]![j]!
    if (extra.srd.some((srd) => !room.halves[i]![j]!.pending.some((entry) => entry.commandEpoch === srd.commandEpoch))) {
      const own = edge.extra(i, j)
      own.srd = own.srd.filter((srd) => edge.room.halves[i]![j]!.pending.some((entry) => entry.commandEpoch === srd.commandEpoch))
    }
  }
}

/** `from`'s hello read by `to`'s transport: admits its session, raises the peer-session change on a new one, then the peer is heard. False when it is not enabled. */
function hello(edge: Edge, from: number, to: number): boolean {
  const room = edge.room
  if (room.halves[to]![from]!.actor.link === "closed") return false
  const session = room.phones[from]!.session
  const admitted = room.admitted[to]![from]
  if (admitted !== null && admitted > session) return false
  if (admitted === null || admitted < session) edge.admitted()[to]![from] = session
  // a new session starts the peer over (resetNegotiation): our outgoing gen toward it is gone
  if (admitted !== null && admitted < session && room.extras[to]![from]!.out !== null) edge.extra(to, from).out = null
  // onPeerSession is raised at the admission, before the hello's markSeen
  if (admitted !== null && admitted < session) {
    if (!sub(edge, to, from, "peer-session-changed")) return false
    if (edge.room.phones[to]!.queue.length > 0) throw new Error("unreachable: peer-session-changed queued a choice before peer-heard")
  }
  return sub(edge, to, from, "peer-heard")
}

// ── the frozen page clock (ROOM_FROZEN) ──
//
// Mesh's clock is monoNow = performance.now() + 1 (mesh.ts 147): every fact,
// completion and sweep is stamped with it (1050, the runner's clock 1021,
// superviseByActor 2797). The page's hidden time is performance.now() -
// hiddenAt (page-away.ts 24-28). iOS freezes a hidden page (no timer, no event,
// page-lifecycle.ts header) and the monotonic clock stops while the device
// sleeps, so a frozen phone's clock stands still while its peers' run. The room
// keeps one clock, `now`, and per phone a `lag`: phone i reads localNow =
// now - lag, held at frozenAt - lag while frozen; every half of i runs on it.
//
// - vis:<i>:hide: setSelfAway(true) (mesh.ts 1768-1790): each half takes
//   visibility-changed hidden (the actor stops counting stalls, peer-actor.ts
//   853-857), and on each open channel the away frame goes out
//   (encodeAway(true), 1789), which the peer reads as peer-away:said (setAway
//   "said"). The frame is read in the same edge (a simplification: iOS lets a
//   page send only before it suspends). A channel that opens while the page is
//   hidden carries it then (1664). supervise() does nothing while the page is
//   hidden (2796): the room's sweeps skip a hidden half already (drain).
//   vis:<i>:hide-quiet is the same hide whose away frames never arrive (the
//   page froze before the channel flushed them): its peers learn of it only
//   from the silence.
// - vis:<i>:freeze: the page is suspended. No event fires (page-lifecycle.ts).
//   From here phone i takes no label: no timer (tick, advance, beat), no read
//   (hello, statement and lane deliveries to it wait in the store and on the
//   channel), no browser report (ICE, channel). Its frames already written
//   still reach its peers. Its overdue timers are not overdue on thaw: its
//   clock did not move.
// - ice:<j>><i>:silent: while i is frozen for at least ICE_SILENT_MS, j's
//   connection to i loses consent and reads disconnected; frozen for
//   ICE_CONSENT_EXPIRY_MS, a disconnected one reads failed (RFC 7675 consent
//   expiry). Not a fault: the freeze causes it. Once i is back the link may
//   come up again: a disconnected one by itself (ice:<lo>-<hi>:up), a failed
//   one only after an ICE restart or on a new connection (consentLost).
// - vis:<i>:show: the page thaws (lag grows by the frozen time) and is
//   visible again: setSelfAway(false, hiddenForMs) with hiddenForMs =
//   localNow - hiddenAt (page-away.ts 28), which leaves out every frozen
//   millisecond. Each half takes visibility-changed shown with it; above
//   KICK_AFTER_HIDDEN_MS (8 s) the actor forgives and sweeps (peer-actor.ts
//   858-865) and Mesh supervises once (sweepAfterKick, 1786-1798). Each open
//   channel carries the back frame (encodeAway(false)), the peer's
//   peer-away:back.
// One page is frozen at a time; a hidden page does not reload.

/** j's connection to a frozen i reads disconnected once its consent checks have failed this long (ICE consent freshness, RFC 7675: a few seconds with no response). */
const ICE_SILENT_MS = 5_000
/** ... and reads failed once consent has expired (RFC 7675: 30 s). */
export const ICE_CONSENT_EXPIRY_MS = 30_000

/** Is the label one a frozen phone cannot take (it names the frozen phone as the one acting or reading)? */
function frozenBlocks(room: Room, label: string): boolean {
  const parts = label.split(":")
  const pair = /^\w+:(\d+)([>@-])(\d+)/.exec(label)
  const frozen = (k: number) => isFrozen(room, k)
  switch (parts[0]) {
    case "vis":
      return false
    case "h":
      return frozen(Number(pair![1]))
    case "hello":
      return frozen(Number(pair![1])) || frozen(Number(pair![3]))
    case "w":
    case "lane":
      // the frozen sender's frames are already written; a frozen receiver reads nothing
      return frozen(Number(pair![3]))
    case "ice":
      if (parts[2] === "silent") return frozen(Number(pair![1]))
      return frozen(Number(pair![1])) || (pair![2] === "-" && frozen(Number(pair![3])))
    case "chan":
      return frozen(Number(pair![1])) || frozen(Number(pair![3]))
    default:
      return frozen(Number(parts[1]))
  }
}

/** A room-built fact on half (i, j), run as Mesh dispatches it, recorded as a room record (never compared: the actor alphabet's own entry moves its clock). Queued behind a choice the phone already holds. */
function roomFact(edge: Edge, i: number, j: number, key: string, make: (world: ActorWorld) => PeerActorEvent | null): void {
  const before = project(edge.room, i, j)
  const world = cloneWorld(before)
  const event = make(world)
  if (!event) return
  if (edge.room.phones[i]!.queue.length > 0) {
    edge.phone(i).queue.push({ peer: j, item: { type: "event", event } })
    return
  }
  world.queue = []
  openRecord(edge, i, j, `room:${key}`, "gap", before)
  edge.setHalf(i, j, world)
  run(edge, i, j, event)
  drain(edge, i)
  closeRecords(edge, i)
}

/** The away frame on the open channel from i to j, read by j (setAway "said" or back). */
function awayFrame(edge: Edge, i: number, j: number, key: "peer-away:said" | "peer-away:back"): void {
  if (!edge.room.halves[i]![j]!.facts.laneOpen || isFrozen(edge.room, j)) return
  if (edge.room.phones[j]!.queue.length > 0) throw new Error(`unreachable: phone ${j} is busy when ${i}'s away frame arrives`)
  sub(edge, j, i, key)
}

/** vis:<i>:<hide|freeze|show>; false when not enabled. */
function visibility(edge: Edge, i: number, action: string): boolean {
  const room = edge.room
  const phone = room.phones[i]!
  if (!phone.freezable) return false
  if (room.phones.some((other, k) => k !== i && other.frozenAt !== undefined)) return false
  const peers = Array.from({ length: room.n }, (_, j) => j).filter((j) => j !== i)
  if (action === "hide" || action === "hide-quiet") {
    if (phone.hiddenAt !== undefined) return false
    edge.phone(i).hiddenAt = localNow(room, i)
    // its supervise() does nothing from now (mesh.ts 2796): a sweep it owed is no longer owed
    edge.phone(i).owesSweep = false
    broadcast(edge, i, "visibility:hide", (j) => {
      const built = ENTRY.get("visibility:hide")!.build(project(edge.room, i, j))
      return built ? { type: "event", event: built.event } : null
    })
    if (action === "hide") for (const j of peers) awayFrame(edge, i, j, "peer-away:said")
    return true
  }
  if (action === "freeze") {
    if (phone.hiddenAt === undefined || phone.frozenAt !== undefined) return false
    edge.phone(i).frozenAt = room.now
    return true
  }
  if (action !== "show" || phone.hiddenAt === undefined) return false
  const own = edge.phone(i)
  if (own.frozenAt !== undefined) {
    own.lag = (own.lag ?? 0) + room.now - own.frozenAt
    delete own.frozenAt
  }
  const hiddenForMs = localNow(edge.room, i) - own.hiddenAt!
  delete own.hiddenAt
  for (const j of peers) {
    roomFact(edge, i, j, "visibility:show", (world) => (world.actor.hidden ? { type: "visibility-changed", hidden: false, hiddenForMs, ...stamp(world) } : null))
  }
  for (const j of peers) awayFrame(edge, i, j, "peer-away:back")
  // after a long absence the links are swept together (sweepAfterKick): the actors' sweep commands ran above
  if (hiddenForMs > KICK_AFTER_HIDDEN_MS) sweep(edge, i)
  return true
}

const isFaultEntry = (key: string): boolean => ENTRY.get(key)?.fault === true

/** The label's successor, or null when it is not enabled (or is a fault past the budget). */
export function step(room: Room, label: string, options: StepOptions = {}): Successor | null {
  const n = room.n
  const parts = label.split(":")
  const family = parts[0]!
  let fault = false
  const busy = room.phones.some((phone) => phone.queue.length > 0)
  if (busy && family !== "choice") return null
  if (room.phones.some((phone) => phone.frozenAt !== undefined) && frozenBlocks(room, label)) return null
  const edge = new Edge(room, options.inclusion ?? false)
  const charge = (): boolean => {
    fault = true
    return !options.noFaults && room.faultsLeft > 0
  }

  switch (family) {
    case "choice": {
      const i = Number(parts[1])
      const outcome = parts[2]!
      const head = room.phones[i]!.queue[0]
      if (head?.item.type !== "choice") return null
      if (outcome === "rejected" && !charge()) return null
      const j = head.peer
      edge.phone(i).queue.shift()
      // the choice's build sees only its own head: its other items stay in the phone's FIFO
      const before = project(room, i, j)
      const entry = ENTRY.get(`complete:restart-ice:${outcome}`)!
      const view = cloneWorld(before)
      view.queue = [head.item]
      const built = entry.build(view)
      if (!built) return null
      openRecord(edge, i, j, entry.key, "entry", before)
      built.world.queue = []
      edge.setHalf(i, j, built.world)
      // restartIce() ran: a consent-expired connection gathers afresh and may connect again (the frozen clock)
      if (outcome === "resolved" && room.extras[i]![j]!.consentLost) delete edge.extra(i, j).consentLost
      run(edge, i, j, built.event)
      drain(edge, i)
      closeRecords(edge, i)
      break
    }
    case "h": {
      const [i, j] = pairOf(label)
      const key = parts.slice(2).join(":")
      const world = room.halves[i]![j]!
      if (key === "codec-guard-rtx") {
        if (!codecGuardStart(edge, i, j)) return null
        break
      }
      // a stray lane answer's "other" is uncharged and its only outcome (below): it stays
      if (noLaneOther && key.endsWith(":rejected:lane:other") && !(key.startsWith("complete:set-remote-description:lane-answer:") && world.mesh.signaling !== "have-local-offer")) return null
      const guarded = codecGuardComplete(edge, i, j, key, charge)
      if (guarded === false) return null
      if (guarded) break
      // the guard's rollback settles before its send-offer may (guardOfferForActor 4212)
      const rolling = key.startsWith("complete:rollback:") ? guardOf(room, i, j) : null
      // an answer applied to a connection with no local offer (the fallback's answer from the store to a fresh page) can only fail, with InvalidStateError: not a fault, and never resolved
      const strayAnswer = /^complete:set-remote-description:(statement|lane)-answer:/.test(key) && world.mesh.signaling !== "have-local-offer"
      if (strayAnswer && key.endsWith(":resolved")) return null
      if (strayAnswer && !key.endsWith(":other")) return null
      // makeStatementOffer's stale bail needs a remote offer rolled in during the gather: in the room that offer is caused, so the bail is enabled only when one was taken
      if (key === "complete:send-offer:statement:stale" && !(world.mesh.signaling === "have-remote-offer" || world.pending.some((entry) => entry.kind === "set-remote-description" && !entry.lane && entry.description !== "answer"))) return null
      const stale = key === "complete:send-answer:lane:stale:lane"
        ? { pending: world.pending.find((entry) => entry.kind === "send-answer" && entry.lane === true), site: "lane" as const }
        : key === "complete:send-offer:lane:stale:lane"
          ? { pending: world.pending.find((entry) => entry.kind === "send-offer" && entry.lane === true), site: "lane" as const }
          : key === "complete:send-answer:statement:stale:statement-answer" || key === "complete:send-answer:statement:stale:statement-answer:displaced"
            // the answer the alphabet completes (the oldest on the current connection), else one a replaced connection left
            ? { pending: world.pending.find((entry) => entry.kind === "send-answer" && !entry.lane && entry.connectionEpoch === world.meshConnectionEpoch) ?? world.pending.find((entry) => entry.kind === "send-answer" && !entry.lane), site: "statement-answer" as const }
            : null
      if (stale) {
        const pending = stale.pending
        if (!pending) return null
        const epochMoved = pending.connectionEpoch !== world.meshConnectionEpoch
        const roundMoved = pending.roundGeneration !== undefined && pending.roundGeneration !== world.actor.roundGeneration
        const laneClosed = !world.facts.laneOpen
        const crossedLaneOffer = pending.kind === "send-offer" && pending.lane === true && (
          world.mesh.signaling === "have-remote-offer"
          || world.pending.some((entry) => entry.kind === "set-remote-description" && entry.lane === true && entry.description === "offer" && entry.commandEpoch > pending.commandEpoch)
        )
        const heldOfferMoved = pending.kind === "send-answer" && !pending.lane && edge.room.extras[i]![j]!.answering !== edge.room.extras[i]![j]!.inbound
        // sendStatementAnswer (#1786): "stale" when the PC moved on or a newer offer was applied; else
        // "displaced" when its setLocalDescription made no answer, our own offer having taken the
        // connection out of have-remote-offer
        const displaced = key.endsWith(":displaced")
        const allowed = pending.lane
          ? epochMoved || roundMoved || laneClosed || crossedLaneOffer
          : displaced ? !epochMoved && !heldOfferMoved && world.mesh.signaling !== "have-remote-offer" : epochMoved || heldOfferMoved
        if (!allowed) return null
      }
      if (isFaultEntry(key) && !strayAnswer && !charge()) return null
      // frames advance only on a matched, connected link whose lane carried the remote tracks
      if ((key === "stats:advance" || key === "stats:probe") && !(matched(room, i, j) && world.mesh.laneMedia)) return null
      const pendingBefore = world.pending.map(({ kind, commandEpoch, connectionEpoch, lane }) => ({ kind, commandEpoch, connectionEpoch, lane }))
      if (!sub(edge, i, j, key)) {
        if (!stale?.pending || stale.pending.connectionEpoch === world.meshConnectionEpoch || !completeMovedStale(edge, i, j, key, stale.pending, stale.site)) return null
      }
      if (key.startsWith("complete:")) {
        // publish first: an answer echoes the answering entry's gen, which settle ends
        publish(edge, i, j, key)
        settle(edge, i, j, key, pendingBefore)
      }
      if (rolling && rolling.rolled === null && edge.room.halves[i]![j]!.meshConnectionEpoch === rolling.epoch) edge.extra(i, j).guard = { ...rolling, rolled: key === "complete:rollback:resolved" }
      break
    }
    case "hello": {
      const [from, to] = pairOf(label)
      if (!hello(edge, from, to)) return null
      break
    }
    case "beat": {
      // the phone's heartbeat: its hello reaches every peer at one instant (a peer that cannot read it is skipped)
      const i = Number(parts[1])
      if (!room.beat || beatDueAt(room, i) > localNow(room, i)) return null
      for (let j = 0; j < n; j++) if (j !== i && !isFrozen(room, j)) hello(edge, i, j)
      edge.phone(i).lastBeat = localNow(room, i)
      break
    }
    case "w": {
      const [from, to] = pairOf(label)
      const frame = deliverable(room, from, to)
      if (!frame) return null
      if (parts[2] === "drop") {
        const receiver = room.halves[to]![from]!
        if (receiver.facts.browserConnectionState !== "connected" || !receiver.facts.laneOpen || room.now - frame.publishedAt <= DROP_DELAY_MS) return null
        if (!charge()) return null
        edge.slots()[from]![to] = null
        break
      }
      deliverStatement(edge, from, to, frame)
      break
    }
    case "lane": {
      const [from, to] = pairOf(label)
      const frame = room.lanes[from]![to]![0]
      if (!frame || !room.halves[to]![from]!.facts.laneOpen) return null
      edge.lanes()[from]![to]!.shift()
      const initiator = room.halves[to]![from]!.actor.initiator
      const key = frame.kind === "answer" ? "description:lane-answer" : initiator ? "description:lane-offer:from-answerer" : "description:lane-offer"
      if (!sub(edge, to, from, key)) edge.gaps.push({ phone: to, peer: from, key, why: `a lane ${frame.kind} the alphabet refuses (local offer on ${room.halves[to]![from]!.mesh.localOfferWire ?? "no wire"}): dropped` })
      break
    }
    case "ice": {
      const [a, b] = pairOf(label)
      const kind = parts[2]!
      if (kind === "silent") {
        // a's connection to the frozen b loses consent (the frozen clock, above)
        const frozenAt = room.phones[b]!.frozenAt
        if (frozenAt === undefined || room.now - frozenAt < ICE_SILENT_MS) return null
        const state = room.halves[a]![b]!.facts.browserConnectionState
        if (state === "connected") {
          if (!sub(edge, a, b, "connection-observed:disconnected")) return null
        } else if (state === "disconnected" && room.now - frozenAt >= ICE_CONSENT_EXPIRY_MS) {
          if (!sub(edge, a, b, "connection-observed:failed")) return null
          // RFC 7675 5.1: once consent expires the agent stops sending on the pair and the
          // transport stays failed; the W3C state machine leaves "failed" only through an ICE
          // restart (restartIce) or a new RTCPeerConnection, never by itself
          if (edge.room.halves[a]![b]!.meshConnectionEpoch === room.halves[a]![b]!.meshConnectionEpoch) edge.extra(a, b).consentLost = true
        } else return null
        break
      }
      if (kind === "lost") {
        // the far end's connection is gone (a reload, a rebuild): the old PC loses its link
        const state = room.halves[a]![b]!.facts.browserConnectionState
        if (matched(room, a, b) || (state !== "connected" && state !== "disconnected")) return null
        if (!sub(edge, a, b, state === "connected" ? "connection-observed:disconnected" : "connection-observed:failed")) return null
        break
      }
      if (!matched(room, a, b)) return null
      const sides: [number, number][] = [[a, b], [b, a]]
      if (kind === "up") {
        // a consent-expired connection waits for an ICE restart (ice:silent above)
        if (sides.some(([i, j]) => room.extras[i]![j]!.consentLost)) return null
        if (sides.every(([i, j]) => room.halves[i]![j]!.facts.browserConnectionState === "connected")) return null
        for (const [i, j] of sides) if (room.halves[i]![j]!.facts.browserConnectionState !== "connected") sub(edge, i, j, "connection-observed:connected")
        break
      }
      // drop: the matched link's ICE goes down on both ends (one fault)
      if (!sides.every(([i, j]) => room.halves[i]![j]!.facts.browserConnectionState === "connected")) return null
      if (!charge()) return null
      for (const [i, j] of sides) sub(edge, i, j, "connection-observed:disconnected")
      break
    }
    case "chan": {
      const [a, b] = pairOf(label)
      const x = room.halves[a]![b]!
      const y = room.halves[b]![a]!
      if (!matched(room, a, b) || x.facts.browserConnectionState !== "connected" || y.facts.browserConnectionState !== "connected") return null
      if (x.facts.laneOpen || y.facts.laneOpen || !(x.facts.hasChannel || y.facts.hasChannel)) return null
      sub(edge, a, b, "channel-observed:open")
      sub(edge, b, a, "channel-observed:open")
      // a page hidden when its channel opens says so on it (mesh.ts 1664)
      if (room.phones[a]!.hiddenAt !== undefined) awayFrame(edge, a, b, "peer-away:said")
      if (room.phones[b]!.hiddenAt !== undefined) awayFrame(edge, b, a, "peer-away:said")
      break
    }
    case "tick": {
      const i = Number(parts[1])
      if (!sweepDue(room, i)) return null
      sweep(edge, i)
      break
    }
    case "advance":
    case "advance-jb": {
      const i = Number(parts[1])
      if (room.phones.some((phone) => phone.owesSweep)) return null
      if (beatDue(room)) return null
      const next = nextRoomDeadline(room)
      if (next === null) return null
      const at = family === "advance" ? next : next - 1
      if (at <= room.now) return null
      edge.room.now = at
      // a hidden page's supervise() does nothing (mesh.ts 2796), so it owes no sweep
      for (let k = 0; k < n; k++) if (k !== i && room.phones[k]!.hiddenAt === undefined) edge.phone(k).owesSweep = true
      sweep(edge, i)
      break
    }
    case "vis":
      if (!visibility(edge, Number(parts[1]), parts[2]!)) return null
      break
    case "ph": {
      const i = Number(parts[1])
      // a hidden page does not reload (the frozen clock, above)
      if (parts[2] === "reload" && room.phones[i]!.hiddenAt !== undefined) return null
      if (!charge()) return null
      if (parts[2] === "network") {
        broadcast(edge, i, "network-changed", (j) => {
          const built = ENTRY.get("network-changed")!.build(project(edge.room, i, j))
          return built ? { type: "event", event: built.event } : null
        })
        break
      }
      // reload: a new page boot, a new session, fresh actors (startActor), a fresh transport receive side; the store keeps every frame
      const phone = edge.phone(i)
      phone.session += 1
      phone.queue = []
      phone.owesSweep = false
      if (room.beat) phone.lastBeat = null
      const admitted = edge.admitted()
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        edge.setHalf(i, j, freshHalf(i, j))
        const old = edge.room.extras[i]![j]!
        edge.room.extras[i]![j] = { ...emptyExtra(), ended: [...old.ended, { session: phone.session - 1, offers: old.offers }] }
        admitted[i]![j] = null
      }
      break
    }
    default:
      throw new Error(`unknown room label ${label}`)
  }
  if (fault) edge.room.faultsLeft -= 1
  closeRecords(edge, null)
  collect(edge)
  return { room: edge.room, edge, fault }
}

/** Walks room labels; throws at one that is not enabled. */
export function walkRoom(room: Room, labels: readonly string[], options: StepOptions = {}): Room {
  let at = room
  for (const [index, label] of labels.entries()) {
    const next = step(at, label, options)
    if (!next) throw new Error(`${label} is not enabled after ${labels.slice(0, index).join(", ") || "the start"}`)
    at = next.room
  }
  return at
}
