// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The confirm pipeline: an abstract room finding is confirmed on real Mesh,
 * in the two-phone mesh-pair room, with no hand edits.
 *
 * Not a label-by-label translation, which is hard to make faithful. The
 * recipe is the one that confirmed #1562 by hand:
 * 1. **Project**: a finding of an n-phone room is replayed in a 2-phone
 *    room with only the labels of one failing pair. A label no longer enabled
 *    is skipped unless it is a fault; the projected finding must show the same
 *    property again, or the verdict is `abstract-3`.
 * 2. **Skeleton**: the projected schedule's faults, in order. Each gets its
 *    mesh-pair counterpart (the fault table, `counterpart` below) and the shape
 *    of the last event its half accepted before it (actor/shape.ts), weather
 *    (sweeps and stats) left out. A fault with no counterpart makes the
 *    verdict `not-confirmable`, naming it.
 *    A wire drop is not confirmable until mesh-pair sends presence hellos (#1525).
 * 3. **Start**: mesh-pair's `after-reload` anchor when the first fault is the
 *    answerer's reload, else `steady`. A network change (`ph:k:network`) is
 *    `env:network:<side>`, Mesh.networkChanged on that side; a network-all
 *    witness's anchor projects onto its pair as two of them, a's then b's.
 * 4. **Scenario**: `scenarioFrom()` with exactly the rejections and env labels
 *    the skeleton needs. The shared SCENARIOS are never changed.
 * 5. **Drive**: the fair scheduler; the next fault is taken when its
 *    counterpart is enabled and the side's last accepted event has the
 *    recorded shape. After a completion rejection, Mesh must report the same
 *    site and reason, or the skeleton was not realised.
 * 6. **Judge** after a fair drain capped at 200 clock steps (RP10:
 *    `steadyLink`; RP6: a P1b violation), against a control run from the same
 *    anchor with no fault, which must reach the first fault's moment (its
 *    counterpart enabled and the recorded shape last accepted) and must not
 *    show it.
 *
 * Verdicts: `confirmed:mesh-pair`, `refuted` (the skeleton was realised
 * and Mesh does not show the property: a model defect when Mesh accepted the
 * room prefix before the last fault, a translator defect when it did not),
 * `not-confirmable` (a fault with no mesh-pair counterpart yet), `abstract-3`
 * (needs the third phone) and `unconfirmed` (no mesh judge for the property,
 * the witness does not replay, the skeleton was not realised, or the control
 * fails too).
 *
 * The room phones of the projected pair map to mesh-pair's sides by role: the
 * lower index is the initiator, `a`; the higher is `b`.
 */
import { shape } from "../actor/shape"
import { isFault, type Label, type Side } from "../core/labels"
import { readMeshAnchor, settled, steadyLink, type MeshAnchorName } from "../mesh/anchors"
import { fairPick } from "../mesh/fair"
import { exploreRoom, HarnessError, type AcceptedLogEntry, type Room as MeshRoom } from "../mesh/room"
import { scenarioFrom } from "../mesh/scenarios"
import type { RoomFinding } from "./bfs"
import { recoveryViolations, steadyAnchor } from "./checks"
import { initialRoom, step, type Room, type RoomStep } from "./model"

export type Verdict = "confirmed:mesh-pair" | "refuted" | "not-confirmable" | "abstract-3" | "unconfirmed"

export interface Confirmation {
  verdict: Verdict
  why: string
  /** the room phones the mesh run stands for: [a, b] */
  pair?: [number, number]
  /** the projected skeleton: each abstract fault and its mesh label as taken (null: not taken) */
  faults?: { abstract: string; mesh: string | null }[]
  /** the mesh anchor the run started from */
  anchor?: MeshAnchorName
  /** the faulty run's mesh labels past the anchor: a mesh anchor candidate */
  meshLabels?: Label[]
  /** the control run: no fault, the same anchor */
  control?: { steady: boolean; labels: number; momentSeen: boolean }
  /** mesh labels per abstract label past the anchor, up to the last fault */
  ratio?: number
  /** The room prefix against the Mesh prefix up to the last fault, which names the cause of a refutation. */
  prefix?: PrefixMatch
}

