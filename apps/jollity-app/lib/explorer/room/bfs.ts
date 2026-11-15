// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The room's stateful BFS (design M3), one process, no worker threads.
 *
 * Memory: a visited state costs its packed key (interned pair and phone ids,
 * key.ts) in a sharded Map plus a parent index and a label index in typed
 * arrays. No world is kept: a node to expand is rebuilt by replaying its
 * labels from the start room, with the previous node's path cached, so
 * consecutive nodes of one parent cost one replay step each. Replay is
 * exact (step() is deterministic), so the rebuilt state is the one that was
 * first found, not merely one with an equal key.
 *
 * Stops: the depth bound, `maxStates` (a clean stop with the layers so far,
 * `capped`), and a heap watermark (`heapStopMb`, `heapStopped`): an
 * out-of-memory kill would lose the summary.
 */
import { inclusion, invariantViolations, localityViolations, quietViolations, recoveryViolations, rp7Violations, type InclusionResult } from "./checks"
import { inclusionSampled, Interner, roomKey, roomKeyParts, stateIdOf, stateSample } from "./key"
import { candidateLabels, quiet, step, type InclusionGap, type Room, type Successor } from "./model"
import { checkIndependence, chooseAmple, emptyPorCheck, type FootprintOverride, type PorCheck } from "./por"


export interface RoomBfsOptions {
  depth: number
  maxStates: number
  /** stop cleanly when the heap in use passes this many MB */
  heapStopMb?: number
  /** the inclusion check on 1 edge in N (1: every edge; 0: never) */
  inclusionEvery?: number
  /** RP10's fair continuation from 1 new state in N (0: never) */
  probeEvery?: number
  /** RP7's reloaded phone and the F past the anchor */
  rp7?: { reloaded: number; faults: number }
  /** called once per finished layer */
  onLayer?: (layer: RoomLayer) => void
  /**
   * How the inclusion and RP10 samples are picked. "order" (the default): 1 in N by discovery order (the
   * global node index and record counter). "key": 1 in N by the state's 128-bit id (key.ts stateSample,
   * inclusionSampled), which does not depend on the order states are reached in, so the tiled map
   * (tiled.ts) picks the same samples and its findings can be compared count for count.
   */
  sampling?: "order" | "key"
  /** keep every reached room (tests only) */
  keepRooms?: boolean
  /** ample-set partial-order reduction (por.ts; ROOM_POR=1). Off: the search is exactly the full one. */
  por?: boolean
  /** with `por`: check the independence relation's claims on 1 state in N, by state id (0: never) */
  porCheck?: number
  /** tests only: a wrong footprint for the negative control */
  porOverride?: FootprintOverride
}

interface PorStats {
  /** quiet states expanded, and how many of them with a reduced ample set */
  expanded: number
  reduced: number
  /** why a state took the full set */
  full: Record<string, number>
  /** enabled labels and labels taken, summed over expanded states */
  enabled: number
  taken: number
  check: PorCheck
}

interface RoomLayer {
  depth: number
  states: number
  added: number
  distinctPairs: number
  heapUsedMb: number
  elapsedMs: number
}

export interface RoomFinding {
  property: string
  detail: string
  /** labels from the start room */
  labels: string[]
}

export interface RoomBfsResult {
  states: number
  edges: number
  depthCompleted: number
  frontierClosed: boolean
  capped: boolean
  heapStopped: boolean
  layers: RoomLayer[]
  distinctPairs: number
  distinctPairsPerPosition: number[]
  distinctPhones: number
  /** average key sizes per state (UTF-16 code units): the full texts vs the packed key */
  keyChars: { full: number; packed: number }
  /** the summed pair key texts interned, in code units */
  pairKeyChars: number
  findings: RoomFinding[]
  /** findings by property, all of them (findings keeps the first 20 of each) */
  findingCounts: Record<string, number>
  /** every distinct finding signature (property, tab, detail), sorted: the POR proof gate compares these */
  signatures: string[]
  /** with `por` */
  por?: PorStats
  inclusion: { checked: number; deferred: number; skipped: number; stepped: number; covered: number; mismatches: number; byKey: Record<string, number>; samples: RoomFinding[] }
  gaps: { count: number; byWhy: Record<string, number>; samples: RoomFinding[] }
  probes: { run: number; failed: number }
  faultCuts: number
  elapsedMs: number
  peakHeapMb: number
  rooms?: Room[]
}

