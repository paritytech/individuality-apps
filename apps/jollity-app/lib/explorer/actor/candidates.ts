// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Phase B: simplification candidates from the pure peer-actor
 * search. Three kinds:
 * 1. fields that never matter: each field of PeerActorState is forced to a
 *    reference value in the step input and in the successor, on every actor
 *    step the search took; it is listed when no command Mesh reads and no
 *    other field changes;
 * 2. states with identical labelled futures to depth 3 (same commands along
 *    every label path), summarised as region pairs;
 * 3. things never reached: cells (region × event type), command kinds,
 *    replace-connection causes, completion sites, and the actor's ignore
 *    guards.
 *
 * Bounded evidence, never a proof: every item is "uncovered within bounds"
 * with its bounds. A deletion needs an independent semantic argument plus
 * normal regression tests.
 *
 * Why one-step forcing is enough: if forcing field f commutes with every step
 * from every world the search expanded (the forced step's successor is the
 * real successor with f forced, and its commands are equal), then by
 * induction every label path within the bounds gives the same commands with
 * f forced throughout. A field that fails the
 * check may still never matter (it fed another field that never matters);
 * the check errs towards keeping. The induction covers the actor's own
 * reads only: for a field the fact world also reads as Mesh's copy
 * (WORLD_READS), the "never matters" rests on
 * the static slice's point that Mesh keeps its own copy, not on the graph.
 */
import { createPeerActorState, stepPeerActor, type PeerActorCommand, type PeerActorEvent, type PeerActorState, type PeerCommandSite, type PeerLink } from "../../state-machines/peer-actor"
import { peerMachineDefinition, peerRegressionCorpus, peerTransitionTable, peerWitnesses } from "../../state-machines/peer.definition"
import { ALPHABET } from "./alphabet"
import { hash64, type ActorBfsResult, type ActorStep, type Stepper } from "./bfs"
import { HELD_CONSTANTS } from "./world"

type CandidateKind = "field" | "equivalent-states" | "unreached-cell" | "unreached-command" | "unreached-cause" | "unreached-site" | "unreached-guard"
/** defensive: a guard against late, duplicate or wrong-room facts; never deletable */
type Likely = "dead" | "generator-gap" | "defensive"
/** strong: the graph and the static slice agree; static (graph vacuous): they
 *  agree only by construction (a constant field, or an item the alphabet
 *  excludes for the static slice's own reason); bounded only: only the
 *  bounded graph shows it; defensive (keep); static only: the static slice
 *  lists it, the graph shows a read */
type Strength = "strong" | "static (graph vacuous)" | "bounded only" | "defensive (keep)" | "static only"

export interface Candidate {
  kind: CandidateKind
  item: string
  likely: Likely
  why: string
  bounds: string
  /** alphabet entries (and held constants) the "never" depends on */
  dependsOn?: string[]
  staticVerdict?: string
  strength?: Strength
  /** the review sheet's question */
  question?: string
  /** what a deletion waits for */
  wait?: string
}

// ---------------------------------------------------------------------------
// Universes, exhaustive by type
// ---------------------------------------------------------------------------

/** The link axis's values, the "regions" of this report. */
const REGION_SET = {
  "connecting": true, "connected": true, "link-down": true, "yielded": true, "closed": true,
} as const satisfies Record<PeerLink, true>
const REGIONS = Object.keys(REGION_SET) as PeerLink[]

const EVENT_SET = {
  "peer-heard": true, "peer-away": true, "description-observed": true, "peer-session-changed": true,
  "connection-observed": true, "channel-observed": true, "local-offer-requested": true, "clock": true,
  "glare-observed": true, "codec-guard-rtx": true,
  "local-offer-superseded": true, "stats-observed": true, "visibility-changed": true, "standby-changed": true, "network-changed": true,
  "ice-policy-changed": true, "round-changed": true, "command-completed": true, "peer-removed": true, "room-closed": true,
  "connection-replaced-externally": true,
} as const satisfies Record<PeerActorEvent["type"], true>
export const EVENT_TYPES = Object.keys(EVENT_SET) as PeerActorEvent["type"][]

const COMMAND_SET = {
  "restart-ice": true, "yield-responder": true, "replace-connection": true, "set-remote-description": true, "rollback": true,
  "ignore-offer": true, "create-channel": true, "send-offer": true, "send-answer": true, "replace-video-track": true,
  "request-keyframe": true, "sweep": true, "configure-ice": true, "close-connection": true, "mark-away": true, "mark-back": true,
} as const satisfies Record<PeerActorCommand["kind"], true>
const COMMAND_KINDS = Object.keys(COMMAND_SET) as PeerActorCommand["kind"][]

const SITE_SET = {
  "supervisor-recovery": true, "media-stall": true, "peer-no-video": true, "network-change": true, "statement-offer-sent": true,
  "statement-offer-received": true, "statement-offer-retried": true, "statement-answer": true, "lane": true,
} as const satisfies Record<PeerCommandSite, true>
const SITES = Object.keys(SITE_SET) as PeerCommandSite[]