/** The room shapes found in order among the Mesh ones, or the first one Mesh never accepted. */
export interface PrefixMatch {
  matched: boolean
  side?: Side
  /** the first room shape that the Mesh `side` never accepted in order */
  missing?: string
  /** room shapes in the prefix, both sides */
  room: number
  /** Mesh shapes in the prefix, both sides */
  mesh: number
}

/** The properties with a mesh-pair judge. */
const JUDGED = ["RP10", "RP6"] as const
type Judged = (typeof JUDGED)[number]

/** One skeleton fault, ready to drive. */
interface PlannedFault {
  /** the projected 2-phone label */
  abstract: string
  side: Side
  /** the counterpart, as written in a report */
  name: string
  matches(label: Label, room: MeshRoom): boolean
  rejection?: [op: string, cls: string]
  env?: Label
  /** the shape of the last event the half accepted before the fault (sweeps and stats left out); null: none since the anchor */
  before: string | null
  /** a completion rejection: the site and reason Mesh must report for it */
  expect?: { site: string; reason: string }
}

export interface ConfirmPlan {
  property: Judged
  pair: [number, number]
  anchor: MeshAnchorName
  faults: PlannedFault[]
  /** abstract labels past the anchor (projected) */
  abstractLabels: number
  /** the accepted-event shapes of each room half from the anchor to the last fault, sweeps and stats left out */
  prefix: Record<Side, string[]>
}

// ── the abstract half: replay, project, skeleton ──

interface Replayed {
  room: Room
  edges: { label: string; fault: boolean; steps: readonly RoomStep[]; parent: Room; violations: string[] }[]
}

/** Replays labels from `start`. Lenient: a label that is not enabled is skipped unless it is a fault (then null and the label). */
function replay(start: Room, labels: readonly string[], lenient: boolean): Replayed | { missing: string } {
  let room = start
  const edges: Replayed["edges"] = []
  for (const label of labels) {
    const next = step(room, label)
    if (!next) {
      if (lenient && !looksLikeFault(label)) continue
      return { missing: label }
    }
    edges.push({ label, fault: next.fault, steps: next.edge.steps, parent: room, violations: next.edge.violations.map((violation) => violation.property) })
    room = next.room
  }
  return { room, edges }
}

/** The labels the room may charge as a fault (step decides; this only keeps a skipped fault from passing silently). */
const looksLikeFault = (label: string): boolean => label.startsWith("ph:") || /:drop$/.test(label) || /:rejected(:|$)/.test(label)

/** The phones a room label names. */
export function phonesOf(label: string): number[] {
  const pair = /^\w+:(\d+)[>@-](\d+)/.exec(label)
  if (pair) return [Number(pair[1]), Number(pair[2])]
  const one = /^\w+(?:-jb)?:(\d+)(?::|$)/.exec(label)
  return one ? [Number(one[1])] : []
}

/** The label with phone `lo` renamed 0 and `hi` renamed 1; null when it names another phone. */
export function projectLabel(label: string, [lo, hi]: [number, number]): string | null {
  const phones = phonesOf(label)
  if (phones.some((phone) => phone !== lo && phone !== hi)) return null
  const rename = (phone: string) => (Number(phone) === lo ? "0" : "1")
  const pair = /^(\w+):(\d+)([>@-])(\d+)(.*)$/.exec(label)
  if (pair) return `${pair[1]}:${rename(pair[2]!)}${pair[3]}${rename(pair[4]!)}${pair[5]}`
  const one = /^(\w+(?:-jb)?):(\d+)(.*)$/.exec(label)
  return one ? `${one[1]}:${rename(one[2]!)}${one[3]}` : label
}

/** The pairs a finding's detail names as failing, else every pair. */
function candidatePairs(finding: RoomFinding, n: number): [number, number][] {
  const all: [number, number][] = []
  for (let lo = 0; lo < n; lo++) for (let hi = lo + 1; hi < n; hi++) all.push([lo, hi])
  const named: [number, number][] = []
  if (finding.property === "RP10") {
    const stuck = /not steady: ([\d\-, ]+)\)/.exec(finding.detail)?.[1]
    for (const pair of stuck?.split(",") ?? []) {
      const [lo, hi] = pair.trim().split("-").map(Number) as [number, number]
      named.push([lo, hi])
    }
  } else if (finding.property === "RP6") {
    const at = /phone (\d+)'s connection \d+ toward (\d+)/.exec(finding.detail)
    if (at) named.push([Math.min(Number(at[1]), Number(at[2])), Math.max(Number(at[1]), Number(at[2]))])
  }
  return named.length > 0 ? named : all
}

