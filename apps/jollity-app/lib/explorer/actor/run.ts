// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `npm run explore -- --machine peer-actor`: the slice-3 search, as the CLI's
 * SearchResult. One level per run: its depth is the closed depth, its leaves
 * the states, and its cuts the search's depth and fault cuts (the CLI's cut
 * set has no domain cut: domain cuts go in the details). A run the state cap
 * stopped is inconclusive at its closed depth (exit 3); a violation is a
 * finding (exit 1).
 */
import type { SearchResult } from "../core/search"
import { ACTOR_ANCHORS, loadAnchor, type ActorAnchorName } from "./anchors"
import { bfs, collisionBound, fairWorlds, seedWorlds, type ActorBfsResult, type LayerProgress, type LayerStat } from "./bfs"
import { candidates, coverageObserver, mergeResults, renderCandidates, type Candidate } from "./candidates"

export interface PeerActorRun {
  result: SearchResult
  summary: Record<string, unknown>
}

export interface PeerActorOptions {
  depth: number
  faults: number
  maxStates: number
  hash: boolean
  anchor?: ActorAnchorName
  onLayer?: (layer: LayerProgress) => void
}

export interface PeerActorCheckpoint {
  options: Omit<PeerActorOptions, "onLayer">
  layer: LayerProgress
}

export function formatLayerProgress(layer: Pick<LayerStat, "depth" | "states" | "added" | "elapsedMs" | "heapUsedMb" | "cuts">): string {
  return `peer-actor depth=${layer.depth} states_new=${layer.added} states_total=${layer.states} elapsed_ms=${layer.elapsedMs} heap_used_mb=${layer.heapUsedMb} cuts_depth=${layer.cuts.depth} cuts_faults=${layer.cuts.faults} cuts_domain=${layer.cuts.domain}`
}

export function runPeerActor(options: PeerActorOptions): PeerActorRun {
  const started = Date.now()
  const initial = options.anchor === undefined ? undefined : [loadAnchor(options.anchor, options.faults)]
  const run = bfs(
    { depth: options.depth, maxStates: options.maxStates, faults: options.faults },
    { hash: options.hash, graph: !options.hash, initial, onLayer: options.onLayer },
  )
  const out = asRun(run, options, Date.now() - started)
  if (options.anchor === undefined) return out
  // a finding from an anchor replays from the start: the anchor's prefix, then its path
  const prefix = ACTOR_ANCHORS[options.anchor].keys
  for (const finding of out.result.findings) {
    finding.labels = [...prefix, ...finding.labels]
    finding.detail = `[anchor ${options.anchor}, from the ${ACTOR_ANCHORS[options.anchor].from} start] ${finding.detail}`
  }
  out.summary = { anchor: options.anchor, from: ACTOR_ANCHORS[options.anchor].from, prefixLength: prefix.length, ...out.summary }
  return out
}

/** The last whole layer as an ordinary inconclusive run; no partial layer is included. */
export function interruptedPeerActor(checkpoint: PeerActorCheckpoint): PeerActorRun {
  const { layer, options } = checkpoint
  const result: SearchResult = {
    levels: [{
      depth: layer.depth,
      leaves: layer.states,
      meanEnabled: layer.states === 0 ? 0 : layer.edgeCount / layer.states,
      cuts: { depth: layer.cuts.depth, faults: layer.cuts.faults, horizon: 0, quiet: 0, seen: 0, harness: 0 },
      details: {
        ...(layer.cuts.domain > 0 ? { domain: layer.cuts.domain } : {}),
        interrupted: 1,
      },
      elapsedMs: layer.elapsedMs,
    }],
    closedAtDepth: layer.depth,
    inconclusive: true,
    frontierClosed: layer.frontierClosed,
    findings: layer.violations.map((violation) => ({
      property: violation.invariant,
      labels: [...violation.path],
      atStep: violation.path.length,
      detail: violation.invariant,
      sampled: false,
    })),
  }
  return {
    result,
    summary: {
      states: layer.states,
      edges: layer.edgeCount,
      depthCompleted: layer.depth,
      frontierClosed: layer.frontierClosed,
      capped: false,
      frontier: layer.cuts.depth,
      cuts: layer.cuts,
      violations: layer.violations.length,
      hash: options.hash,
      ...(options.hash ? { collisionBound: collisionBound(layer.states) } : {}),
      layers: [layer],
      interruptedAtDepth: layer.depth,
    },
  }
}

