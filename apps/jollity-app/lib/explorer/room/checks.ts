// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The room-level properties of slice 1, the inclusion
 * check, the fair scheduler (RP10's continuation and the steady-3
 * anchor) and the anchors.
 *
 * Checked on every edge: peer.definition's invariants on every actor step (as actor/bfs
 * does), RP1, RP2, RP4, RP6 (raised in model.ts where the SRD settles), RP7.
 * At every quiet state: RP3 and RP4's role check. From sampled states: RP10.
 * RP5 (three-way glare), RP8 (away) and RP9 (bundle loss) need labels slice 1
 * does not have.
 */
import { stepPeerActor, type PeerActorState } from "../../state-machines/peer-actor"
import { peerMachineDefinition, type PeerEventKey, type PeerObservation, type PeerTestEvent } from "../../state-machines/peer.definition"
import { checkStep, type MachineDefinition, type TraceEntry } from "../../state-machines/framework"
import { invariantKey, successor } from "../actor/bfs"
import { canonical } from "../actor/canon"
import { cloneWorld, type ActorWorld } from "../actor/world"
import { candidateLabels, ENTRY, initialRoom, localNow, matched, pairsOf, quiet, step, type Edge, type InclusionRecord, type Room, type RoomViolation } from "./model"

// ── peer.definition's invariants (property D0), as actor/bfs.ts's checker ──

type Definition = MachineDefinition<PeerActorState, PeerActorState, PeerTestEvent, ReturnType<typeof stepPeerActor>, ReturnType<typeof stepPeerActor>, PeerObservation, "world", "*">

const definition: Definition = (() => {
  const run = (state: PeerActorState, test: PeerTestEvent) => {
    const output = stepPeerActor(state, test.event)
    return { state: output.state, output }
  }
  const start = () => initialRoom(2, 0).halves[0]![1]!.actor
  return {
    name: "peer-actor-room",
    initialReal: start,
    initialModel: start,
    realStep: run,
    modelStep: run,
    classifyRealStep: () => "transition",
    observeReal: (result) => peerMachineDefinition.observeReal({ state: result.state, output: result.output }),
    observeModel: (result) => peerMachineDefinition.observeReal({ state: result.state, output: result.output }),
    realStateKey: () => "world",
    modelStateKey: () => "world",
    eventKey: () => "*",
    transitionTable: { world: { "*": "transition" } },
    witnesses: [],
    regressions: [],
    invariants: peerMachineDefinition.invariants as unknown as Definition["invariants"],
  }
})()

/** peer.definition's invariants over every actor step of the edge. */
export function invariantViolations(edge: Edge, label: string): RoomViolation[] {
  const out: RoomViolation[] = []
  for (const actorStep of edge.steps) {
    try {
      const key = invariantKey(actorStep.event, actorStep.before)
      checkStep({ definition, real: actorStep.before, model: actorStep.before, event: { key: key as PeerEventKey, event: actorStep.event }, step: 0, label, trace: [] as TraceEntry<PeerTestEvent, PeerObservation, "world", "*">[] })
    } catch (error) {
      out.push({ property: "D0", detail: `phone ${actorStep.phone} toward ${actorStep.peer}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` })
    }
  }
  return out
}

// ── RP1, RP2: locality ──