/** Does the replayed 2-phone schedule show the property? */
function shows(property: Judged, replayed: Replayed): boolean {
  if (property === "RP10") return recoveryViolations(replayed.room).length > 0
  return replayed.edges.some((edge) => edge.violations.includes("RP6"))
}

const WEATHER = new Set(["clock", "stats-observed"])

const sideOf = (phone: number): Side => (phone === 0 ? "a" : "b")

/** The fault table: an abstract fault's mesh-pair counterpart, or why there is none. */
function counterpart(label: string, firstFault: boolean): Omit<PlannedFault, "abstract" | "before"> | { missing: string } {
  let match = /^ph:(\d+):(reload|network)$/.exec(label)
  if (match) {
    if (match[2] === "network") {
      // Mesh.networkChanged on that side (room.ts env:network), in every scenario's env
      const side = sideOf(Number(match[1]))
      const env = `env:network:${side}`
      return { side, name: env, env, matches: (candidate) => candidate === env }
    }
    if (match[1] === "0") return { missing: `${label}: mesh-pair reloads only b, the answerer (env:reload:b)` }
    if (firstFault) return { side: "b", name: "env:reload:b (the after-reload anchor)", matches: () => false }
    return { side: "b", name: "env:reload:b", env: "env:reload:b", matches: (candidate) => candidate === "env:reload:b" }
  }
  if (/^choice:\d+:rejected$/.test(label)) return { missing: `${label}: mesh-pair has no restartIce rejection` }
  if (/^ice:\d+-\d+:drop$/.test(label)) return { missing: `${label}: env:ice lives only in the outage scenario, one side at a quiet point` }
  // mesh-pair's room sends no hello after the first (#1525): a lost frame starves the supervisor's
  // presence-gated stranded re-offer there, so a drop's verdict would be the harness's, not Mesh's
  if (/^w:\d+>\d+:drop$/.test(label)) return { missing: `${label}: mesh-pair sends no presence hellos after the first (#1525), so a lost frame never recovers there` }
  match = /^h:(\d+)>(\d+):complete:([\w-]+(?::[\w-]+)?):rejected:([\w-]+):([\w-]+)$/.exec(label)
  if (match) {
    const side = sideOf(Number(match[1]))
    const family = match[3]!
    const site = match[4]!
    const reason = match[5]!
    const op = family.startsWith("set-remote-description") ? "srd" : family.startsWith("send-offer") || family.startsWith("send-answer") ? "sld" : null
    if (!op) return { missing: `${label}: no mesh-pair op for ${family}` }
    // every class the harness can inject is a hard one (mesh.ts HARD_NEGOTIATION_ERRORS); only
    // applyStatementOffer reads more than the class: "other" for a non-InvalidAccess class on a
    // connection holding a remote description, "virgin-pc" on one without
    const cls = reason === "hard-sdp" ? "OperationError"
      : reason === "invalid-access" ? "InvalidAccessError"
        : site === "statement-offer-received" && (reason === "other" || reason === "virgin-pc") ? "OperationError"
          : null
    if (!cls) return { missing: `${label}: Mesh classes every injectable rejection as hard-sdp at ${site}` }
    const pattern = new RegExp(`^pc:${side}/\\d+:${op}:reject:${cls}$`)
    return { side, name: `pc:${side}/*:${op}:reject:${cls}`, rejection: [op, cls], expect: { site, reason }, matches: (candidate) => pattern.test(candidate) }
  }
  return { missing: `${label}: no mesh-pair counterpart` }
}