type Ignored = NonNullable<ReturnType<typeof stepPeerActor>["ignored"]>
const GUARD_SET = {
  "closed": true, "stale-room": true, "stale-connection": true, "stale-command": true, "departed-session": true, "held": true, "idle": true,
} as const satisfies Record<Ignored, true>
const GUARDS = Object.keys(GUARD_SET) as Ignored[]

/** Every replace-connection cause the actor can emit (peer-actor.ts), with
 *  the event types whose step emits it. The test checks this list against
 *  the source's literals; the templated ones are spelled out. */
export const CAUSES: Record<string, { from: PeerActorEvent["type"][] }> = {
  "answer-timeout-yield": { from: ["clock"] },
  "description-session-rejoin": { from: ["description-observed"] },
  "signalling-session-rejoin": { from: ["peer-session-changed"] },
  "channel-never-opened": { from: ["clock"] },
  "stranded-yield-unanswered": { from: ["clock"] },
  "failed": { from: ["clock"] },
  "soft-disconnect": { from: ["clock"] },
  "connect-by-deadline": { from: ["clock"] },
  "hard-sdp-immediate": { from: ["command-completed"] },
  "lane-glare-video": { from: ["glare-observed"] },
  "connected-no-video": { from: ["stats-observed"] },
  "media-stall": { from: ["stats-observed"] },
  "peer-no-video-hard-sdp": { from: ["stats-observed"] },
  "network-change": { from: ["network-changed"] },
  "supervisor-recovery-restart-failed": { from: ["command-completed"] },
  "network-change-restart-failed": { from: ["command-completed"] },
  "stranded-offer-refused": { from: ["command-completed"] },
  "offer-refused-rejoin": { from: ["command-completed"] },
  "answer-refused": { from: ["command-completed"] },
  "answer-displaced-rejoin": { from: ["command-completed"] },
}

const EXCLUDED_TYPES: Partial<Record<PeerActorEvent["type"], string>> = {}

/** The actor fields the fact world reads itself, as Mesh's own copy (alphabet.ts, effects.ts, world.ts). */
const WORLD_READS = new Set(["link", "hidden", "initiator", "lastAttemptAt", "roundGeneration", "standby", "scope.roomEpoch"])

// ---------------------------------------------------------------------------
// A static slice of the actor's fields, taken by hand when this list was
// written, with the question asked of each item. "unused": influences nothing observable;
// "defensive": a guard; "live": read for a decision.
// ---------------------------------------------------------------------------

type StaticClass = "unused" | "defensive" | "live"
interface StaticEntry { class: StaticClass; verdict: string; question?: string; wait?: string }

/** Each command carries its landing label itself (emit), so a region merge
 *  waits for nothing. ("design B" names the actor redesign that shipped.) */
const REGION_WAIT = "design B"
const LIVE: StaticEntry = { class: "live", verdict: "read for a decision (static slice fixpoint)" }
const STATIC_SLICE: Record<string, StaticEntry> = {
  "actor.scope.game": { class: "unused", verdict: "read nowhere", wait: "no" },
  "actor.scope.peer": { class: "unused", verdict: "read nowhere since the shadow's divergence lines went (step 9)", wait: "design B" },
  "actor.link": { class: "live", verdict: "closed versus not is read (stepPeerActor's closed guard, MESH startActor); which open link, by nothing yet: design B's B4 arms connectBy from it" },
  "actor.scope.roomEpoch": { class: "defensive", verdict: "stepPeerActor's stale-room guard; the world has one room generation" },
  "actor.lastAttemptAt": { class: "defensive", verdict: "the backoff clock (decideSupervisor's backoff, set by attempted()): live; since every completion carries now (design B, B1, #1458) the probe \"leave the backoff clock on a replace\" is killed" },
}
for (const field of ["roundGeneration", "connectionEpoch", "commandEpoch", "openCommands", "away", "hidden", "standby", "initiator", "cameraLive", "laneOpen", "remoteOffer", "rejoinAnswer", "lastSignalAt", "framesSeen", "stallSamples", "framesReadSequence", "budgets.failCount", "budgets.stallHeals", "budgets.unseenHeals", "budgets.noVideoRebuilds", "budgets.negotiationImmediate", "budgets.negotiationUnseen", "budgets.glareRebuilds"]) {
  STATIC_SLICE[`actor.${field}`] = LIVE
}

// ---------------------------------------------------------------------------
// Coverage: what the search's actor steps reached
// ---------------------------------------------------------------------------

/** The reference a field is forced to: the initiator's start (any fixed value works). */
const REFERENCE: PeerActorState = createPeerActorState({ game: 42, roomEpoch: 1, peer: "b" }, { initiator: true, standby: false, cameraLive: true, connectionEpoch: 1 })

const FIELD_PATHS: string[] = [
  ...Object.keys(REFERENCE).filter((key) => key !== "scope" && key !== "budgets"),
  ...Object.keys(REFERENCE.scope).map((key) => `scope.${key}`),
  ...Object.keys(REFERENCE.budgets).map((key) => `budgets.${key}`),
]