const PER_PROPERTY = 20

export function roomBfs(start: Room, options: RoomBfsOptions): RoomBfsResult {
  const began = Date.now()
  const interner = new Interner()
  // V8 caps one Map at 2^24 entries: shard by the key's last code unit mix
  const shards: Map<string, number>[] = Array.from({ length: 64 }, () => new Map())
  const shardOf = (key: string) => {
    let mix = 0
    for (let at = 0; at < key.length; at++) mix = (Math.imul(mix, 31) + key.charCodeAt(at)) | 0
    return shards[(mix >>> 0) % 64]!
  }
  let parents = new Int32Array(1 << 20)
  let labelOf = new Uint16Array(1 << 20)
  const labelNames: string[] = []
  const labelIndex = new Map<string, number>()
  const internLabel = (label: string): number => {
    let index = labelIndex.get(label)
    if (index === undefined) {
      index = labelNames.length
      labelNames.push(label)
      labelIndex.set(label, index)
    }
    return index
  }
  let states = 0
  let edges = 0
  let fullChars = 0
  let packedChars = 0
  let peakHeapMb = 0
  let faultCuts = 0
  const rooms: Room[] = []
  const add = (key: string, parent: number, label: number): number => {
    if (states >= parents.length) {
      const grownParents = new Int32Array(parents.length * 2)
      grownParents.set(parents)
      parents = grownParents
      const grownLabels = new Uint16Array(labelOf.length * 2)
      grownLabels.set(labelOf)
      labelOf = grownLabels
    }
    const node = states++
    parents[node] = parent
    labelOf[node] = label
    shardOf(key).set(key, node)
    return node
  }
  const pathOf = (node: number): number[] => {
    const out: number[] = []
    for (let at = node; at > 0; at = parents[at]!) out.unshift(at)
    return out
  }
  const labelsOf = (node: number, last?: string): string[] => [...pathOf(node).map((at) => labelNames[labelOf[at]!]!), ...(last ? [last] : [])]

  const findings: RoomFinding[] = []
  const findingCounts: Record<string, number> = {}
  const signatures = new Set<string>()
  const record = (property: string, detail: string, labels: () => string[]) => {
    signatures.add(`${property}\t${detail}`)
    findingCounts[property] = (findingCounts[property] ?? 0) + 1
    if (findingCounts[property]! <= PER_PROPERTY) findings.push({ property, detail, labels: labels() })
  }
  const inclusionTotals = { checked: 0, deferred: 0, skipped: 0, stepped: 0, covered: 0, mismatches: 0, byKey: {} as Record<string, number>, samples: [] as RoomFinding[] }
  const gapTotals = { count: 0, byWhy: {} as Record<string, number>, samples: [] as RoomFinding[] }
  const probes = { run: 0, failed: 0 }

  const first = roomKey(start, interner)
  add(first.key, -1, 0)
  if (options.keepRooms) rooms.push(start)
  for (const violation of quietViolations(start)) record(violation.property, violation.detail, () => [])

  // the replay cache: the rooms along the last expanded node's path
  let cachePath: number[] = []
  let cacheRooms: Room[] = []
  const rebuild = (node: number): Room => {
    const path = pathOf(node)
    let common = 0
    while (common < path.length && common < cachePath.length && path[common] === cachePath[common]) common++
    const roomsAlong = cacheRooms.slice(0, common)
    let room = common === 0 ? start : roomsAlong[common - 1]!
    for (let at = common; at < path.length; at++) {
      const next = step(room, labelNames[labelOf[path[at]!]!]!)
      if (!next) throw new Error(`replay: ${labelNames[labelOf[path[at]!]!]} is not enabled on the path to node ${node}`)
      room = next.room
      roomsAlong.push(room)
    }
    cachePath = path
    cacheRooms = roomsAlong
    return room
  }

  const layers: RoomLayer[] = []
  let frontier = new Int32Array([0])
  let depthCompleted = 0
  let frontierClosed = false
  let capped = false
  let heapStopped = false
  let recordCounter = 0
  const porStats: PorStats | null = options.por ? { expanded: 0, reduced: 0, full: {}, enabled: 0, taken: 0, check: emptyPorCheck() } : null
  const porChoice = (room: Room, stepped: Map<string, Successor | null>, stats: PorStats, visited: (child: Room) => boolean): ReadonlySet<string> | null => {
    const enabled = [...stepped.entries()].filter(([, result]) => result !== null).map(([label]) => label)
    const ends = new Map<string, Room | null>()
    const endOf = (label: string): Room | null => {
      if (!ends.has(label)) {
        const child = stepped.get(label)!.room
        ends.set(label, quiet(child) ? child : resolveChoices(child))
      }
      return ends.get(label)!
    }
    const choice = chooseAmple(room, enabled, endOf, { override: options.porOverride })
    let ample = choice.ample
    // C3: an ample child, or its macro's quiet end, already visited (a self-loop included) means the full set
    if (ample && ample.some((label) => visited(stepped.get(label)!.room) || (endOf(label) !== null && visited(endOf(label)!)))) ample = null
    const why = ample ? null : choice.ample ? "visited" : choice.why!
    if (quiet(room)) {
      stats.expanded += 1
      stats.enabled += enabled.length
      stats.taken += ample ? ample.length : enabled.length
      if (ample) stats.reduced += 1
      else stats.full[why!] = (stats.full[why!] ?? 0) + 1
    }
    return ample ? new Set(ample) : null
  }

  outer: for (let depth = 0; depth < options.depth; depth++) {
    const next: number[] = []
    const lastLayer = depth + 1 === options.depth
    const byKey = options.sampling === "key"
    for (const node of frontier) {
      const room = rebuild(node)
      const parentId = byKey ? stateIdOf(roomKeyParts(room)) : undefined
      const checkInclusion = options.inclusionEvery !== undefined && options.inclusionEvery > 0
      const candidates = candidateLabels(room)
      let taken: ReadonlySet<string> | null = null
      let stepped: Map<string, Successor | null> | null = null
      if (porStats) {
        stepped = new Map(candidates.map((label) => [label, step(room, label, { inclusion: checkInclusion })]))
        taken = porChoice(room, stepped, porStats, (child) => {
          const key = interner.peekKey(roomKeyParts(child))
          return key !== null && shardOf(key).has(key)
        })
        if (options.porCheck && quiet(room) && room.faultsLeft === 0 && stateSample(stateIdOf(roomKeyParts(room))) % options.porCheck === 0) checkIndependence(room, porStats.check, { override: options.porOverride })
      }
      for (const label of candidates) {
        if (taken && !taken.has(label)) continue
        const result = stepped ? stepped.get(label)! : step(room, label, { inclusion: checkInclusion })
        if (!result) {
          if (room.faultsLeft === 0 && (label.startsWith("ph:") || label.endsWith(":drop") || label.endsWith(":rejected") || /:rejected:/.test(label))) faultCuts += 1
          continue
        }
        edges += 1
        const { edge } = result
        const violations = [...invariantViolations(edge, label), ...edge.violations, ...localityViolations(room, edge, label), ...quietViolations(result.room)]
        if (options.rp7) violations.push(...rp7Violations(edge, result.room, options.rp7))
        for (const violation of violations) record(violation.property, violation.detail, () => labelsOf(node, label))
        for (const gap of edge.gaps) recordGap(gapTotals, gap, () => labelsOf(node, label))
        // every edge records its sub-sequences; 1 in inclusionEvery of them is compared (coverage is checked on every edge)
        if (checkInclusion) {
          let ordinal = 0
          const sample = parentId ? () => inclusionSampled(parentId, label, ordinal++, options.inclusionEvery!) : () => ++recordCounter % options.inclusionEvery! === 0
          addInclusion(inclusionTotals, inclusion(edge, sample), () => labelsOf(node, label))
        }
        const parts = roomKeyParts(result.room)
        const key = roomKey(result.room, interner, parts)
        const shard = shardOf(key.key)
        if (shard.has(key.key)) continue
        if (states >= options.maxStates) {
          capped = true
          break outer
        }
        fullChars += key.fullChars
        packedChars += key.key.length
        const child = add(key.key, node, internLabel(label))
        if (options.keepRooms) rooms.push(result.room)
        if (!lastLayer) next.push(child)
        if (options.probeEvery && (byKey ? stateSample(stateIdOf(parts)) : child) % options.probeEvery === 0) {
          probes.run += 1
          const failed = recoveryViolations(result.room)
          if (failed.length > 0) probes.failed += 1
          for (const violation of failed) record(violation.property, violation.detail, () => labelsOf(child))
        }
        if ((states & 0x3fff) === 0) {
          const heapMb = process.memoryUsage().heapUsed / 2 ** 20
          peakHeapMb = Math.max(peakHeapMb, heapMb)
          if (options.heapStopMb !== undefined && heapMb > options.heapStopMb) {
            heapStopped = true
            break outer
          }
        }
      }
    }
    depthCompleted = depth + 1
    const heapUsedMb = Math.round(process.memoryUsage().heapUsed / 2 ** 20)
    peakHeapMb = Math.max(peakHeapMb, heapUsedMb)
    const layer: RoomLayer = { depth: depthCompleted, states, added: lastLayer ? states - (layers.at(-1)?.states ?? 1) : next.length, distinctPairs: interner.pairCount, heapUsedMb, elapsedMs: Date.now() - began }
    layers.push(layer)
    options.onLayer?.(layer)
    if (!lastLayer && next.length === 0) {
      frontierClosed = true
      break
    }
    frontier = Int32Array.from(next)
  }
  return {
    states,
    edges,
    depthCompleted,
    frontierClosed,
    capped,
    heapStopped,
    layers,
    distinctPairs: interner.pairCount,
    distinctPairsPerPosition: interner.perPosition(3),
    distinctPhones: 0,
    keyChars: { full: states > 1 ? fullChars / (states - 1) : 0, packed: states > 1 ? packedChars / (states - 1) : 0 },
    pairKeyChars: interner.pairKeyChars,
    findings,
    findingCounts,
    signatures: [...signatures].sort(),
    ...(porStats ? { por: porStats } : {}),
    inclusion: inclusionTotals,
    gaps: gapTotals,
    probes,
    faultCuts,
    elapsedMs: Date.now() - began,
    peakHeapMb: Math.round(peakHeapMb),
    ...(options.keepRooms ? { rooms } : {}),
  }
}