/** The halves a label may change: those it names, plus any half whose items already waited in that phone's FIFO (a choice's drain runs them). */
function allowedHalves(parent: Room, label: string): { phones: Set<number>; halves: Set<string> } {
  const parts = label.split(":")
  const halves = new Set<string>()
  const phones = new Set<number>()
  const add = (i: number, j: number) => {
    halves.add(`${i},${j}`)
    phones.add(i)
  }
  const all = (i: number) => {
    for (let j = 0; j < parent.n; j++) if (j !== i) add(i, j)
  }
  const pair = /^\w+:(\d+)([>@-])(\d+)/.exec(label)
  switch (parts[0]) {
    case "choice": {
      const i = Number(parts[1])
      for (const entry of parent.phones[i]!.queue) add(i, entry.peer)
      break
    }
    case "h":
      add(Number(pair![1]), Number(pair![3]))
      break
    case "hello":
    case "w":
    case "lane":
      add(Number(pair![3]), Number(pair![1]))
      break
    case "ice":
    case "chan":
      add(Number(pair![1]), Number(pair![3]))
      if (pair![2] === "-") add(Number(pair![3]), Number(pair![1]))
      break
    case "tick":
    case "advance":
    case "advance-jb":
    case "ph":
      all(Number(parts[1]))
      break
    case "beat":
      // phone i's hello is read by every peer: each peer's half toward i
      for (let j = 0; j < parent.n; j++) if (j !== Number(parts[1])) add(j, Number(parts[1]))
      break
    case "vis":
      // the phone's own halves, and each peer's half toward it (the away frame)
      all(Number(parts[1]))
      for (let j = 0; j < parent.n; j++) if (j !== Number(parts[1])) add(j, Number(parts[1]))
      break
  }
  return { phones, halves }
}

export function localityViolations(parent: Room, edge: Edge, label: string): RoomViolation[] {
  const out: RoomViolation[] = []
  const allowed = allowedHalves(parent, label)
  for (let i = 0; i < parent.n; i++) for (let j = 0; j < parent.n; j++) {
    if (i === j || edge.room.halves[i]![j] === parent.halves[i]![j]) continue
    if (canonical({ ...edge.room.halves[i]![j]!, now: 0, queue: [] }) === canonical({ ...parent.halves[i]![j]!, now: 0, queue: [] })) continue
    if (allowed.halves.has(`${i},${j}`)) continue
    out.push(allowed.phones.has(i)
      ? { property: "RP2", detail: `${label} changed phone ${i}'s half toward ${j}, another pair of the same phone` }
      : { property: "RP1", detail: `${label} changed phone ${i}'s half toward ${j}, outside the phones it names` })
  }
  return out
}

// ── RP3, RP4: consistency at quiet states ──

export function quietViolations(room: Room): RoomViolation[] {
  if (!quiet(room)) return []
  const out: RoomViolation[] = []
  for (let i = 0; i < room.n; i++) {
    const rounds = new Set<number>()
    for (let j = 0; j < room.n; j++) {
      if (i === j) continue
      const actor = room.halves[i]![j]!.actor
      if (actor.initiator !== i < j) out.push({ property: "RP3", detail: `phone ${i}'s half toward ${j} has initiator ${actor.initiator}` })
      if (actor.link === "closed") continue
      // every half follows its phone's page (the frozen clock's vis labels; without them every phone is shown)
      const pageHidden = room.phones[i]!.hiddenAt !== undefined
      if (actor.hidden && !pageHidden) out.push({ property: "RP3", detail: `phone ${i}'s half toward ${j} is hidden while the phone is shown` })
      if (!actor.hidden && pageHidden) out.push({ property: "RP3", detail: `phone ${i}'s half toward ${j} is shown while the phone is hidden` })
      rounds.add(actor.roundGeneration)
    }
    if (rounds.size > 1) out.push({ property: "RP3", detail: `phone ${i}'s halves disagree on the round (${[...rounds].join(", ")})` })
  }
  for (const [lo, hi] of pairsOf(room.n)) {
    const a = room.halves[lo]![hi]!.actor.initiator
    const b = room.halves[hi]![lo]!.actor.initiator
    if (a === b) out.push({ property: "RP4", detail: `pair ${lo}-${hi} has ${a ? "two initiators" : "no initiator"}` })
  }
  return out
}

// ── RP7: one rejoin, another pair ──