const getPath = (state: PeerActorState, path: string): unknown => {
  const [head, tail] = path.split(".") as [keyof PeerActorState, string | undefined]
  const value = state[head]
  return tail === undefined ? value : (value as unknown as Record<string, unknown>)[tail]
}

const setPath = (state: PeerActorState, path: string, value: unknown): PeerActorState => {
  const [head, tail] = path.split(".") as [keyof PeerActorState, string | undefined]
  if (tail === undefined) return { ...state, [head]: value }
  return { ...state, [head]: { ...(state[head] as unknown as Record<string, unknown>), [tail]: value } }
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object).filter((key) => (a as Record<string, unknown>)[key] !== undefined)
  const kb = Object.keys(b as object).filter((key) => (b as Record<string, unknown>)[key] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((key) => equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** What Mesh reads of a command with the actor driving (executePeerCommand and the runner). */
const meshView = (commands: readonly PeerActorCommand[]) => commands.map((command) => {
  const { attempt: _attempt, heal: _heal, ...rest } = command as PeerActorCommand & { heal?: number }
  void _attempt
  void _heal
  return rest
})
/** What nothing reads of a command (attempt and heal, which Mesh only logs). */
const shadowView = (commands: readonly PeerActorCommand[]) => commands.map((command) => [command.attempt, (command as { heal?: number }).heal])

export interface FieldResult {
  /** distinct values seen before a step (capped at 32) */
  values: string[]
  /** the first step where forcing it changed something Mesh reads or another field */
  matters: { entry: string; event: string; region: string; what: string } | null
  /** forcing it changed only command accounting metadata */
  shadowOnly: { entry: string; event: string; region: string } | null
}

export interface Coverage {
  bounds: string
  /** `${region before}|${event type}` */
  cells: Record<string, number>
  ignored: Record<string, number>
  sites: Record<string, number>
  commands: Record<string, number>
  causes: Record<string, number>
  /** alphabet entry → the event types its drains delivered */
  entryTypes: Record<string, string[]>
  fields: Record<string, FieldResult>
}

type Sets = Pick<Coverage, "cells" | "ignored" | "sites" | "commands" | "causes">

const bump = (into: Record<string, number>, key: string) => {
  into[key] = (into[key] ?? 0) + 1
}

function recordStep(into: Sets, before: PeerActorState, event: PeerActorEvent, result: ReturnType<Stepper>): void {
  bump(into.cells, `${before.link}|${event.type}`)
  if (result.ignored) bump(into.ignored, result.ignored)
  if (event.type === "command-completed" && event.site) bump(into.sites, event.site)
  for (const command of result.commands) {
    bump(into.commands, command.kind)
    if (command.kind === "replace-connection") bump(into.causes, command.cause)
  }
}

/** The bfs observer that records coverage and runs the field-forcing check on every actor step. */
export function coverageObserver(step: Stepper = stepPeerActor) {
  const sets: Sets = { cells: {}, ignored: {}, sites: {}, commands: {}, causes: {} }
  const entryTypes = new Map<string, Set<string>>()
  const fields = new Map<string, { values: Set<string>; matters: FieldResult["matters"]; shadowOnly: FieldResult["shadowOnly"] }>()
  for (const path of FIELD_PATHS) fields.set(path, { values: new Set(), matters: null, shadowOnly: null })
  let undecided = [...FIELD_PATHS]

  const observe = ({ event, before, result }: ActorStep, entryKey: string): void => {
    recordStep(sets, before, event, result)
    let types = entryTypes.get(entryKey)
    if (!types) entryTypes.set(entryKey, (types = new Set()))
    types.add(event.type)
    let decided = false
    for (const path of undecided) {
      const field = fields.get(path)!
      const value = getPath(before, path)
      if (field.values.size < 32) field.values.add(JSON.stringify(value) ?? "undefined")
      const reference = getPath(REFERENCE, path)
      if (equal(value, reference)) continue
      const forced = step(setPath(before, path, reference), event)
      const at = { entry: entryKey, event: event.type, region: before.link }
      let what: string | null = null
      if (!equal(meshView(forced.commands), meshView(result.commands))) what = "the commands Mesh reads"
      else if (!equal(setPath(forced.state, path, reference), setPath(result.state, path, reference))) {
        const other = FIELD_PATHS.find((candidate) => candidate !== path && !equal(getPath(forced.state, candidate), getPath(result.state, candidate)))
        what = `another field (${other ?? "?"})`
      }
      if (what) {
        field.matters = { ...at, what }
        decided = true
      } else if (!field.shadowOnly && !equal(shadowView(forced.commands), shadowView(result.commands))) field.shadowOnly = at
    }
    if (decided) undecided = undecided.filter((path) => fields.get(path)!.matters === null)
  }

  return {
    observe,
    coverage(bounds: string): Coverage {
      return {
        bounds,
        ...structuredClone(sets),
        entryTypes: Object.fromEntries([...entryTypes].map(([key, types]) => [key, [...types].sort()])),
        fields: Object.fromEntries([...fields].map(([path, field]) => [path, { values: [...field.values], matters: field.matters, shadowOnly: field.shadowOnly }])),
      }
    },
    /** coverage that reaches every cell, command, cause, site and guard (for planted graphs) */
    everything(): Sets {
      const all = (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, 1]))
      return {
        cells: all(REGIONS.flatMap((region) => EVENT_TYPES.map((type) => `${region}|${type}`))),
        ignored: all(GUARDS),
        sites: all(SITES),
        commands: all(COMMAND_KINDS),
        causes: all(Object.keys(CAUSES)),
      }
    },
  }
}