/** Steps 1 to 4: the plan, or the verdict that ends the pipeline before Mesh. */
export function planConfirmation(finding: RoomFinding, n: number): ConfirmPlan | Confirmation {
  const property = finding.property as Judged
  if (!JUDGED.includes(property)) return { verdict: "unconfirmed", why: `no mesh-pair judge for ${finding.property} yet (RP10 is judged by steadyLink, RP6 as P1b)` }
  // the codec guard is a choice in the room (model.ts codecGuard), not a fault, so the skeleton
  // would carry nothing of it; on mesh-pair an RTX-unsafe side guards every RTX offer
  // (rtxOffers), not the ones the witness chose. Its replay is room/codec-guard-mesh.test.ts.
  const guard = finding.labels.find((label) => label.endsWith(":codec-guard-rtx"))
  if (guard) return { verdict: "not-confirmable", why: `${guard}: the codec guard has no mesh-pair counterpart in the confirm pipeline` }
  // the frozen page clock has no counterpart in the confirm pipeline (mesh-pair's sides share one clock); its replay is room/frozen-clock-mesh.test.ts
  const page = finding.labels.find((label) => label.startsWith("vis:") || label.endsWith(":silent"))
  if (page) return { verdict: "not-confirmable", why: `${page}: the frozen page clock has no mesh-pair counterpart in the confirm pipeline` }
  const whole = replay(initialRoom(n, 99), finding.labels, false)
  if ("missing" in whole) return { verdict: "unconfirmed", why: `the witness does not replay: ${whole.missing} is not enabled` }
  const first = whole.edges.findIndex((edge) => edge.fault)
  if (first < 0) return { verdict: "unconfirmed", why: "the witness has no fault: nothing to inject" }
  // a fault no pair could realise on mesh-pair ends it before the projection (which may drop it)
  for (const edge of whole.edges) {
    const found = edge.fault && /^(choice:\d+:rejected|ice:\d+-\d+:drop)$/.test(edge.label) ? counterpart(edge.label, false) : null
    if (found && "missing" in found) return { verdict: "not-confirmable", why: found.missing }
  }
  // the abstract anchor is the fault-free prefix (steady-n from the fair scheduler); the rest is projected onto a pair
  const suffix = finding.labels.slice(first)
  let projected: { pair: [number, number]; replayed: Replayed; labels: string[]; from: number } | null = null
  const tried: string[] = []
  for (const pair of n === 2 ? [[0, 1] as [number, number]] : candidatePairs(finding, n)) {
    let replayed: Replayed | { missing: string }
    let labels: string[]
    let from: number
    if (n === 2) {
      replayed = whole
      labels = suffix
      from = first
    } else {
      const anchor = steadyAnchor(2)
      labels = suffix.map((label) => projectLabel(label, pair)).filter((label): label is string => label !== null)
      replayed = replay({ ...anchor.room, faultsLeft: 99 }, labels, true)
      from = 0
    }
    if ("missing" in replayed) {
      tried.push(`${pair.join("-")}: the fault ${replayed.missing} is not enabled with two phones`)
      continue
    }
    if (!shows(property, replayed)) {
      if (n === 2) return { verdict: "unconfirmed", why: `the witness does not show ${property} when the room replays it` }
      tried.push(`${pair.join("-")}: ${property} does not fire with two phones`)
      continue
    }
    projected = { pair, replayed, labels, from }
    break
  }
  if (!projected) return { verdict: "abstract-3", why: `projected onto its pairs, the finding needs the third phone (${tried.join("; ")})` }

  const edges = projected.replayed.edges.slice(projected.from)
  const last: (string | null)[][] = [[null, null], [null, null]]
  const faults: PlannedFault[] = []
  const prefix: Record<Side, string[]> = { a: [], b: [] }
  const lastFault = edges.findLastIndex((edge) => edge.fault)
  let anchor: MeshAnchorName = "steady"
  for (const [index, edge] of edges.entries()) {
    if (edge.fault) {
      const found = counterpart(edge.label, index === 0)
      if ("missing" in found) return { verdict: "not-confirmable", why: found.missing, pair: projected.pair }
      // the half whose accepted events gate the fault: a completion's own half; a reload has none
      const own = /^h:(\d+)>(\d+):/.exec(edge.label)
      const before = own ? last[Number(own[1])]![Number(own[2])]! : null
      if (index === 0 && edge.label === "ph:1:reload") anchor = "after-reload"
      else faults.push({ ...found, abstract: edge.label, before })
    }
    const inPrefix = index < lastFault
    for (const actorStep of edge.steps) {
      if (actorStep.result.ignored !== undefined || WEATHER.has(actorStep.event.type)) continue
      last[actorStep.phone]![actorStep.peer] = shape(actorStep.event)
      if (inPrefix) prefix[sideOf(actorStep.phone)].push(shape(actorStep.event))
    }
  }
  if (anchor === "after-reload" && faults.some((fault) => fault.env === "env:reload:b")) {
    return { verdict: "not-confirmable", why: "a second reload of b: mesh-pair reloads b once", pair: projected.pair }
  }
  return { property, pair: projected.pair, anchor, faults, abstractLabels: projected.labels.length - (anchor === "after-reload" ? 1 : 0), prefix }
}