/** RP7, made precise: on a path with no fault past the anchor (the reload of `reloaded` is the anchor's), a half of a pair without the reloaded phone issues replace-connection or restart-ice from any fact but a stats read. Stats reads are free network weather in the actor alphabet (a stall heal on that pair is not the reload's doing), so they are left out. */
export function rp7Violations(edge: Edge, room: Room, options: { reloaded: number; faults: number }): RoomViolation[] {
  if (room.faultsLeft < options.faults) return []
  const out: RoomViolation[] = []
  for (const { phone, peer, command, event } of edge.commands) {
    if (phone === options.reloaded || peer === options.reloaded) continue
    if (command.kind !== "replace-connection" && command.kind !== "restart-ice") continue
    if (event.type === "stats-observed") continue
    out.push({ property: "RP7", detail: `phone ${phone}'s half toward ${peer} issued ${command.kind}:${command.cause} on ${event.type}, with no fault past phone ${options.reloaded}'s reload` })
  }
  return out
}

// ── inclusion (5.1) ──

export interface InclusionResult {
  /** sub-sequences compared with the actor explorer's successor */
  checked: number
  /** sub-sequences whose drain had not finished at the end of the edge (another half's choice ahead) */
  deferred: number
  /** sub-sequences recorded but left out by the sample */
  skipped: number
  /** the room's own fallbacks: counted as inclusion gaps, never compared */
  gaps: number
  /** halves that ran an actor step in the edge, and how many of them have a sub-sequence */
  stepped: number
  covered: number
  mismatches: { phone: number; peer: number; key: string; detail: string }[]
}

const normal = (world: ActorWorld): string => canonical({ ...world, faultsLeft: 0 })

/** Each half's sub-sequence must be an edge of the single-actor graph: the actor explorer's successor from the projected world before it gives the same canonical world as the room after its drain. Every half that ran an actor step must have a sub-sequence, and every step must belong to one (coverage). `sample` picks which sub-sequences are compared. */
export function inclusion(edge: Edge, sample: (record: InclusionRecord) => boolean = () => true): InclusionResult {
  const result: InclusionResult = { checked: 0, deferred: 0, skipped: 0, gaps: 0, stepped: 0, covered: 0, mismatches: [] }
  const stepped = new Set(edge.steps.map((actorStep) => `${actorStep.phone},${actorStep.peer}`))
  const recorded = new Set(edge.inclusion.filter((record) => record.steps > 0).map((record) => `${record.phone},${record.peer}`))
  result.stepped = stepped.size
  for (const half of stepped) {
    if (recorded.has(half)) result.covered += 1
    else {
      const [phone, peer] = half.split(",").map(Number) as [number, number]
      result.mismatches.push({ phone, peer, key: "coverage", detail: "the half ran actor steps that no sub-sequence records" })
    }
  }
  if (edge.unattributed > 0) result.mismatches.push({ phone: -1, peer: -1, key: "coverage", detail: `${edge.unattributed} actor steps ran outside any sub-sequence` })
  for (const record of edge.inclusion) {
    if (record.kind === "gap") {
      result.gaps += 1
      continue
    }
    if (!record.after) {
      result.deferred += 1
      continue
    }
    if (!sample(record)) {
      result.skipped += 1
      continue
    }
    result.checked += 1
    const entry = ENTRY.get(record.key)
    if (!entry) {
      result.mismatches.push({ phone: record.phone, peer: record.peer, key: record.key, detail: "a drained item the actor alphabet has no entry for" })
      continue
    }
    const actor = successor(cloneWorld(record.before), entry)
    if (!actor) {
      result.mismatches.push({ phone: record.phone, peer: record.peer, key: record.key, detail: "the actor explorer does not enable this entry in the projected world" })
      continue
    }
    if (normal(actor.world) !== normal(record.after)) {
      result.mismatches.push({ phone: record.phone, peer: record.peer, key: record.key, detail: "the half's world differs from the actor explorer's successor" })
    }
  }
  return result
}

// ── the fair scheduler ──