function recordGap(totals: RoomBfsResult["gaps"], gap: InclusionGap, labels: () => string[]): void {
  totals.count += 1
  const why = `${gap.key}: ${gap.why}`
  totals.byWhy[why] = (totals.byWhy[why] ?? 0) + 1
  if (totals.byWhy[why] === 1 && totals.samples.length < 40) totals.samples.push({ property: "inclusion-gap", detail: `phone ${gap.phone} toward ${gap.peer}, ${why}`, labels: labels() })
}

function addInclusion(totals: RoomBfsResult["inclusion"], result: InclusionResult, labels: () => string[]): void {
  totals.checked += result.checked
  totals.deferred += result.deferred
  totals.skipped += result.skipped
  totals.stepped += result.stepped
  totals.covered += result.covered
  for (const mismatch of result.mismatches) {
    totals.mismatches += 1
    const key = `${mismatch.key}: ${mismatch.detail}`
    totals.byKey[key] = (totals.byKey[key] ?? 0) + 1
    if (totals.byKey[key] === 1 && totals.samples.length < 40) totals.samples.push({ property: "inclusion", detail: `phone ${mismatch.phone} toward ${mismatch.peer}, ${key}`, labels: labels() })
  }
}

/** A busy child's quiet end: each choice resolved (at faultsLeft = 0 the only outcome), or null when one cannot resolve. */
function resolveChoices(room: Room): Room | null {
  let at = room
  for (let guard = 0; !quiet(at); guard++) {
    if (guard > 64) return null
    const i = at.phones.findIndex((phone) => phone.queue.length > 0)
    const next = step(at, `choice:${i}:resolved`)
    if (!next) return null
    at = next.room
  }
  return at
}