// ── the Mesh half: drive and judge ──

/** labels without a fault before the next one is given up on */
const FAULT_BOUND = 500
/** fair clock steps after the last fault before the judge */
const CLOCK_BOUND = 200

interface Drive {
  steady: boolean
  /** labels past the anchor */
  labels: Label[]
  /** the index in `labels` of the last fault taken (-1: none) */
  lastFaultAt: number
  taken: (string | null)[]
  p1b: number
  /** the first fault's counterpart was enabled (the control reached the moment) */
  momentSeen: boolean
  /** why the skeleton was not realised */
  unrealised?: string
  /** the accepted-event shapes of each Mesh side from the anchor to the last fault taken */
  prefix: Record<Side, string[]>
}

async function drive(plan: ConfirmPlan, inject: boolean): Promise<Drive> {
  const fixture = readMeshAnchor(plan.anchor)
  const faults = plan.faults.length + 2
  const custom = scenarioFrom(fixture.scenario, {
    env: plan.faults.flatMap((fault) => (fault.env ? [fault.env] : [])),
    rejections: plan.faults.flatMap((fault) => (fault.rejection ? [fault.rejection] : [])),
    faults,
  })
  const room = await exploreRoom({ scenario: fixture.scenario, custom, phaseOffsetMs: 1000, faults, horizonMs: 600_000, knownGaps: false })
  try {
    await room.replay(fixture.warmup)
    const anchorAccepted = room.logs().accepted.length
    let lastFaultAccepted = anchorAccepted
    const labels: Label[] = []
    const taken: (string | null)[] = plan.faults.map(() => null)
    const since = new Map<Label, number>()
    let next = 0
    let waited = 0
    let clocks = 0
    let momentSeen = false
    let unrealised: string | undefined
    const owed = () => inject && next < plan.faults.length
    for (let count = 0; count < 4 * FAULT_BOUND; count++) {
      const enabled = room.enabled()
      const fault = plan.faults[inject ? next : 0]
      const hits = fault ? enabled.filter((label) => fault.matches(label, room)) : []
      // the fault's moment: its counterpart enabled and its side's last accepted event of the recorded shape
      // (judged before the steady stop: a fault taken at the anchor itself, a network change on a steady link, has its moment there)
      const atMoment = hits.length > 0 && (fault!.before === null || lastShape(room, fault!.side) === fault!.before)
      if (atMoment && (!inject || next === 0)) momentSeen = true
      // steady and settled: a fault taken on a steady link leaves it reading steady until Mesh notices
      if (!owed() && steadyLink(room) && settled(room)) break
      for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
      for (const label of enabled) if (!since.has(label)) since.set(label, count)
      let label: Label | undefined
      if (owed()) {
        // the newest PC's op (the side's current connection) when several match
        const hit = hits.sort((x, y) => newest(y) - newest(x))[0]
        if (hit !== undefined && atMoment) {
          label = hit
          taken[next] = hit
        } else if (++waited > FAULT_BOUND) {
          unrealised = `${fault!.name} (after ${fault!.before ?? "anything"}) was not enabled within ${FAULT_BOUND} labels${hits.length > 0 ? `; it was enabled, but ${fault!.side}'s last accepted event was ${lastShape(room, fault!.side)}` : ""}`
          break
        }
      }
      if (label === undefined) {
        if (enabled.some((candidate) => candidate !== "clock:next" && !isFault(candidate))) label = fairPick(enabled, since)
        else if (enabled.includes("clock:next")) label = "clock:next"
        else break
      }
      if (label === "clock:next" && !owed() && ++clocks > CLOCK_BOUND) break
      const acceptedBefore = room.logs().accepted.length
      await room.step(label)
      labels.push(label)
      if (label === taken[next] && inject) {
        const expected = plan.faults[next]!.expect
        lastFaultAccepted = acceptedBefore
        next += 1
        waited = 0
        if (expected) {
          const reported = await reportedRejection(room, plan.faults[next - 1]!.side, acceptedBefore, since, labels)
          if (!reported) {
            unrealised = `${label}: Mesh reported no rejected completion for it`
            break
          }
          if (reported.site !== expected.site || reported.reason !== expected.reason) {
            unrealised = `${label}: Mesh reported ${reported.site}:${reported.reason}, the abstract fault ${expected.site}:${expected.reason}`
            break
          }
        }
      }
    }
    return { steady: steadyLink(room) && settled(room), labels, lastFaultAt: labels.lastIndexOf(taken.findLast((hit) => hit !== null) ?? ""), taken, p1b: room.violations("P1b").length, momentSeen, unrealised, prefix: acceptedShapes(room, anchorAccepted, lastFaultAccepted) }
  } finally {
    room.close()
  }
}

