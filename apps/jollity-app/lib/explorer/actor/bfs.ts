// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The stateful breadth-first search over one real `stepPeerActor` in its fact
 * world (world.ts). One edge is one alphabet entry plus the
 * runner's whole synchronous drain after it: the follow-up facts the
 * commands' effects dispatch and the results they return at once, up to a
 * choice. Every actor step on the way is checked by the state-machine framework's checkStep against
 * peer.definition's invariants.
 *
 * Bounded evidence, never a proof: a result names its depth, fault budget
 * and whether its frontier closed. Time is event-driven (`advance`), so
 * there is no clock horizon: H = n/a.
 */
import { stepPeerActor, type PeerActorCommand, type PeerActorEvent, type PeerActorState, type PeerActorStep } from "../../state-machines/peer-actor"
import { peerMachineDefinition, type PeerEventKey, type PeerObservation, type PeerTestEvent } from "../../state-machines/peer.definition"
import { checkStep, type MachineDefinition, type TraceEntry } from "../../state-machines/framework"
import { ALPHABET, type AlphabetEvent } from "./alphabet"
import { canonical, outOfDomain } from "./canon"
import { applyCommand } from "./effects"
import type { Coverage } from "./candidates"
import { HELD_CONSTANTS, initialWorlds, meshLeave, superviseHead, tickEvent, type ActorWorld } from "./world"

export type Stepper = (state: PeerActorState, event: PeerActorEvent) => PeerActorStep

export interface ActorBfsResult {
  states: number
  /** edges found, kept in `graph` or not */
  edgeCount: number
  /** the state cap stopped the run before the depth bound */
  capped: boolean
  /** worlds reached but never expanded (the depth bound's or the cap's) */
  frontier: number
  /** what the world holds constant (world.ts HELD_CONSTANTS) */
  constants: Record<string, string>
  depthCompleted: number
  frontierClosed: boolean
  /** depth: worlds left at the depth bound; faults: fault edges past the
   *  budget; domain: worlds outside their declared range. A cap stop is
   *  `capped`, never a depth cut. */
  cuts: Record<"depth" | "faults" | "domain", number>
  violations: { invariant: string; path: string[] }[]
  graph: {
    nodes: string[]
    edges: [from: number, key: string, to: number, commands: string[]][]
    /** the start nodes */
    roots?: number[]
    /** nodes 0 .. expanded - 1 had every alphabet entry tried (BFS order) */
    expanded?: number
    /** the expanded nodes, for a merged graph whose expanded nodes are no prefix */
    expandedSet?: number[]
    /** nodes with an edge cut for leaving its declared range: their out-edges are incomplete */
    cut?: number[]
  }
  /** phase B's coverage, when the run had a coverageObserver */
  coverage?: Coverage
  /** each completed layer: the states found so far, the new ones, the heap in use and the time since the start (for the anchors' sizing) */
  layers?: LayerStat[]
}

export interface LayerStat {
  depth: number
  states: number
  added: number
  heapUsedMb: number
  elapsedMs: number
  cuts: Record<"depth" | "faults" | "domain", number>
}

/** A fully completed layer, with enough state to retain an interrupted run. */
export interface LayerProgress extends LayerStat {
  edgeCount: number
  frontierClosed: boolean
  violations: { invariant: string; path: string[] }[]
}

export interface ActorStep {
  event: PeerActorEvent
  before: PeerActorState
  result: PeerActorStep
}

export interface Successor {
  world: ActorWorld
  /** every command of the edge, across its drain, in issue order */
  commands: PeerActorCommand[]
  steps: ActorStep[]
}

/** A command as an edge label: its kind and what it carries, no epochs. */
export function commandLabel(command: PeerActorCommand): string {
  const parts: string[] = [command.kind]
  if ("cause" in command) parts.push(command.cause)
  if ("lane" in command) parts.push(command.lane ? "lane" : "statement")
  if ("track" in command) parts.push(command.track ?? "none")
  if (command.kind === "replace-connection") {
    parts.push(command.initiate ? "offer" : "answer")
    if (command.answererMayOffer) parts.push("leave")
  }
  return parts.join(":")
}