/** A pair connected, its lane open and negotiated, nothing pending on either half, frames seen: what RP10 waits for. */
export function steadyPair(room: Room, lo: number, hi: number): boolean {
  if (!matched(room, lo, hi)) return false
  for (const [i, j] of [[lo, hi], [hi, lo]] as const) {
    const world = room.halves[i]![j]!
    const mayOffer = world.actor.initiator || world.mesh.leave
    // the browser's link and the lane decide steadiness, as the world reads them
    if (world.actor.link === "closed" || world.facts.browserConnectionState !== "connected" || !world.facts.laneOpen) return false
    if (!world.mesh.laneMedia || world.mesh.signaling !== "stable" || world.pending.length > 0 || world.facts.framesSeen === 0) return false
    if (mayOffer && world.mesh.negotiationNeeded) return false
  }
  return room.lanes[lo]![hi]!.length === 0 && room.lanes[hi]![lo]!.length === 0
}

export const steadyRoom = (room: Room): boolean => quiet(room) && pairsOf(room.n).every(([lo, hi]) => steadyPair(room, lo, hi))

/** The fair scheduler's preference, highest first: a choice resolves well, a new session is heard, completions resolve, frames are delivered, links come up, offers are made, frames flow, the peers beat, the clock moves last. */
function fairRank(room: Room, label: string): number {
  const parts = label.split(":")
  switch (parts[0]) {
    case "choice":
      return parts[2] === "resolved" ? 0 : -1
    case "hello": {
      const [from, to] = parts[1]!.split("@").map(Number) as [number, number]
      const admitted = room.admitted[to]![from]
      if (admitted !== room.phones[from]!.session) return 1
      return room.halves[to]![from]!.facts.lastSignalAt === localNow(room, to) ? -1 : 8
    }
    case "h": {
      const key = parts.slice(2).join(":")
      const [i, j] = parts[1]!.split(">").map(Number) as [number, number]
      // the stray answer's InvalidStateError is no fault: it is the only way that SRD settles
      if (/^complete:set-remote-description:(statement|lane)-answer:rejected:.*:other$/.test(key) && room.halves[i]![j]!.mesh.signaling !== "have-local-offer") return 3
      if (ENTRY.get(key)?.fault) return -1
      if (key.startsWith("complete:")) return key.endsWith(":resolved") ? 2 : 3
      if (key === "local-offer-requested") return 6
      if (key === "stats:no-video-deadline") {
        const world = room.halves[i]![j]!
        return !world.mesh.laneMedia && world.actor.budgets.noVideoRebuilds === 0 ? 7 : -1
      }
      if (key === "stats:advance") {
        return room.halves[i]![j]!.facts.framesSeen === 0 ? 7 : -1
      }
      return -1
    }
    case "w":
      return parts[2] === "deliver" ? 4 : -1
    case "lane":
      return 4
    case "ice":
      return parts[2] === "drop" || parts[2] === "silent" ? -1 : 5
    case "chan":
      return 5
    case "beat":
      return 1
    case "tick":
      return 9
    case "advance":
      return 10
    case "vis":
      // a frozen or hidden page comes back first: nothing else of it can move until then
      return parts[2] === "show" ? 0 : -1
    default:
      return -1
  }
}

/** One fair step, or null when nothing fair is enabled. */
function fairStep(room: Room, rotate = 0): { label: string; room: Room } | null {
  const labels = candidateLabels(room)
  const ranked = labels.map((label) => ({ label, rank: fairRank(room, label) })).filter((entry) => entry.rank >= 0)
  ranked.sort((a, b) => a.rank - b.rank)
  // within a rank, rotate the start so no phone starves
  let at = 0
  while (at < ranked.length) {
    const rank = ranked[at]!.rank
    const group = ranked.filter((entry) => entry.rank === rank)
    for (let k = 0; k < group.length; k++) {
      const label = group[(k + rotate) % group.length]!.label
      const next = step(room, label, { noFaults: true })
      if (next) return { label, room: next.room }
    }
    at += group.length
  }
  return null
}

export interface FairRun {
  steady: boolean
  labels: string[]
  room: Room
  why?: string
}