function mergeCoverage(list: readonly Coverage[]): Coverage {
  const sum = (pick: (coverage: Coverage) => Record<string, number>) => {
    const out: Record<string, number> = {}
    for (const coverage of list) for (const [key, count] of Object.entries(pick(coverage))) out[key] = (out[key] ?? 0) + count
    return out
  }
  const entryTypes: Record<string, string[]> = {}
  for (const coverage of list) for (const [key, types] of Object.entries(coverage.entryTypes)) entryTypes[key] = [...new Set([...(entryTypes[key] ?? []), ...types])].sort()
  const fields: Record<string, FieldResult> = {}
  for (const coverage of list) {
    for (const [path, field] of Object.entries(coverage.fields)) {
      const prior = fields[path]
      fields[path] = prior
        ? { values: [...new Set([...prior.values, ...field.values])].slice(0, 32), matters: prior.matters ?? field.matters, shadowOnly: prior.shadowOnly ?? field.shadowOnly }
        : { ...field, values: [...field.values] }
    }
  }
  return {
    bounds: list.map((coverage) => coverage.bounds).join("; "),
    cells: sum((c) => c.cells), ignored: sum((c) => c.ignored), sites: sum((c) => c.sites), commands: sum((c) => c.commands), causes: sum((c) => c.causes),
    entryTypes,
    fields,
  }
}

/** Several searches as one graph: nodes merged by key, edges by (from, label). */
export function mergeResults(results: readonly ActorBfsResult[]): ActorBfsResult {
  const nodes: string[] = []
  const ids = new Map<string, number>()
  const id = (key: string) => {
    let at = ids.get(key)
    if (at === undefined) {
      at = nodes.length
      ids.set(key, at)
      nodes.push(key)
    }
    return at
  }
  const edges: ActorBfsResult["graph"]["edges"] = []
  const seen = new Set<string>()
  const expanded = new Set<number>()
  const cut = new Set<number>()
  const roots = new Set<number>()
  for (const result of results) {
    const map = result.graph.nodes.map(id)
    const isExpanded = expandedTest(result.graph)
    result.graph.nodes.forEach((_, local) => {
      if (isExpanded(local)) expanded.add(map[local]!)
    })
    for (const local of result.graph.cut ?? []) cut.add(map[local]!)
    for (const local of result.graph.roots ?? []) roots.add(map[local]!)
    for (const [from, label, to, commands] of result.graph.edges) {
      const key = `${map[from]}\u0000${label}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([map[from]!, label, map[to]!, commands])
    }
  }
  const first = results[0]!
  const coverages = results.flatMap((result) => (result.coverage ? [result.coverage] : []))
  return {
    ...first,
    states: nodes.length,
    edgeCount: edges.length,
    capped: results.some((result) => result.capped),
    frontierClosed: results.every((result) => result.frontierClosed),
    graph: { nodes, edges, expandedSet: [...expanded], cut: [...cut], roots: [...roots] },
    ...(coverages.length > 0 ? { coverage: mergeCoverage(coverages) } : {}),
  }
}

function expandedTest(graph: ActorBfsResult["graph"]): (node: number) => boolean {
  if (graph.expandedSet) {
    const set = new Set(graph.expandedSet)
    return (node) => set.has(node)
  }
  const expanded = graph.expanded ?? graph.nodes.length
  return (node) => node < expanded
}

// ---------------------------------------------------------------------------
// What the actor's own contract reaches: peer.definition's witnesses and
// regression corpora, live and replayed, run through its realStep
// ---------------------------------------------------------------------------

let witnessCache: Sets | undefined
function witnessCoverage(): Sets {
  if (witnessCache) return witnessCache
  const sets: Sets = { cells: {}, ignored: {}, sites: {}, commands: {}, causes: {} }
  for (const sequence of [...peerWitnesses, ...peerRegressionCorpus]) {
    let state = sequence.initial?.real ?? peerMachineDefinition.initialReal()
    for (const testEvent of sequence.events) {
      const { state: next, output } = peerMachineDefinition.realStep(state, testEvent)
      recordStep(sets, state, testEvent.event, output)
      state = next
    }
  }
  return (witnessCache = sets)
}

/** For each region, the event types the transition table says make a
 *  transition there. The table keys a region only as open or closed, and
 *  each scenario by its fact's cell (peerMachineDefinition.eventKey). */
function tableTypes(): Map<string, Set<string>> {
  const cellTypes = new Map<string, Set<string>>()
  for (const sequence of [...peerWitnesses, ...peerRegressionCorpus]) {
    for (const testEvent of sequence.events) {
      const cell = peerMachineDefinition.eventKey(testEvent)
      let types = cellTypes.get(cell)
      if (!types) cellTypes.set(cell, (types = new Set()))
      types.add(testEvent.event.type)
    }
  }
  const out = new Map<string, Set<string>>()
  for (const region of REGIONS) {
    const row: Record<string, string> = peerTransitionTable[peerMachineDefinition.realStateKey({ link: region } as PeerActorState)]
    const types = new Set<string>()
    for (const [cell, declared] of Object.entries(row)) if (declared === "transition") for (const type of cellTypes.get(cell) ?? []) types.add(type)
    out.set(region, types)
  }
  return out
}

// ---------------------------------------------------------------------------
// Equivalent states
// ---------------------------------------------------------------------------

const field = (key: string, name: string): string => new RegExp(`"${name}":"([^"]*)"`).exec(key)?.[1] ?? "?"

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out)
  } else out.set(prefix, JSON.stringify(value))
}