/** One edge: the entry's fact, then the drain up to an empty queue or a choice. */
export function successor(world: ActorWorld, entry: AlphabetEvent, step: Stepper = stepPeerActor): Successor | null {
  // a fault past the budget is not an edge (bfs counts it as a fault cut)
  if (entry.fault && world.faultsLeft <= 0) return null
  const built = entry.build(world)
  if (!built) return null
  const next = built.world
  if (entry.fault) next.faultsLeft -= 1
  const steps: ActorStep[] = []
  const commands: PeerActorCommand[] = []
  const run = (event: PeerActorEvent) => {
    const before = next.actor
    const result = step(before, event)
    next.actor = result.state
    // Mesh's leave to offer moves with the step, before its commands run
    const leave = meshLeave(next.mesh.leave, before, event, result)
    if (leave !== next.mesh.leave) next.mesh = { ...next.mesh, leave }
    steps.push({ event, before, result })
    // the runner: every command of the program runs, in order (peer-runner.ts:100-104)
    for (const command of result.commands) {
      commands.push(command)
      applyCommand(next, command)
    }
  }
  run(built.event)
  while (next.queue.length > 0 && next.queue[0]!.type !== "choice") {
    const head = next.queue.shift()!
    if (head.type === "event") run(head.event)
    else if (head.type === "tick") run(tickEvent(next))
    else if (head.type === "sweep" && !next.actor.hidden && next.actor.link !== "closed") run(superviseHead(next))
  }
  return { world: next, commands, steps }
}

/** checkStep over one actor step, with peer.definition's invariants and
 *  observation. The model side is the same stepper on the same state, so the
 *  observation check is trivial: the step is checked for its invariants. */
function checker(step: Stepper): MachineDefinition<PeerActorState, PeerActorState, PeerTestEvent, PeerActorStep, PeerActorStep, PeerObservation, "world", "*"> {
  const run = (state: PeerActorState, test: PeerTestEvent) => {
    const output = step(state, test.event)
    return { state: output.state, output }
  }
  return {
    name: "peer-actor-bfs",
    initialReal: () => initialWorlds()[0]!.world.actor,
    initialModel: () => initialWorlds()[0]!.world.actor,
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
    invariants: peerMachineDefinition.invariants as unknown as MachineDefinition<PeerActorState, PeerActorState, PeerTestEvent, PeerActorStep, PeerActorStep, PeerObservation, "world", "*">["invariants"],
  }
}

/** peer.definition's invariants that key on the event (presentation has no
 *  recovery authority, round reset retains the unseen budget, stale facts emit
 *  no effects) read its witness keys. Every actor step, the entry's own and
 *  each one later in its drain, gets the key of what it is: a fact for
 *  another connection or a completion for a command no longer open is
 *  `stale-…`, a standby change `standby`, a round change `round-change`. */
export function invariantKey(event: PeerActorEvent, before: PeerActorState): string {
  const crossesConnections = event.type === "round-changed" || event.type === "room-closed" || event.type === "connection-replaced-externally"
  if (!crossesConnections && event.connectionEpoch !== before.connectionEpoch) return "stale-connection"
  if (event.type === "command-completed" && before.openCommands[event.commandKind] !== event.commandEpoch) return "stale-command"
  if (event.type === "standby-changed") return "standby"
  if (event.type === "round-changed") return "round-change"
  return event.type
}

export interface BfsOptions {
  /** start here instead of initialWorlds(bounds.faults) */
  initial?: ActorWorld[]
  step?: Stepper
  /** keep every node's world (for the equivalence and mutation tests) */
  keepWorlds?: boolean
  /** run checkStep on every actor step (default true) */
  check?: boolean
  /** index visited worlds by a 64-bit hash of their key instead of the key
   *  itself (hash compaction): a collision would merge two worlds, with
   *  probability about n^2 / 2^65 for n states (`collisionBound`) */
  hash?: boolean
  /** how many Maps the visited index is split across (default 64) */
  shards?: number
  /** keep the graph's full keys and edges (default true); off, the result
   *  counts edges but holds no keys, for sizing runs */
  graph?: boolean
  /** called on every actor step of every successor taken from an expanded
   *  world, with the alphabet entry that started its edge (phase B) */
  observe?: (step: ActorStep, entryKey: string) => void
  /** called exactly once after each whole BFS layer has finished */
  onLayer?: (layer: LayerProgress) => void
}