/** What a run used and what one level deeper would need (the anchors' sizing): the
 *  last layer's heap per state, the growth of new states per layer, and the
 *  heap the next layer would take at the same bytes per state. */
function sizing(layers: readonly LayerStat[], peakRssMb: number): Record<string, number | null> {
  const last = layers[layers.length - 1]
  const prev = layers[layers.length - 2]
  if (!last || last.states === 0) return { peakRssMb, peakHeapMb: null, bytesPerState: null, growth: null, projectedStates: null, projectedHeapGb: null }
  const peakHeapMb = Math.max(...layers.map((layer) => layer.heapUsedMb))
  const bytesPerState = Math.round((last.heapUsedMb * 2 ** 20) / last.states)
  const growth = prev && prev.added > 0 ? last.added / prev.added : null
  const projectedStates = growth === null ? null : Math.round(last.states + last.added * growth)
  return {
    peakRssMb,
    peakHeapMb,
    bytesPerState,
    growth: growth === null ? null : Math.round(growth * 100) / 100,
    projectedStates,
    projectedHeapGb: projectedStates === null ? null : Math.round(((projectedStates * bytesPerState) / 2 ** 30) * 10) / 10,
  }
}

/** How a search ended, in the words of the verdict line. */
function ending(run: Pick<ActorBfsResult, "capped" | "frontierClosed" | "depthCompleted" | "states">): string {
  if (run.capped) return `inconclusive: the state cap stopped it with d = ${run.depthCompleted} complete, ${run.states} states`
  return run.frontierClosed ? `frontier closed, ${run.states} states` : `closed at the depth bound, ${run.states} states`
}

export interface PeerCandidatesRun {
  run: PeerActorRun
  list: Candidate[]
  markdown: string
  bounds: string
}

/** Phase B: two full-key searches with the coverage observer, from the
 *  initial worlds to `depth` and from every fair-run and seed-run world to
 *  `fairDepth`, merged into one graph. */
export function runPeerCandidates(options: { depth: number; fairDepth: number; faults: number; maxStates: number }): PeerCandidatesRun {
  const bounds = { maxStates: options.maxStates, faults: options.faults }
  const started = Date.now()
  const fromStart = coverageObserver()
  const start = bfs({ ...bounds, depth: options.depth }, { observe: fromStart.observe, graph: true, hash: false })
  const startMs = Date.now() - started
  const deepStarts = [...fairWorlds(options.faults), ...seedWorlds(options.faults)]
  const fromRuns = coverageObserver()
  const deep = bfs({ ...bounds, depth: options.fairDepth }, { initial: deepStarts, observe: fromRuns.observe, graph: true, hash: false })
  const startBounds = `d = ${options.depth} from the 3 initial worlds (${ending(start)})`
  const deepBounds = `d = ${options.fairDepth} from the ${deepStarts.length} fair-run and seed-run worlds (${ending(deep)})`
  const text = `${startBounds}; ${deepBounds}; F = ${options.faults}; H = n/a (event-driven time)`
  start.coverage = fromStart.coverage(startBounds)
  deep.coverage = fromRuns.coverage(deepBounds)
  const merged = mergeResults([start, deep])
  // per item, the short form; the notes carry how each search ended
  merged.coverage!.bounds = `d = ${options.depth} from the start, d = ${options.fairDepth} from the fair and seed runs, F = ${options.faults}, H = n/a`
  const list = candidates(merged, { equivalenceDepth: 3 })
  const notes = [
    `- Input: two full-key searches (no hashing, graph kept), merged by node key: ${text}.`,
    `- Merged graph: ${merged.graph.nodes.length} states, ${merged.graph.edges.length} edges; ${start.violations.length + deep.violations.length} invariant violations.`,
    "- Fields are forced to the initiator's start value on every actor step the searches took; Mesh only logs command attempt and heal metadata.",
    "- Uncertain entries mostly let the world send a fact more often than Mesh would; excluded entries and held constants are where the world sends less. A \"never\" depends on the latter.",
  ]
  return { run: asRun(start, { ...options, hash: false }, startMs), list, markdown: renderCandidates(list, notes), bounds: text }
}