function differingPaths(a: string, b: string): string[] {
  const fa = new Map<string, string>()
  const fb = new Map<string, string>()
  flatten(JSON.parse(a), "", fa)
  flatten(JSON.parse(b), "", fb)
  const paths = new Set([...fa.keys(), ...fb.keys()])
  return [...paths].filter((path) => fa.get(path) !== fb.get(path)).sort()
}

interface PairSummary { groups: number; pure: number; states: number; paths: Map<string, number> }

function equivalentStates(result: ActorBfsResult, depth: number): Map<string, PairSummary> {
  const { nodes, edges } = result.graph
  const n = nodes.length
  const isExpanded = expandedTest(result.graph)
  const cut = new Set(result.graph.cut ?? [])
  const out: number[][] = Array.from({ length: n }, () => [])
  edges.forEach((edge, index) => out[edge[0]]!.push(index))
  for (const list of out) list.sort((a, b) => (edges[a]![1] < edges[b]![1] ? -1 : edges[a]![1] > edges[b]![1] ? 1 : 0))
  const region = nodes.map((key) => field(key, "link"))
  const leaf = hash64("")
  let signature: (string | undefined)[] = nodes.map(() => leaf)
  for (let round = 1; round <= depth; round++) {
    const previous = signature
    signature = nodes.map((_, node) => {
      if (!isExpanded(node) || cut.has(node)) return undefined
      const parts: string[] = []
      for (const index of out[node]!) {
        const [, label, to, commands] = edges[index]!
        const target = previous[to]
        if (target === undefined) return undefined
        parts.push(`${label}\u0001${commands.join(",")}\u0001${target}`)
      }
      return hash64(parts.join("\u0002"))
    })
  }
  const groups = new Map<string, number[]>()
  signature.forEach((sig, node) => {
    if (sig === undefined) return
    const group = groups.get(sig)
    if (group) group.push(node)
    else groups.set(sig, [node])
  })
  const pairs = new Map<string, PairSummary>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const representatives = new Map<string, number>()
    for (const member of members) if (!representatives.has(region[member]!)) representatives.set(region[member]!, member)
    if (representatives.size < 2) continue
    const regions = [...representatives.keys()].sort()
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const key = `regions ${regions[i]} + ${regions[j]}`
        const summary = pairs.get(key) ?? { groups: 0, pure: 0, states: 0, paths: new Map() }
        summary.groups += 1
        summary.states += members.filter((member) => region[member] === regions[i] || region[member] === regions[j]).length
        const paths = differingPaths(nodes[representatives.get(regions[i]!)!]!, nodes[representatives.get(regions[j]!)!]!).filter((path) => path !== "actor.link")
        if (paths.length === 0) summary.pure += 1
        for (const path of paths) summary.paths.set(path, (summary.paths.get(path) ?? 0) + 1)
        pairs.set(key, summary)
      }
    }
  }
  return pairs
}

// ---------------------------------------------------------------------------
// The candidates
// ---------------------------------------------------------------------------

const UNCERTAIN = new Map(ALPHABET.filter((entry) => entry.uncertain || entry.excluded).map((entry) => [entry.key, entry.excluded ? "excluded" : "uncertain"]))

/** The alphabet entries whose drains deliver one of these event types, tagged. */
function entriesFor(coverage: Coverage, types: readonly string[]): string[] {
  const out = new Set<string>()
  for (const [entry, delivered] of Object.entries(coverage.entryTypes)) if (delivered.some((type) => types.includes(type))) out.add(entry)
  for (const entry of ALPHABET) if (types.some((type) => entry.key === type || entry.key.startsWith(`${type}:`))) out.add(entry.key)
  return [...out].filter((entry) => UNCERTAIN.has(entry)).sort().map((entry) => `${entry} (${UNCERTAIN.get(entry)})`)
}

function strengthOf(candidate: Candidate, staticEntry: StaticEntry | undefined, vacuous: boolean): Strength {
  if (candidate.likely === "defensive") return "defensive (keep)"
  if (staticEntry?.class === "defensive") return "defensive (keep)"
  if (candidate.kind === "equivalent-states") return "bounded only"
  if (staticEntry && staticEntry.class !== "live") return vacuous ? "static (graph vacuous)" : "strong"
  return "bounded only"
}