/** A 64-bit hash of a string as a four-code-unit key: two 32-bit
 *  multiply-xorshift lanes (cyrb53's mixing, kept to 64 bits). */
export function hash64(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return String.fromCharCode(h1 >>> 16, h1 & 0xffff, h2 >>> 16, h2 & 0xffff)
}

/** The visited index, split across several Maps: V8 caps one Map at 2^24
 *  (about 16.8 M) entries, and a d = 8 search holds more. A key's shard comes
 *  from a hash of the whole key, so full keys spread as hashed ones do. An
 *  optional per-shard capacity makes a full shard throw, as V8 would. */
export class ShardedIndex {
  private readonly shards: Map<string, number>[]
  constructor(shardCount = 64, private readonly capacity = Number.POSITIVE_INFINITY) {
    this.shards = Array.from({ length: shardCount }, () => new Map<string, number>())
  }

  /** FNV-1a over the whole key: full canonical keys share long prefixes and
   *  suffixes, so a few code units would put them all in one shard. */
  private shard(key: string): Map<string, number> {
    let mix = 0x811c9dc5
    for (let at = 0; at < key.length; at++) mix = Math.imul(mix ^ key.charCodeAt(at), 16777619)
    return this.shards[(mix >>> 0) % this.shards.length]!
  }

  get(key: string): number | undefined {
    return this.shard(key).get(key)
  }

  has(key: string): boolean {
    return this.shard(key).has(key)
  }

  set(key: string, value: number): void {
    const shard = this.shard(key)
    if (!shard.has(key) && shard.size >= this.capacity) throw new RangeError(`index shard full at ${this.capacity} entries`)
    shard.set(key, value)
  }

  get size(): number {
    return this.shards.reduce((total, shard) => total + shard.size, 0)
  }

  /** the largest shard's entry count */
  get largest(): number {
    return Math.max(...this.shards.map((shard) => shard.size))
  }
}

/** The birthday bound on any collision among n 64-bit hashes. */
export const collisionBound = (states: number): number => (states * (states - 1)) / 2 ** 65