function asRun(run: ActorBfsResult, options: { depth: number; faults: number; maxStates: number; hash: boolean }, elapsedMs: number): PeerActorRun {
  // a closed frontier proves every depth; otherwise the last full layer
  const closedAtDepth = run.frontierClosed ? options.depth : run.depthCompleted
  const result: SearchResult = {
    levels: [{
      depth: closedAtDepth,
      leaves: run.states,
      meanEnabled: run.states === 0 ? 0 : run.edgeCount / run.states,
      cuts: { depth: run.cuts.depth, faults: run.cuts.faults, horizon: 0, quiet: 0, seen: 0, harness: 0 },
      details: {
        ...(run.cuts.domain > 0 ? { domain: run.cuts.domain } : {}),
        ...(run.capped ? { [`state cap ${options.maxStates}`]: run.frontier } : {}),
      },
      elapsedMs,
    }],
    closedAtDepth,
    inconclusive: run.capped,
    frontierClosed: run.frontierClosed,
    findings: run.violations.map((violation) => ({ property: violation.invariant, labels: violation.path, atStep: violation.path.length, detail: violation.invariant, sampled: false })),
  }
  return {
    result,
    summary: {
      states: run.states,
      edges: run.edgeCount,
      depthCompleted: run.depthCompleted,
      frontierClosed: run.frontierClosed,
      capped: run.capped,
      frontier: run.frontier,
      cuts: run.cuts,
      violations: run.violations.length,
      hash: options.hash,
      ...(options.hash ? { collisionBound: collisionBound(run.states) } : {}),
      constants: run.constants,
      layers: run.layers ?? [],
      sizing: sizing(run.layers ?? [], Math.round(process.resourceUsage().maxRSS / 1024)),
    },
  }
}

/** Phase B over the union of full-key searches from the named anchors,
 *  each to `depth` with its own coverage observer, merged into one graph by
 *  node key. Every "never" line's bounds name each anchor it was searched
 *  from, with that search's depth and how it ended. */
export function runAnchorCandidates(options: { anchors: readonly ActorAnchorName[]; depth: number; faults: number; maxStates: number }): PeerCandidatesRun {
  const started = Date.now()
  const runs = options.anchors.map((anchor) => {
    const observer = coverageObserver()
    const run = bfs({ depth: options.depth, maxStates: options.maxStates, faults: options.faults }, { initial: [loadAnchor(anchor, options.faults)], observe: observer.observe, graph: true, hash: false })
    const bounds = `${anchor} d = ${run.frontierClosed ? options.depth : run.depthCompleted}${run.capped ? " (capped)" : ""}`
    run.coverage = observer.coverage(bounds)
    return { anchor, run, bounds, ending: ending(run) }
  })
  const merged = mergeResults(runs.map((entry) => entry.run))
  const searchedFrom = runs.map((entry) => entry.bounds).join(", ")
  merged.coverage!.bounds = `searched from the anchors ${searchedFrom}; F = ${options.faults} past each anchor; H = n/a`
  const list = candidates(merged, { equivalenceDepth: 3 })
  const text = runs.map((entry) => `${entry.anchor}: d = ${options.depth} (${entry.ending})`).join("; ")
  const notes = [
    `- Input: ${runs.length} full-key searches (no hashing, graph kept), one from each anchor, merged by node key: ${text}; F = ${options.faults} past each anchor.`,
    `- Merged graph: ${merged.graph.nodes.length} states, ${merged.graph.edges.length} edges; ${runs.reduce((sum, entry) => sum + entry.run.violations.length, 0)} invariant violations.`,
    "- Each item's bounds name every anchor the union was searched from: a \"never\" holds for all of them together, each to its own depth.",
    "- Fields are forced to the initiator's start value on every actor step the searches took; Mesh only logs command attempt and heal metadata.",
  ]
  // the run's own numbers are the union's, as one level
  const all = runs.map((entry) => entry.run)
  const union: ActorBfsResult = {
    ...merged,
    depthCompleted: Math.min(...all.map((run) => run.depthCompleted)),
    cuts: { depth: all.reduce((s, r) => s + r.cuts.depth, 0), faults: all.reduce((s, r) => s + r.cuts.faults, 0), domain: all.reduce((s, r) => s + r.cuts.domain, 0) },
    violations: all.flatMap((run, index) => run.violations.map((violation) => ({ ...violation, path: [...ACTOR_ANCHORS[runs[index]!.anchor].keys, ...violation.path] }))),
    frontier: all.reduce((s, r) => s + r.frontier, 0),
    layers: [],
  }
  return { run: asRun(union, { ...options, hash: false }, Date.now() - started), list, markdown: renderCandidates(list, notes), bounds: merged.coverage!.bounds }
}