/** The arms no search steps: a "never read" or "same future" holds only for the steps taken. */
const NOT_STEPPED = Object.keys(EXCLUDED_TYPES).map((type) => `${type} (excluded, never stepped)`)

/** vacuous: the graph agrees by construction (a constant field, or an item only excluded entries build). */
function finish(candidate: Candidate, vacuous = false): Candidate {
  const staticEntry = STATIC_SLICE[candidate.item]
  const out: Candidate = { ...candidate }
  if (candidate.kind === "field" || candidate.kind === "equivalent-states") {
    // for a field, the extra steps uncertain entries add cannot hide a read.
    // What can hide a read, or a difference between two states, is a step the
    // bounds never take: the arms never stepped, and cells never delivered
    // (an equivalence item names the latter itself)
    out.dependsOn = [...(candidate.dependsOn ?? []), ...NOT_STEPPED]
  }
  if (staticEntry) {
    out.staticVerdict = `${staticEntry.class}: ${staticEntry.verdict}`
    if (staticEntry.question) out.question = staticEntry.question
    if (staticEntry.wait) out.wait = staticEntry.wait
    if (staticEntry.class === "defensive" && out.likely === "dead") out.likely = "defensive"
  }
  out.strength = strengthOf(out, staticEntry, vacuous)
  return out
}