const newest = (label: Label): number => Number(/^pc:[ab]\/(\d+):/.exec(label)?.[1] ?? 0)

const acceptedWeatherless = (entry: AcceptedLogEntry): boolean => entry.kind === "accepted" && !WEATHER.has((entry.event as { type: string }).type)

const meshShape = (entry: AcceptedLogEntry): string => shape(entry.event as Parameters<typeof shape>[0])

function lastShape(room: MeshRoom, side: Side): string | null {
  const entry = room.logs().accepted.findLast((accepted) => accepted.side === side && acceptedWeatherless(accepted))
  return entry ? meshShape(entry) : null
}

function acceptedShapes(room: MeshRoom, from: number, to: number): Record<Side, string[]> {
  const shapes: Record<Side, string[]> = { a: [], b: [] }
  for (const entry of room.logs().accepted.slice(from, to)) if (acceptedWeatherless(entry)) shapes[entry.side].push(meshShape(entry))
  return shapes
}

/** The first rejected completion `side` accepted since `from`, fair-stepping (no fault) until one lands, at most 50 labels. */
async function reportedRejection(room: MeshRoom, side: Side, from: number, since: Map<Label, number>, labels: Label[]): Promise<{ site: string; reason: string } | null> {
  for (let count = 0; ; count++) {
    const found = room.logs().accepted.slice(from).find((entry) => {
      const event = entry.event as { type?: string; outcome?: string } | undefined
      return entry.side === side && event?.type === "command-completed" && event.outcome === "rejected"
    })
    if (found) {
      const event = found.event as { site?: string; reason?: string }
      return { site: String(event.site), reason: String(event.reason) }
    }
    if (count >= 50) return null
    const enabled = room.enabled()
    const fair = enabled.filter((label) => label !== "clock:next" && !isFault(label))
    const label = fair.length > 0 ? fairPick(enabled, since) : enabled.includes("clock:next") ? "clock:next" : null
    if (label === null) return null
    await room.step(label)
    labels.push(label)
  }
}

/**
 * The cause of a refutation: a model defect when the room prefix
 * of each side is an in-order subsequence of the Mesh one, else a translator
 * defect.
 *
 * A subsequence, not equality: the room abstracts events away, and Mesh takes
 * more labels per abstract one (the ratio).
 */
export function cause(room: Record<Side, readonly string[]>, mesh: Record<Side, readonly string[]>): { word: "model defect" | "translator defect"; detail: string; prefix: PrefixMatch } {
  const counts = { room: room.a.length + room.b.length, mesh: mesh.a.length + mesh.b.length }
  for (const side of ["a", "b"] as const) {
    const accepted = mesh[side]
    let at = 0
    for (const [index, wanted] of room[side].entries()) {
      while (at < accepted.length && accepted[at] !== wanted) at++
      if (at === accepted.length) {
        return {
          word: "translator defect",
          detail: `but ${side} never accepted ${wanted} before the last fault (room event ${index + 1} of ${room[side].length})`,
          prefix: { matched: false, side, missing: wanted, ...counts },
        }
      }
      at++
    }
  }
  const detail = counts.room === 0 ? "and the room accepted nothing before the last fault" : "and Mesh accepted every event the room accepted before the last fault, in order"
  return { word: "model defect", detail, prefix: { matched: true, ...counts } }
}