export function bfs(bounds: { depth: number; maxStates: number; faults: number }, options: BfsOptions = {}): ActorBfsResult & { worlds?: ActorWorld[] } {
  const step = options.step ?? stepPeerActor
  const definition = checker(step)
  const check = options.check ?? true
  const nodes: string[] = []
  const parents: [parent: number, key: string][] = []
  const index = new ShardedIndex(options.shards ?? 64)
  const hashed = options.hash ?? false
  const keepGraph = options.graph ?? true
  let edgeCount = 0
  let states = 0
  const edges: ActorBfsResult["graph"]["edges"] = []
  const violations: ActorBfsResult["violations"] = []
  const cuts = { depth: 0, faults: 0, domain: 0 }
  const worlds: ActorWorld[] = []
  const roots: number[] = []
  const cutNodes = new Set<number>()
  let expandedNodes = 0
  let frontier: { node: number; world: ActorWorld }[] = []
  let exhausted = false
  const path = (node: number, last?: string): string[] => {
    const keys: string[] = []
    for (let at = node; parents[at]![0] >= 0; at = parents[at]![0]) keys.unshift(parents[at]![1])
    if (last) keys.push(last)
    return keys
  }
  const add = (world: ActorWorld, key: string, parent: number, via: string): number => {
    const node = states++
    if (keepGraph) nodes.push(key)
    parents.push([parent, via])
    index.set(hashed ? hash64(key) : key, node)
    if (options.keepWorlds) worlds.push(world)
    return node
  }

  for (const world of options.initial ?? initialWorlds(bounds.faults).map((start) => start.world)) {
    if (outOfDomain(world)) {
      cuts.domain += 1
      continue
    }
    const key = canonical(world)
    if (!index.has(hashed ? hash64(key) : key)) {
      const node = add(world, key, -1, "")
      roots.push(node)
      frontier.push({ node, world })
    }
  }

  const layers: LayerStat[] = []
  const startedAt = Date.now()
  let depthCompleted = 0
  let frontierClosed = frontier.length === 0
  let pendingNext = 0
  let expandedInLayer = 0
  for (let depth = 0; depth < bounds.depth && !frontierClosed && !exhausted; depth++) {
    const next: typeof frontier = []
    expandedInLayer = 0
    for (const { node, world } of frontier) {
      expandedInLayer += 1
      for (const entry of ALPHABET) {
        if (entry.excluded) continue
        if (entry.fault && world.faultsLeft <= 0) {
          if (entry.build(world)) cuts.faults += 1
          continue
        }
        const result = successor(world, entry, step)
        if (!result) continue
        if (options.observe) for (const actorStep of result.steps) options.observe(actorStep, entry.key)
        if (check) {
          for (const actorStep of result.steps) {
            try {
              const key = invariantKey(actorStep.event, actorStep.before)
              checkStep({ definition, real: actorStep.before, model: actorStep.before, event: { key: key as PeerEventKey, event: actorStep.event }, step: 0, label: entry.key, trace: [] as TraceEntry<PeerTestEvent, PeerObservation, "world", "*">[] })
            } catch (error) {
              if (violations.length < 100) violations.push({ invariant: (error instanceof Error ? error.message : String(error)).split("\n")[0]!, path: path(node, entry.key) })
            }
          }
        }
        if (outOfDomain(result.world)) {
          cuts.domain += 1
          cutNodes.add(node)
          continue
        }
        const key = canonical(result.world)
        let target = index.get(hashed ? hash64(key) : key)
        if (target === undefined) {
          if (states >= bounds.maxStates) {
            exhausted = true
            break
          }
          target = add(result.world, key, node, entry.key)
          next.push({ node: target, world: result.world })
        }
        edgeCount += 1
        if (keepGraph) edges.push([node, entry.key, target, result.commands.map(commandLabel)])
      }
      if (exhausted) break
      expandedNodes += 1
    }
    if (exhausted) {
      pendingNext = next.length
      break
    }
    depthCompleted = depth + 1
    frontier = next
    if (next.length === 0) frontierClosed = true
    const layer: LayerStat = {
      depth: depthCompleted,
      states,
      added: next.length,
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
      elapsedMs: Date.now() - startedAt,
      cuts: { depth: next.length, faults: cuts.faults, domain: cuts.domain },
    }
    layers.push(layer)
    options.onLayer?.({
      ...layer,
      edgeCount,
      frontierClosed,
      violations: violations.map((violation) => ({ ...violation, path: [...violation.path] })),
    })
  }
  if (!frontierClosed && !exhausted) cuts.depth = frontier.length
  return {
    states,
    edgeCount,
    capped: exhausted,
    // on a cap stop: the rest of the layer being expanded (the node the cap
    // stopped in included) and the part of the next layer already found
    frontier: frontierClosed ? 0 : exhausted ? frontier.length - expandedInLayer + 1 + pendingNext : frontier.length,
    constants: HELD_CONSTANTS,
    depthCompleted,
    frontierClosed,
    cuts,
    violations,
    graph: { nodes, edges, roots, expanded: expandedNodes, cut: [...cutNodes] },
    layers,
    ...(options.keepWorlds ? { worlds } : {}),
  }
}

/** Walks a prefix of alphabet keys from a world; throws at a key the world does not enable. */
export function walk(world: ActorWorld, keys: readonly string[], step: Stepper = stepPeerActor): ActorWorld {
  let at = world
  for (const key of keys) {
    const entry = ALPHABET.find((candidate) => candidate.key === key)
    if (!entry) throw new Error(`no alphabet entry ${key}`)
    const next = successor(at, entry, step)
    if (!next) throw new Error(`${key} is not enabled after ${keys.slice(0, keys.indexOf(key)).join(", ") || "the start"}`)
    at = next.world
  }
  return at
}