export function candidates(result: ActorBfsResult, options: { equivalenceDepth: 3 }): Candidate[] {
  const coverage = result.coverage
  if (!coverage) throw new Error("candidates needs a search run with coverageObserver (result.coverage)")
  const bounds = coverage.bounds
  const witnesses = witnessCoverage()
  const list: Candidate[] = []

  const reached = (cells: Record<string, number>, region: string, type: string) => (cells[`${region}|${type}`] ?? 0) > 0

  // 1. fields
  for (const path of FIELD_PATHS) {
    const field = coverage.fields[path]
    if (!field || field.values.length === 0) continue
    const item = `actor.${path}`
    const worldNote = WORLD_READS.has(path) ? " The fact world reads this field as Mesh's own copy; only the actor's own reads were forced." : ""
    const held = Object.keys(HELD_CONSTANTS).filter((key) => key.endsWith(`.${path.split(".").pop()}`)).map((key) => `held constant ${key}`)
    if (field.matters) {
      const staticEntry = STATIC_SLICE[item]
      if (staticEntry && staticEntry.class !== "live" && staticEntry.class !== "defensive") {
        list.push({
          kind: "field", item, likely: "generator-gap", bounds, strength: "static only", dependsOn: NOT_STEPPED,
          why: `the graph shows a read: forcing it changed ${field.matters.what} on ${field.matters.entry} (${field.matters.event} in ${field.matters.region}).${worldNote}`,
          staticVerdict: `${staticEntry.class}: ${staticEntry.verdict}`, ...(staticEntry.question ? { question: staticEntry.question } : {}), ...(staticEntry.wait ? { wait: staticEntry.wait } : {}),
        })
      }
      continue
    }
    const constant = field.values.length === 1
    const why = constant
      ? `constant within bounds (always ${field.values[0]}): forcing it is vacuous, so this says only that the search never changed it.${worldNote}`
      : `forced to ${JSON.stringify(getPath(REFERENCE, path))} in every step input and successor, it changed no command Mesh reads and no other field (values seen: ${field.values.slice(0, 6).join(", ")}${field.values.length > 6 ? ", …" : ""}).${field.shadowOnly ? ` It changed only command accounting metadata, first on ${field.shadowOnly.entry}.` : ""}${worldNote}`
    if (path === "lastAttemptAt") {
      list.push(finish({ kind: "field", item, likely: "defensive", bounds, why: `${why} Never removable: it is the backoff clock (decideSupervisor's backoff).`, dependsOn: held }))
      continue
    }
    // a decision read the static slice found, never exercised within bounds: the search's gap, not unused code
    const liveRead = STATIC_SLICE[item]?.class === "live"
    list.push(finish({
      kind: "field", item, likely: liveRead ? "generator-gap" : "dead", bounds,
      why: liveRead ? `${why} The static slice finds a decision read, so the search never drove it with a value that matters there: do not delete.` : why,
      ...(held.length > 0 ? { dependsOn: held } : {}),
    }, constant))
  }

  // 2. equivalent states, as region pairs. Every region merge holds with the
  // with command accounting metadata excluded from Mesh's decision view.
  const link = coverage.fields.link
  const regionNote = link && !link.matters
    ? "Forcing actor.link changed nothing Mesh reads within the bounds: the link decides nothing yet (stepPeerActor reads it only for its closed guard)."
    : ""
  const neverIn = (region: string) => EVENT_TYPES.filter((type) => !EXCLUDED_TYPES[type] && !REGIONS.every((other) => !reached(coverage.cells, other, type)) && !reached(coverage.cells, region, type))
  const equivalenceBounds = `${bounds}; futures compared to depth ${options.equivalenceDepth} over expanded nodes only`
  for (const [item, summary] of [...equivalentStates(result, options.equivalenceDepth)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const top = [...summary.paths].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([path, count]) => `${path} (${count})`)
    const [first, second] = item.replace("regions ", "").split(" + ") as [string, string]
    const missing = [first, second].flatMap((region) => neverIn(region).map((type) => `${type} in ${region}`))
    list.push(finish({
      kind: "equivalent-states", item, likely: "dead", bounds: equivalenceBounds,
      why: [
        `${summary.groups} group${summary.groups === 1 ? "" : "s"} (${summary.states} states) hold both regions with identical labelled futures to depth ${options.equivalenceDepth}.`,
        `In ${summary.groups - summary.pure} of ${summary.groups} the whole world states differ in more than the region${top.length > 0 ? ` (most often ${top.join(", ")})` : ""}: this is equivalence of world states, not proof that the regions merge.`,
        `Depth ${options.equivalenceDepth} cannot see a difference that shows only after 4 or more events (the 30 s yield and stall paths are beyond it).`,
        missing.length > 0 ? `Never delivered within the bounds: ${missing.join(", ")}.` : "",
        regionNote,
      ].filter(Boolean).join(" "),
      wait: REGION_WAIT,
    }))
  }

  // 3a. cells
  const table = tableTypes()
  for (const type of EVENT_TYPES) {
    const anywhere = REGIONS.some((region) => reached(coverage.cells, region, type))
    if (!anywhere) {
      const excluded = EXCLUDED_TYPES[type]
      list.push(finish({
        kind: "unreached-cell", item: `${type} (every region)`, likely: excluded ? "dead" : REGIONS.some((region) => reached(witnesses.cells, region, type)) ? "generator-gap" : "dead", bounds,
        why: excluded ? `the world never builds it: ${excluded}` : "no actor step of the search had this event type",
        dependsOn: entriesFor(coverage, [type]),
      }, Boolean(excluded)))
      continue
    }
  }
  const closedTypes: string[] = []
  for (const region of REGIONS) {
    for (const type of EVENT_TYPES) {
      if (EXCLUDED_TYPES[type]) continue
      if (!REGIONS.some((other) => reached(coverage.cells, other, type))) continue
      if (reached(coverage.cells, region, type)) continue
      if (region === "closed") {
        closedTypes.push(type)
        continue
      }
      const inTable = table.get(region)?.has(type) ?? false
      const inWitness = reached(witnesses.cells, region, type)
      // the event type is live elsewhere: a missing cell is the world's gap, not code to delete
      list.push(finish({
        kind: "unreached-cell", item: `${region} × ${type}`, likely: "generator-gap", bounds,
        why: `the search delivers ${type} in other regions, never in this one; ${inTable ? "the transition table declares a transition here" : inWitness ? "a witness of peer.definition reaches it" : "the transition table has no key for it and no witness reaches it"}`,
        dependsOn: entriesFor(coverage, [type]),
      }))
    }
  }
  if (closedTypes.length > 0) {
    list.push(finish({ kind: "unreached-cell", item: `closed × ${closedTypes.length} event types`, likely: "defensive", bounds, why: `stepPeerActor's closed guard drops every fact; the world sends a closed actor no facts, only queued drain events (${closedTypes.slice(0, 6).join(", ")}${closedTypes.length > 6 ? ", …" : ""})` }))
  }

  // 3b. command kinds
  for (const kind of COMMAND_KINDS) {
    if ((coverage.commands[kind] ?? 0) > 0) continue
    const inWitness = (witnesses.commands[kind] ?? 0) > 0
    list.push(finish({ kind: "unreached-command", item: kind, likely: inWitness ? "generator-gap" : "dead", bounds, why: inWitness ? "a witness of peer.definition emits it" : "no witness emits it either" }))
  }

  // 3c. replace-connection causes
  for (const [cause, { from }] of Object.entries(CAUSES)) {
    if ((coverage.causes[cause] ?? 0) > 0) continue
    const live = from.filter((type) => !EXCLUDED_TYPES[type])
    const inWitness = (witnesses.causes[cause] ?? 0) > 0
    list.push(finish({
      kind: "unreached-cause", item: cause, likely: live.length === 0 ? "dead" : inWitness ? "generator-gap" : "dead", bounds,
      why: `emitted from ${from.join(" or ")}${live.length === 0 ? ", none of which the world sends with the actor driving" : ""}; ${inWitness ? "a witness of peer.definition emits it" : "no witness emits it"}`,
      dependsOn: entriesFor(coverage, from),
    }, live.length === 0))
  }

  // 3d. completion sites
  for (const site of SITES) {
    if ((coverage.sites[site] ?? 0) > 0) continue
    const inWitness = (witnesses.sites[site] ?? 0) > 0
    list.push(finish({ kind: "unreached-site", item: site, likely: inWitness ? "generator-gap" : "dead", bounds, why: inWitness ? "a witness of peer.definition stamps it" : "no witness stamps it either", dependsOn: entriesFor(coverage, ["command-completed"]).filter((entry) => entry.includes(site)) }))
  }

  // 3e. the ignore guards: defensive, never deletable
  for (const guard of GUARDS) {
    if ((coverage.ignored[guard] ?? 0) > 0) continue
    list.push(finish({ kind: "unreached-guard", item: guard, likely: "defensive", bounds, why: guard === "stale-room" ? "the world has one room generation, so no fact is from another; the guard protects against late facts from an old room visit" : "a guard against late, duplicate or held facts the search did not produce" }))
  }
  return list
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const STRENGTH_ORDER: Strength[] = ["strong", "static (graph vacuous)", "bounded only", "defensive (keep)", "static only"]

/** The report's sections, in order: each candidate lands in the first that takes it. */
const SECTIONS: { title: string; takes: (candidate: Candidate) => boolean }[] = [
  { title: "Strong: the graph and the static slice agree", takes: (c) => c.strength === "strong" },
  { title: "Static (graph vacuous): they agree only by construction", takes: (c) => c.strength === "static (graph vacuous)" },
  { title: "Region merges (design B)", takes: (c) => c.kind === "equivalent-states" },
  { title: "Defensive (keep)", takes: (c) => c.strength === "defensive (keep)" },
  { title: "Coverage gaps (the search's, not deletion candidates)", takes: (c) => c.strength === "bounded only" },
  { title: "Static only", takes: () => true },
]

const agreed = (candidate: Candidate) => candidate.strength === "strong" || candidate.strength === "static (graph vacuous)"
const named = (candidate: Candidate) => (candidate.wait && candidate.wait.startsWith("no,") ? `${candidate.item} (${candidate.wait.slice(4)})` : candidate.item)

const sentence = (text: string) => (/[.)]$/.test(text) ? text : `${text}.`)