/** Steps 5 and 6 for a plan. `controls` caches the control run per anchor. */
export async function confirmPlan(plan: ConfirmPlan, controls: Map<string, Drive> = new Map()): Promise<Confirmation> {
  const base = { pair: plan.pair, anchor: plan.anchor }
  let faulty: Drive
  let control: Drive
  try {
    faulty = await drive(plan, true)
    const key = JSON.stringify([plan.anchor, plan.faults[0]?.name ?? "", plan.faults[0]?.before ?? null])
    control = controls.get(key) ?? (await drive(plan, false))
    controls.set(key, control)
  } catch (error) {
    // a harness cut, or Mesh throwing: the run proves nothing either way
    const why = error instanceof HarnessError ? `harness: ${error.detail}` : `the Mesh run threw: ${error instanceof Error ? error.message : String(error)}`
    return { ...base, verdict: "unconfirmed", why }
  }
  const result: Confirmation = {
    ...base,
    verdict: "unconfirmed",
    why: "",
    faults: plan.faults.map((fault, index) => ({ abstract: fault.abstract, mesh: faulty.taken[index] ?? null })),
    meshLabels: faulty.labels,
    control: { steady: control.steady, labels: control.labels.length, momentSeen: control.momentSeen },
    ratio: plan.abstractLabels > 0 && faulty.lastFaultAt >= 0 ? Math.round(((faulty.lastFaultAt + 1) / plan.abstractLabels) * 100) / 100 : undefined,
  }
  if (faulty.unrealised) {
    // a counterpart never enabled: the label exists, its moment does not come on Mesh
    return { ...result, verdict: faulty.taken.every((taken) => taken === null) && !faulty.unrealised.includes("reported") ? "not-confirmable" : "unconfirmed", why: `the skeleton was not realised: ${faulty.unrealised}` }
  }
  const attributed = cause(plan.prefix, faulty.prefix)
  if (plan.property === "RP10") {
    if (faulty.steady) return { ...result, prefix: attributed.prefix, verdict: "refuted", why: `refuted (${attributed.word}): the skeleton was realised and Mesh recovers, steady ${faulty.labels.length} labels past the anchor, ${attributed.detail}` }
    if (!control.steady) return { ...result, why: "Mesh stays down, but the control run without the faults does not recover either" }
    if (!control.momentSeen) return { ...result, why: "Mesh stays down, but the control run never reached the first fault's moment" }
    return { ...result, verdict: "confirmed:mesh-pair", why: `the pair stays down ${CLOCK_BOUND} fair clock steps after the last fault; the control recovers in ${control.labels.length} labels` }
  }
  if (faulty.p1b === 0) return { ...result, prefix: attributed.prefix, verdict: "refuted", why: `refuted (${attributed.word}): the skeleton was realised and Mesh shows no P1b, ${attributed.detail}` }
  if (!control.momentSeen) return { ...result, why: "Mesh shows P1b, but the control run never reached the first fault's moment" }
  if (control.p1b > 0) return { ...result, why: "Mesh shows P1b, but the control run without the faults does too" }
  return { ...result, verdict: "confirmed:mesh-pair", why: `Mesh shows P1b (${faulty.p1b}); the control does not` }
}

/** Findings with equal keys share one Mesh run and its verdict, the cause included, so the room prefix is part of the key. */
export const planKey = (plan: ConfirmPlan): string => JSON.stringify([plan.property, plan.pair, plan.anchor, plan.faults.map((fault) => [fault.name, fault.before]), plan.prefix])

/** Every finding of a run, each with its verdict; findings with the same plan share one Mesh run. */
export async function confirmFindings(findings: readonly RoomFinding[], n: number): Promise<{ confirmations: Confirmation[]; counts: Record<Verdict, number> }> {
  const controls = new Map<string, Drive>()
  const byPlan = new Map<string, Confirmation>()
  const confirmations: Confirmation[] = []
  for (const finding of findings) {
    const plan = planConfirmation(finding, n)
    if ("verdict" in plan) {
      confirmations.push(plan)
      continue
    }
    const key = planKey(plan)
    let confirmation = byPlan.get(key)
    if (!confirmation) {
      confirmation = await confirmPlan(plan, controls)
      byPlan.set(key, confirmation)
    }
    confirmations.push(confirmation)
  }
  const counts = { "confirmed:mesh-pair": 0, refuted: 0, "not-confirmable": 0, "abstract-3": 0, unconfirmed: 0 } as Record<Verdict, number>
  for (const confirmation of confirmations) counts[confirmation.verdict] += 1
  return { confirmations, counts }
}