/** RP10: the fair scheduler with no faults brings every pair to steady within M = 60 steps per pair or 90 s of room time. */
export function fairRun(room: Room, options: { stepsPerPair?: number; horizonMs?: number } = {}): FairRun {
  const limit = (options.stepsPerPair ?? 60) * pairsOf(room.n).length
  const until = room.now + (options.horizonMs ?? 90_000)
  const labels: string[] = []
  let at = room
  for (let count = 0; count < limit; count++) {
    if (steadyRoom(at)) return { steady: true, labels, room: at }
    if (at.now > until) return { steady: false, labels, room: at, why: `past ${options.horizonMs ?? 90_000} ms of room time` }
    const next = fairStep(at, count)
    if (!next) return { steady: false, labels, room: at, why: "nothing fair is enabled" }
    labels.push(next.label)
    at = next.room
  }
  return { steady: steadyRoom(at), labels, room: at, why: steadyRoom(at) ? undefined : `past ${limit} steps` }
}

export function recoveryViolations(room: Room): RoomViolation[] {
  const run = fairRun(room)
  if (run.steady) return []
  const stuck = pairsOf(room.n).filter(([lo, hi]) => !steadyPair(run.room, lo, hi)).map(([lo, hi]) => `${lo}-${hi}`)
  return [{ property: "RP10", detail: `the fair continuation did not bring every pair to steady (${run.why}; not steady: ${stuck.join(", ")}) after ${run.labels.length} labels: ${run.labels.slice(-12).join(" ")}` }]
}

// ── anchors ──

/** steady-n: the fair scheduler from the start until every pair is steady, then every peer heard once more (as the actor's steady anchors end with peer-heard). */
export function steadyAnchor(n: number): { labels: string[]; room: Room } {
  const run = fairRun(initialRoom(n, 99), { stepsPerPair: 80, horizonMs: 120_000 })
  if (!run.steady) throw new Error(`the fair run from the start did not reach steady-${n}: ${run.why}`)
  const labels = [...run.labels]
  let room = run.room
  for (let to = 0; to < n; to++) for (let from = 0; from < n; from++) {
    if (from === to) continue
    const next = step(room, `hello:${from}@${to}`)
    if (next) {
      labels.push(`hello:${from}@${to}`)
      room = next.room
    }
  }
  return { labels, room }
}

export type RoomRun = "reload" | "network-all" | "steady" | "frozen"

/** The run's start: steady-n, then the injected moment: p2's reload, a network change on every phone at one instant, none (`steady`), or the freezable phone hiding and freezing (`frozen`, ROOM_FROZEN; model.ts). Faults are set to F past it. */
export function roomAnchor(n: number, run: RoomRun, faults: number, reloaded = 1): { labels: string[]; room: Room } {
  const steady = steadyAnchor(n)
  let room = steady.room
  const freezable = room.phones.findIndex((phone) => phone.freezable)
  if (run === "frozen" && freezable < 0) throw new Error("the frozen run needs a freezable phone (ROOM_FROZEN)")
  const moment = run === "reload" ? [`ph:${reloaded}:reload`]
    : run === "steady" ? []
      : run === "frozen" ? [`vis:${freezable}:${process.env.ROOM_FROZEN_HIDE ?? "hide"}`, `vis:${freezable}:freeze`]
        : Array.from({ length: n }, (_, i) => `ph:${i}:network`)
  const labels = [...steady.labels]
  for (const label of moment) {
    // a network change on every phone at one instant: each phone's restart choices are taken as resolved before the next phone's change (no time passes)
    let next = step(room, label)
    if (!next) throw new Error(`${label} is not enabled at the anchor`)
    labels.push(label)
    room = next.room
    if (run === "network-all" && label !== moment[moment.length - 1]) {
      while (!quiet(room)) {
        const i = room.phones.findIndex((phone) => phone.queue.length > 0)
        next = step(room, `choice:${i}:resolved`)
        if (!next) throw new Error(`choice:${i}:resolved is not enabled at the anchor`)
        labels.push(`choice:${i}:resolved`)
        room = next.room
      }
    }
  }
  return { labels, room: { ...room, faultsLeft: faults } }
}