function line(candidate: Candidate): string {
  const parts = [`- **[${candidate.kind}] ${candidate.item}**: likely ${candidate.likely}, uncovered within bounds (${candidate.bounds}). ${sentence(candidate.why)}`]
  parts.push(`Depends on: ${candidate.dependsOn && candidate.dependsOn.length > 0 ? candidate.dependsOn.join(", ") : "no uncertain tag"}.`)
  if (candidate.staticVerdict) parts.push(`Static slice: ${candidate.staticVerdict}.`)
  if (candidate.question) parts.push(`Sheet: ${candidate.question}.`)
  if (candidate.wait) parts.push(`Wait: ${candidate.wait}.`)
  return parts.join(" ")
}

/** Unreached cells of one event type with the same reading, as one line. */
function groupCells(section: readonly Candidate[]): Candidate[] {
  const out: Candidate[] = []
  const groups = new Map<string, Candidate>()
  for (const candidate of section) {
    const [region, type] = candidate.item.split(" × ")
    if (candidate.kind !== "unreached-cell" || type === undefined || region === "closed") {
      out.push(candidate)
      continue
    }
    const key = [type, candidate.likely, candidate.why, candidate.strength, (candidate.dependsOn ?? []).join()].join("\u0000")
    const group = groups.get(key)
    if (group) group.item = `${group.item.split(" × ")[0]}, ${region} × ${type}`
    else {
      const copy = { ...candidate }
      groups.set(key, copy)
      out.push(copy)
    }
  }
  return out
}

export function renderCandidates(list: readonly Candidate[], notes: readonly string[] = []): string {
  const counts = STRENGTH_ORDER.map((strength) => `${list.filter((candidate) => candidate.strength === strength).length} ${strength}`)
  const out = [
    "# Peer actor: simplification candidates (phase B)",
    "",
    "Every item below is uncovered within bounds, never proven unused. A deletion needs an independent semantic argument plus normal regression tests.",
    "",
    ...notes,
    ...(notes.length > 0 ? [""] : []),
    `Counts: ${counts.join(", ")}.`,
    "",
    `- **Deletable now** (graph and static slice agree, nothing to wait for): ${list.filter((c) => agreed(c) && c.likely === "dead" && c.wait?.startsWith("no")).map(named).join(", ") || "none"}.`,
    `- **Wait for design B** (nothing reads it since step 9): ${list.filter((c) => agreed(c) && c.wait?.includes("design B")).map((c) => c.item).join(", ") || "none"}.`,
    "",
  ]
  const placed = new Set<Candidate>()
  for (const { title, takes } of SECTIONS) {
    const section = list.filter((candidate) => !placed.has(candidate) && takes(candidate))
    for (const candidate of section) placed.add(candidate)
    if (section.length === 0) continue
    out.push(`## ${title} (${section.length})`, "")
    for (const candidate of groupCells(section)) out.push(line(candidate))
    out.push("")
  }
  const tags = ALPHABET.filter((entry) => entry.uncertain || entry.excluded)
  out.push("## Alphabet entries tagged uncertain or excluded", "", ...tags.map((entry) => `- ${entry.key}: ${entry.excluded ? `excluded, ${entry.excluded}` : `uncertain, ${entry.uncertain}`}`), "")
  out.push("## Held constants", "", ...Object.entries(HELD_CONSTANTS).map(([key, why]) => `- ${key}: ${why}`), "")
  return out.join("\n")
}