/** The fair runs: each side's happy path to a connected link with video
 *  flowing, made of real enabled labels only. Searches seeded from them
 *  reach the deep states (stalls, heals, glare on the lane) that a search
 *  from the start reaches only past depth 10. */
export const FAIR_RUNS: Record<"initiator" | "answerer", readonly string[]> = {
  initiator: [
    "local-offer-requested",
    "complete:send-offer:statement:resolved",
    "description:statement-answer",
    "complete:set-remote-description:statement-answer:resolved",
    "connection-observed:connected",
    "channel-observed:open",
    "local-offer-requested",
    "complete:send-offer:lane:resolved",
    "description:lane-answer",
    "complete:set-remote-description:lane-answer:resolved",
    "stats:advance",
  ],
  answerer: [
    "description:statement-offer",
    "complete:set-remote-description:statement-offer:resolved",
    "complete:send-answer:statement:resolved",
    "connection-observed:connected",
    "channel-observed:open",
    "description:lane-offer",
    "complete:set-remote-description:lane-offer:resolved",
    "complete:send-answer:lane:resolved",
    "stats:advance",
  ],
}

/** Longer real-label prefixes from the fair runs' ends, for the probes whose
 *  precondition needs a heal already spent: the initiator's media-stall ICE
 *  restart (two still reads, stallAfter 2), and the answerer's (six, which
 *  also grants it the leave to offer). */
const SEED_RUNS: Record<string, { from: "initiator" | "answerer"; keys: readonly string[] }> = {
  "initiator-stall-healed": { from: "initiator", keys: [...FAIR_RUNS.initiator, "stats:same", "stats:same", "complete:restart-ice:resolved"] },
  "answerer-stall-healed": { from: "answerer", keys: [...FAIR_RUNS.answerer, ...Array<string>(6).fill("stats:same"), "complete:restart-ice:resolved"] },
  // the answerer's own lane offer answered, then video again: its local
  // description is an offer while the leave to offer is spent
  "answerer-offered": {
    from: "answerer",
    keys: [...FAIR_RUNS.answerer, ...Array<string>(6).fill("stats:same"), "complete:restart-ice:resolved", "local-offer-requested", "complete:send-offer:lane:resolved", "description:lane-answer", "complete:set-remote-description:lane-answer:resolved", "stats:advance"],
  },
  // our statement offer on a rebuilt link went 30 s unanswered: this side
  // yielded, took the far end's offer, and its answer is still on its way
  "initiator-yielded-took-offer": {
    from: "initiator",
    keys: [
      ...FAIR_RUNS.initiator, "connection-observed:failed", "supervisor-tick", "local-offer-requested", "complete:send-offer:statement:resolved",
      "advance", "advance", "advance", "advance", "advance",
      "description:statement-offer:from-answerer", "complete:set-remote-description:statement-offer:resolved", "advance", "advance", "advance",
    ],
  },
  // video was seen this round, the link failed and was rebuilt, and the new
  // one connected: no channel yet
  "initiator-reconnected": {
    from: "initiator",
    keys: [...FAIR_RUNS.initiator, "connection-observed:failed", "supervisor-tick", "local-offer-requested", "complete:send-offer:statement:resolved", "description:statement-answer", "complete:set-remote-description:statement-answer:resolved", "connection-observed:connected"],
  },
}

/** The ends of the seed runs. */
export function seedWorlds(faults: number): ActorWorld[] {
  const starts = Object.fromEntries(initialWorlds(faults).map(({ label, world }) => [label, world]))
  return Object.values(SEED_RUNS).map(({ from, keys }) => walk(starts[from]!, keys))
}

/** Every world along both fair runs, with the given fault budget. */
export function fairWorlds(faults: number): ActorWorld[] {
  const out: ActorWorld[] = []
  for (const { label, world } of initialWorlds(faults)) {
    const keys = FAIR_RUNS[label as keyof typeof FAIR_RUNS]
    if (!keys) continue
    for (let length = 1; length <= keys.length; length++) out.push(walk(world, keys.slice(0, length)))
  }
  return out
}
