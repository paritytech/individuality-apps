// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The room as a tiled map on disk: a disk frontier and a distributed BFS.
 *
 * The state space is cut into T tiles by the state's 128-bit id (key.ts stateIdOf). Each tile keeps, on
 * disk, its explored set (one file of ids per depth: the depth a state was first reached at is the file
 * it sits in) and its inbox (states sent to it, one append-only file per depth and writer). A worker
 * takes a tile with a non-empty inbox, loads its explored set, answers the inbox (an id already
 * explored is answered from the set and dropped; a new one is explored), expands each new state and
 * sends every child to its own tile's inbox for the next depth. Depths run one at a time with a
 * barrier between them, so the depth semantics are bfs.ts's.
 *
 * A state on disk is its id plus its path: the position of each label in the parent's
 * candidateLabels(), two bytes per step from the anchor. A worker rebuilds the room by replaying the path
 * (step() is deterministic), with the previous path's rooms cached. Among the entries of one inbox with
 * the same id, the lexicographically least path is kept: that is the path the in-memory BFS takes
 * (its frontier is in exactly that order), so the room expanded for an id is bfs.ts's first-found room,
 * not merely one with an equal key.
 *
 * Commit and resume: a worker writes a tile's outputs, then appends one line to its journal for the
 * depth (the lengths of every file it has written so far that depth, and the tile's counts). A killed
 * worker's files are cut back to its last journal line and its tile is done again; the explored file of
 * depth d is written whole (tmp + rename) and a tile at depth d reads only the files of depths below d,
 * so doing a tile twice is a no-op. A killed run restarts from the files.
 *
 * Memory per worker: the largest tile's explored set and inbox, the path cache and the output buffers,
 * independent of the total.
 */
import { fork, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { assertCheckpointVersion, atomicWriteJson, type ExplorerVersion } from "../core/checkpoint"
import { isFault, type Label } from "../core/labels"
import { isMeshAnchor, MESH_ANCHORS, readMeshAnchor } from "../mesh/anchors"
import { monitorsFor } from "../mesh/monitors"
import type { Room as MeshRoom, ScenarioName } from "../mesh/room"
import { SCENARIOS } from "../mesh/scenarios"
import { inclusion, invariantViolations, localityViolations, quietViolations, recoveryViolations, roomAnchor, rp7Violations, type InclusionResult, type RoomRun } from "./checks"
import { inclusionSampled, ROOM_KEY_FORMAT, roomKeyParts, stateIdOf, stateSample } from "./key"
import { beatFromEnv, candidateLabels, frozenFromEnv, noLaneOtherFromEnv, pairsOf, rtxUnsafeFromEnv, step, type InclusionGap, type Room } from "./model"

export const ID_BYTES = 16
/** Bound native/off-heap retention by replacing a mesh Vitest process after this many expanded states. */
const MESH_WORKER_STATE_LIMIT = 1_000
/** a path step: the label's position in the parent's candidateLabels(), big-endian (byte order is lexicographic order) */
export const STEP_BYTES = 2
const stepAt = (path: Uint8Array, at: number): number => (path[at * STEP_BYTES]! << 8) | path[at * STEP_BYTES + 1]!
const PER_PROPERTY = 20

/** ROOM_RTX_UNSAFE as the meta records it: the sorted phone list, "" for none */
const rtxUnsafeKey = (): string => [...rtxUnsafeFromEnv()].sort((a, b) => a - b).join(",")
/** ROOM_FROZEN as the meta records it: the sorted phone list, "" for none */
const frozenKey = (): string => [...frozenFromEnv()].sort((a, b) => a - b).join(",")

export interface TiledMeta {
  run: RoomRun | "mesh-pair"
  depth: number
  faults: number
  tiles: number
  pairShards: number
  inclusionEvery: number
  probeEvery: number
  /** key.ts ROOM_KEY_FORMAT when the run started */
  keyFormat: number
  /** the anchor's state id (hex): any change to the key or the model's anchor shows here */
  anchorId: string
  /** bound depths a later, deeper run continued from (their frontier expanded in an extension stage) */
  extended: number[]
  /** the room's phone count (3 when absent: runs from before it was a parameter) */
  phones?: number
  /** the phone whose reload is the injected moment (1 when absent) */
  reloaded?: number
  /** the beat label's room (ROOM_BEAT=1) replaces free hello reads (off when absent) */
  beat?: boolean
  /** the RTX-unsafe phones (ROOM_RTX_UNSAFE, comma-separated; none when absent) */
  rtxUnsafe?: string
  /** the phones that may hide and freeze (ROOM_FROZEN, comma-separated; none when absent) */
  frozen?: string
  /** no charged lane rejection with reason "other" (ROOM_NO_LANE_OTHER=1; off when absent) */
  noLaneOther?: boolean
  /** a time horizon in ms of room time past the anchor: an advance beyond it is not taken, and the elapsed time is part of the state (none when absent) */
  horizonMs?: number
  /** absent for historical room runs; mesh-pair selects the async replay adapter */
  machine?: "mesh-pair"
  /** mesh-pair's named scenario before an optional anchor warmup */
  scenario?: ScenarioName
  /** mesh-pair anchor name, when the run starts after one */
  anchor?: string
  /** labels replayed after every mesh-pair reset */
  warmup?: Label[]
  /** false disables mesh-pair heartbeats */
  heartbeat?: boolean
  /** git and deterministic explorer-source identity recorded at run creation */
  version?: ExplorerVersion
}

const metaPhones = (meta: TiledMeta) => meta.phones ?? 3
const anchorOf = (meta: TiledMeta) => roomAnchor(metaPhones(meta), meta.run as RoomRun, meta.faults, meta.reloaded ?? 1)
/** the pair-position bitmask's width in bytes: one bit per pair */
const maskBytes = (phones: number) => Math.ceil(pairsOf(phones).length / 8)
const readMask = (buffer: Uint8Array, at: number, bytes: number): number => {
  let mask = 0
  for (let k = 0; k < bytes; k++) mask |= buffer[at + k]! << (8 * k)
  return mask >>> 0
}
const writeMask = (buffer: Uint8Array, at: number, bytes: number, mask: number) => {
  for (let k = 0; k < bytes; k++) buffer[at + k] = (mask >>> (8 * k)) & 0xff
}

/** A stable tile for a state id: bytes 4..7 (the sample uses 0..3), mod T. */
export const tileOf = (id: Uint8Array, tiles: number): number => (((id[4]! << 24) | (id[5]! << 16) | (id[6]! << 8) | id[7]!) >>> 0) % tiles
/** A pair hash's shard (hash128's 8 code units as 16 latin1 bytes) */
const shardOf = (hash: string, shards: number): number => (((hash.charCodeAt(0) << 8) | hash.charCodeAt(1)) >>> 0) % shards

// ── files ──

const pad = (value: number, width: number) => String(value).padStart(width, "0")
export const paths = (out: string) => ({
  meta: join(out, "meta.json"),
  checkpoint: join(out, "checkpoint.json"),
  stop: join(out, "stop.requested"),
  progress: join(out, "progress.jsonl"),
  tile: (tile: number) => join(out, "tiles", `t${pad(tile, 5)}`),
  explored: (tile: number, depth: number) => join(out, "tiles", `t${pad(tile, 5)}`, `explored-d${pad(depth, 3)}.bin`),
  inboxDir: (depth: number) => join(out, "inbox", `d${pad(depth, 3)}`),
  inbox: (depth: number, tile: number, writer: string) => join(out, "inbox", `d${pad(depth, 3)}`, `t${pad(tile, 5)}.${writer}.bin`),
  /** the bound depth's new states, as inbox records: what an extension expands */
  frontier: (tile: number, depth: number) => join(out, "tiles", `t${pad(tile, 5)}`, `frontier-d${pad(depth, 3)}.bin`),
  pairsOutDir: (depth: number, extend = false) => join(out, "pairs-out", stage(depth, extend)),
  pairsOut: (depth: number, shard: number, writer: string, extend = false) => join(out, "pairs-out", stage(depth, extend), `p${pad(shard, 4)}.${writer}.bin`),
  pairSet: (depth: number, shard: number) => join(out, "pairs", `p${pad(shard, 4)}.d${pad(depth, 3)}.bin`),
  journal: (depth: number, worker: number, extend = false) => join(out, "journal", `${stage(depth, extend)}.w${pad(worker, 3)}.jsonl`),
  phase: (depth: number, extend = false) => join(out, "phases", `${stage(depth, extend)}.json`),
})
/** a stage's name: `d009` answers depth 9's inbox (and expands below the bound); `d009x` expands a former bound's frontier */
const stage = (depth: number, extend: boolean) => `d${pad(depth, 3)}${extend ? "x" : ""}`

const writeWhole = (file: string, data: Uint8Array | string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, data)
  renameSync(`${file}.tmp`, file)
}
const readOr = (file: string): Buffer => (existsSync(file) ? readFileSync(file) : Buffer.alloc(0))
const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])

/** An inbox record: the state id, then its path (two bytes per step). */
export function encodeRecord(id: Uint8Array, path: Uint8Array): Buffer {
  const out = Buffer.alloc(ID_BYTES + path.length)
  out.set(id, 0)
  out.set(path, ID_BYTES)
  return out
}

/** Every record of an inbox buffer at `depth` (a path of `depth` steps). */
export function* decodeRecords(buffer: Buffer, depth: number): Generator<{ id: Buffer; path: Buffer }> {
  const size = ID_BYTES + depth * STEP_BYTES
  if (buffer.length % size !== 0) throw new Error(`inbox of ${buffer.length} bytes is not whole ${size}-byte records`)
  for (let at = 0; at < buffer.length; at += size) yield { id: buffer.subarray(at, at + ID_BYTES), path: buffer.subarray(at + ID_BYTES, at + size) }
}

// ── counts ──

export interface TiledFinding {
  property: string
  detail: string
  /** labels from the anchor */
  labels: string[]
}

export interface PhaseCounts {
  newStates: number
  answered: number
  received: number
  edges: number
  faultCuts: number
  /** advances not taken past the time horizon */
  horizonCuts?: number
  /** edges whose child is the parent itself (a label that changed nothing the key sees) */
  selfLoops?: number
  /** per label family: edges, children with a queued choice (busy), and self-loops */
  families?: Record<string, { edges: number; busy: number; selfLoops: number }>
  findingCounts: Record<string, number>
  findings: TiledFinding[]
  inclusion: { checked: number; deferred: number; skipped: number; stepped: number; covered: number; mismatches: number; byKey: Record<string, number> }
  gaps: { count: number; byWhy: Record<string, number> }
  probes: { run: number; failed: number }
  /** how one tile's children spread over the next depth's tiles: tiles that expanded a state, the distinct child tiles summed over them, children, children landing in their source's own tile index */
  spread: { sources: number; childTiles: number; children: number; sameTile: number; selfLoops?: number }
  peakRssMb: number
  peakHeapMb: number
}

export const emptyCounts = (): PhaseCounts => ({
  newStates: 0,
  answered: 0,
  received: 0,
  edges: 0,
  faultCuts: 0,
  horizonCuts: 0,
  selfLoops: 0,
  families: {},
  findingCounts: {},
  findings: [],
  inclusion: { checked: 0, deferred: 0, skipped: 0, stepped: 0, covered: 0, mismatches: 0, byKey: {} },
  gaps: { count: 0, byWhy: {} },
  probes: { run: 0, failed: 0 },
  spread: { sources: 0, childTiles: 0, children: 0, sameTile: 0, selfLoops: 0 },
  peakRssMb: 0,
  peakHeapMb: 0,
})

const addMap = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value
}

function mergeCounts(into: PhaseCounts, from: PhaseCounts): PhaseCounts {
  into.newStates += from.newStates
  into.answered += from.answered
  into.received += from.received
  into.edges += from.edges
  into.faultCuts += from.faultCuts
  into.horizonCuts = (into.horizonCuts ?? 0) + (from.horizonCuts ?? 0)
  into.selfLoops = (into.selfLoops ?? 0) + (from.selfLoops ?? 0)
  into.families ??= {}
  for (const [family, value] of Object.entries(from.families ?? {})) {
    const held = (into.families[family] ??= { edges: 0, busy: 0, selfLoops: 0 })
    held.edges += value.edges
    held.busy += value.busy
    held.selfLoops += value.selfLoops
  }
  addMap(into.findingCounts, from.findingCounts)
  for (const finding of from.findings) if (into.findings.filter((f) => f.property === finding.property).length < PER_PROPERTY) into.findings.push(finding)
  for (const key of ["checked", "deferred", "skipped", "stepped", "covered", "mismatches"] as const) into.inclusion[key] += from.inclusion[key]
  addMap(into.inclusion.byKey, from.inclusion.byKey)
  into.gaps.count += from.gaps.count
  addMap(into.gaps.byWhy, from.gaps.byWhy)
  into.probes.run += from.probes.run
  into.probes.failed += from.probes.failed
  // journals and markers from before the spread count carry none
  into.spread ??= { sources: 0, childTiles: 0, children: 0, sameTile: 0 }
  if (from.spread) {
    for (const key of ["sources", "childTiles", "children", "sameTile"] as const) into.spread[key] += from.spread[key]
    into.spread.selfLoops = (into.spread.selfLoops ?? 0) + (from.spread.selfLoops ?? 0)
  }
  into.peakRssMb = Math.max(into.peakRssMb, from.peakRssMb)
  into.peakHeapMb = Math.max(into.peakHeapMb, from.peakHeapMb)
  return into
}

// ── a worker: one tile at one depth ──

interface JournalLine {
  tile: number
  lengths: Record<string, number>
  counts: PhaseCounts
  /** absent on historical lines means complete */
  complete?: boolean
  /** mesh-pair: first state in this tile not yet expanded */
  nextState?: number
}

interface TileProcessResult {
  counts: PhaseCounts
  complete: boolean
  states: number
}

/** One worker's state for a depth: the files it has written and their committed lengths. */
export class TileWorker {
  private readonly meta: TiledMeta
  private readonly anchor?: { labels: string[]; room: Room }
  private readonly files: ReturnType<typeof paths>
  private lengths: Record<string, number> = {}
  private stage = ""
  private cachePath: Uint8Array = new Uint8Array(0)
  private cacheRooms: Room[] = []
  private cacheLabels: string[] = []
  private meshRoom?: MeshRoom
  private stopRequested = false

  constructor(
    private readonly out: string,
    private readonly worker: number,
  ) {
    this.meta = JSON.parse(readFileSync(paths(out).meta, "utf8")) as TiledMeta
    if (this.meta.machine !== "mesh-pair") {
      if ((this.meta.beat ?? false) !== beatFromEnv()) throw new Error(`${out} was started with beat=${this.meta.beat ?? false}, but ROOM_BEAT says ${beatFromEnv()}`)
      if ((this.meta.rtxUnsafe ?? "") !== rtxUnsafeKey()) throw new Error(`${out} was started with rtxUnsafe=${this.meta.rtxUnsafe ?? ""}, but ROOM_RTX_UNSAFE says ${rtxUnsafeKey()}`)
      if ((this.meta.frozen ?? "") !== frozenKey()) throw new Error(`${out} was started with frozen=${this.meta.frozen ?? ""}, but ROOM_FROZEN says ${frozenKey()}`)
      if ((this.meta.noLaneOther ?? false) !== noLaneOtherFromEnv()) throw new Error(`${out} was started with noLaneOther=${this.meta.noLaneOther ?? false}, but ROOM_NO_LANE_OTHER says ${noLaneOtherFromEnv()}`)
      this.anchor = anchorOf(this.meta)
    }
    this.files = paths(out)
  }

  requestStop(): void {
    this.stopRequested = true
  }

  private enter(depth: number, extend: boolean) {
    if (stage(depth, extend) === this.stage) return
    this.stage = stage(depth, extend)
    this.lengths = {}
    for (const line of readJournal(this.files.journal(depth, this.worker, extend))) this.lengths = line.lengths
  }

  /** the room at `path` from the anchor, and the labels taken, reusing the previous path's rooms */
  private rebuild(path: Uint8Array): { room: Room; labels: string[] } {
    let common = 0
    const steps = path.length / STEP_BYTES
    while (common < steps && common < this.cacheRooms.length && stepAt(path, common) === stepAt(this.cachePath, common)) common++
    const rooms = this.cacheRooms.slice(0, common)
    const labels = this.cacheLabels.slice(0, common)
    let room = common === 0 ? this.anchor!.room : rooms[common - 1]!
    for (let at = common; at < steps; at++) {
      const label = candidateLabels(room)[stepAt(path, at)]
      const next = label === undefined ? null : step(room, label)
      if (!next) throw new Error(`replay: position ${stepAt(path, at)} (${label}) is not enabled at step ${at}`)
      room = next.room
      rooms.push(room)
      labels.push(label!)
    }
    this.cachePath = path.slice()
    this.cacheRooms = rooms
    this.cacheLabels = labels
    return { room, labels }
  }

  private async mesh(): Promise<MeshRoom> {
    if (this.meshRoom) return this.meshRoom
    const warmup = this.meta.warmup ?? []
    const { exploreRoom } = await import("../mesh/room")
    this.meshRoom = await exploreRoom({
      scenario: this.meta.scenario!,
      phaseOffsetMs: 1000,
      faults: this.meta.faults + warmup.filter(isFault).length,
      horizonMs: this.meta.horizonMs ?? 120_000,
      monitors: monitorsFor(1),
      heartbeat: this.meta.heartbeat !== false,
    })
    return this.meshRoom
  }

  /** Rebuild a mesh state from the anchor and a path of enabled-label positions. */
  private async rebuildMesh(path: Uint8Array): Promise<{ room: MeshRoom; labels: Label[] }> {
    const room = await this.mesh()
    await room.reset()
    for (const label of this.meta.warmup ?? []) await room.step(label)
    const labels: Label[] = []
    for (let at = 0; at < path.length / STEP_BYTES; at++) {
      const position = stepAt(path, at)
      const label = room.enabled()[position]
      if (label === undefined) throw new Error(`mesh replay: position ${position} is not enabled at step ${at}`)
      await room.step(label)
      labels.push(label)
    }
    return { room, labels }
  }

  close(): void {
    this.meshRoom?.close()
  }

  /**
   * Answer `tile`'s inbox at `depth`, expand its new states (below the depth bound; at the bound, keep
   * them as the tile's frontier file), commit. With `extend`, expand the frontier file of a former bound
   * instead: no inbox, no explored set, no probes (those ran when the bound was answered).
   * `failBeforeCommit` (tests) writes the outputs and throws before the journal line.
   */
  async processTile(depth: number, tile: number, options: { failBeforeCommit?: boolean; extend?: boolean; maxStates?: number } = {}): Promise<TileProcessResult> {
    const extend = options.extend ?? false
    this.enter(depth, extend)
    const { meta, files } = this
    const counts = emptyCounts()
    const sample = () => {
      const memory = process.memoryUsage()
      counts.peakRssMb = Math.max(counts.peakRssMb, Math.round(memory.rss / 2 ** 20))
      counts.peakHeapMb = Math.max(counts.peakHeapMb, Math.round(memory.heapUsed / 2 ** 20))
    }

    let fresh: [string, Buffer][]
    if (extend) {
      fresh = [...decodeRecords(readOr(files.frontier(tile, depth)), depth)].map((record) => [record.id.toString("latin1"), Buffer.from(record.path)])
    } else {
      fresh = this.answer(depth, tile, counts)
      if (depth === meta.depth) writeWhole(files.frontier(tile, depth), Buffer.concat(fresh.map(([key, path]) => encodeRecord(Buffer.from(key, "latin1"), path))))
    }
    sample()
    if (meta.machine === "mesh-pair") {
      return this.expandMesh(depth, tile, fresh, counts, sample, extend, options.failBeforeCommit ?? false, options.maxStates)
    }
    return {
      counts: this.expandRoom(depth, tile, fresh, counts, sample, extend, options.failBeforeCommit ?? false),
      complete: true,
      states: fresh.length,
    }
  }

  /** The tile's new states at `depth`, least path first, written as its explored file for that depth. */
  private answer(depth: number, tile: number, counts: PhaseCounts): [string, Buffer][] {
    const { files } = this
    // the explored set: every depth below this one
    const explored = new Set<string>()
    for (let below = 0; below < depth; below++) {
      const buffer = readOr(files.explored(tile, below))
      for (let at = 0; at < buffer.length; at += ID_BYTES) explored.add(buffer.toString("latin1", at, at + ID_BYTES))
    }
    // answer the inbox: drop what is explored, keep the least path per new id
    const best = new Map<string, Buffer>()
    const prefix = `t${pad(tile, 5)}.`
    for (const name of listDir(files.inboxDir(depth))) {
      if (!name.startsWith(prefix) || !name.endsWith(".bin")) continue
      for (const record of decodeRecords(readFileSync(join(files.inboxDir(depth), name)), depth)) {
        counts.received += 1
        const key = record.id.toString("latin1")
        if (explored.has(key)) {
          counts.answered += 1
          continue
        }
        const held = best.get(key)
        if (!held || Buffer.compare(record.path, held) < 0) best.set(key, Buffer.from(record.path))
      }
    }
    explored.clear()
    const fresh = [...best.entries()].sort((a, b) => Buffer.compare(a[1], b[1]))
    best.clear()
    counts.newStates = fresh.length
    mkdirSync(files.tile(tile), { recursive: true })
    writeWhole(files.explored(tile, depth), Buffer.concat(fresh.map(([key]) => Buffer.from(key, "latin1"))))
    return fresh
  }

  /** Probe and expand `fresh` (in path order), send the children to their tiles' inboxes, commit. */
  private expandRoom(depth: number, tile: number, fresh: [string, Buffer][], counts: PhaseCounts, sample: () => void, extend: boolean, failBeforeCommit: boolean): PhaseCounts {
    const { meta, files } = this

    const outputs = new Map<string, Buffer[]>()
    const emit = (file: string, data: Buffer) => {
      let list = outputs.get(file)
      if (!list) outputs.set(file, (list = []))
      list.push(data)
    }
    const pairs = new Map<string, number>()
    const record = (property: string, detail: string, labels: () => string[]) => {
      counts.findingCounts[property] = (counts.findingCounts[property] ?? 0) + 1
      if (counts.findingCounts[property]! <= PER_PROPERTY) counts.findings.push({ property, detail, labels: labels() })
    }
    const expand = extend || depth < meta.depth
    const childTiles = new Map<number, number>()
    const checkInclusion = meta.inclusionEvery > 0
    const writer = `w${pad(this.worker, 3)}`

    for (let index = 0; index < fresh.length; index++) {
      const [key, path] = fresh[index]!
      const id = Buffer.from(key, "latin1")
      const probe = !extend && depth > 0 && meta.probeEvery > 0 && stateSample(id) % meta.probeEvery === 0
      if (!expand && !probe) continue
      const { room, labels: along } = this.rebuild(path)
      if (depth === 0 && !extend) for (const violation of quietViolations(room)) record(violation.property, violation.detail, () => [])
      if (probe) {
        counts.probes.run += 1
        const failed = recoveryViolations(room)
        if (failed.length > 0) counts.probes.failed += 1
        for (const violation of failed) record(violation.property, violation.detail, () => [...along])
      }
      if (!expand) continue
      const candidates = candidateLabels(room)
      if (candidates.length > 0xffff) throw new Error(`${candidates.length} candidate labels: a path step is two bytes`)
      for (let position = 0; position < candidates.length; position++) {
        const label = candidates[position]!
        const result = step(room, label, { inclusion: checkInclusion })
        if (!result) {
          if (room.faultsLeft === 0 && (label.startsWith("ph:") || label.endsWith(":drop") || label.endsWith(":rejected") || /:rejected:/.test(label))) counts.faultCuts += 1
          continue
        }
        const horizon = meta.horizonMs
        if (horizon !== undefined && result.room.now - this.anchor!.room.now > horizon) {
          counts.horizonCuts = (counts.horizonCuts ?? 0) + 1
          continue
        }
        counts.edges += 1
        const { edge } = result
        const labelsTo = () => [...along, label]
        const violations = [...invariantViolations(edge, label), ...edge.violations, ...localityViolations(room, edge, label), ...quietViolations(result.room)]
        if (meta.run === "reload") violations.push(...rp7Violations(edge, result.room, { reloaded: meta.reloaded ?? 1, faults: meta.faults }))
        for (const violation of violations) record(violation.property, violation.detail, labelsTo)
        for (const gap of edge.gaps) addGap(counts, gap)
        if (checkInclusion) {
          let ordinal = 0
          addInclusion(counts, inclusion(edge, () => inclusionSampled(id, label, ordinal++, meta.inclusionEvery)))
        }
        const parts = roomKeyParts(result.room)
        const childId = stateIdOf(parts, horizon === undefined ? undefined : result.room.now - this.anchor!.room.now)
        const family = label.split(":")[0]!
        const held = ((counts.families ??= {})[family] ??= { edges: 0, busy: 0, selfLoops: 0 })
        held.edges += 1
        if (result.room.phones.some((phone) => phone.queue.length > 0)) held.busy += 1
        if (Buffer.compare(childId, id) === 0) {
          held.selfLoops += 1
          counts.selfLoops = (counts.selfLoops ?? 0) + 1
        }
        const childPath = new Uint8Array(path.length + STEP_BYTES)
        childPath.set(path, 0)
        childPath[path.length] = position >>> 8
        childPath[path.length + 1] = position & 0xff
        const childTile = tileOf(childId, meta.tiles)
        if (Buffer.compare(childId, id) === 0) counts.spread.selfLoops = (counts.spread.selfLoops ?? 0) + 1
        childTiles.set(childTile, (childTiles.get(childTile) ?? 0) + 1)
        emit(files.inbox(depth + 1, childTile, writer), encodeRecord(childId, childPath))
        for (let at = 0; at < parts.pairHashes.length; at++) pairs.set(parts.pairHashes[at]!, (pairs.get(parts.pairHashes[at]!) ?? 0) | (at < 31 ? 1 << at : 0))
      }
      if ((index & 0x3ff) === 0) sample()
    }
    const width = maskBytes(metaPhones(meta))
    for (const [hash, positions] of pairs) {
      const entry = Buffer.alloc(16 + width)
      entry.write(hash, 0, "latin1")
      writeMask(entry, 16, width, positions)
      emit(files.pairsOut(depth, shardOf(hash, meta.pairShards), writer, extend), entry)
    }
    if (childTiles.size > 0) {
      counts.spread.sources += 1
      counts.spread.childTiles += childTiles.size
      for (const value of childTiles.values()) counts.spread.children += value
      counts.spread.sameTile += childTiles.get(tile) ?? 0
    }
    sample()

    // write, then commit: the journal line is the commit point
    if (outputs.size > 0) {
      mkdirSync(files.inboxDir(depth + 1), { recursive: true })
      mkdirSync(files.pairsOutDir(depth, extend), { recursive: true })
    }
    for (const [file, list] of outputs) {
      const data = Buffer.concat(list)
      appendFileSync(file, data)
      this.lengths[file] = (this.lengths[file] ?? 0) + data.length
    }
    if (failBeforeCommit) throw new Error(`failBeforeCommit: tile ${tile} at depth ${depth}`)
    const line: JournalLine = { tile, lengths: this.lengths, counts }
    mkdirSync(join(this.out, "journal"), { recursive: true })
    appendFileSync(files.journal(depth, this.worker, extend), `${JSON.stringify(line)}\n`)
    return counts
  }

  /** The mesh-pair plug-in: replay each disk-frontier path, expand it, and commit only between states. */
  private async expandMesh(
    depth: number,
    tile: number,
    fresh: [string, Buffer][],
    counts: PhaseCounts,
    sample: () => void,
    extend: boolean,
    failBeforeCommit: boolean,
    maxStates?: number,
  ): Promise<TileProcessResult> {
    const { meta, files } = this
    const partial = partialJournal(this.out, depth, tile, extend)
    let start = partial?.nextState ?? 0
    if (partial) Object.assign(counts, JSON.parse(JSON.stringify(partial.counts)) as PhaseCounts)
    const outputs = new Map<string, Buffer[]>()
    const writer = `w${pad(this.worker, 3)}`
    let processed = 0

    const emit = (file: string, data: Buffer) => {
      const held = outputs.get(file) ?? []
      held.push(data)
      outputs.set(file, held)
    }
    const finding = (property: string, detail: string, labels: Label[]) => {
      counts.findingCounts[property] = (counts.findingCounts[property] ?? 0) + 1
      const existing = counts.findings.find((entry) => entry.property === property && entry.detail === detail)
      if (!existing && counts.findings.filter((entry) => entry.property === property).length < PER_PROPERTY) {
        counts.findings.push({ property, detail, labels: [...labels] })
      } else if (existing && existing.labels.length > labels.length) {
        existing.labels = [...labels]
      }
    }
    const flush = (complete: boolean, nextState: number) => {
      if (outputs.size > 0) mkdirSync(files.inboxDir(depth + 1), { recursive: true })
      for (const [file, chunks] of outputs) {
        const data = Buffer.concat(chunks)
        appendFileSync(file, data)
        this.lengths[file] = (this.lengths[file] ?? 0) + data.length
      }
      outputs.clear()
      if (failBeforeCommit) throw new Error(`failBeforeCommit: tile ${tile} at depth ${depth}`)
      const line: JournalLine = { tile, lengths: this.lengths, counts, complete, nextState }
      mkdirSync(join(this.out, "journal"), { recursive: true })
      appendFileSync(files.journal(depth, this.worker, extend), `${JSON.stringify(line)}\n`)
    }

    for (; start < fresh.length; start++) {
      const [, path] = fresh[start]!
      const rebuilt = await this.rebuildMesh(path)
      const room = rebuilt.room
      const along = rebuilt.labels
      for (const violation of room.violations()) finding(violation.property, violation.detail, along)
      const enabled = room.enabled()
      const parentFaultsLeft = room.faultsLeft()
      const expandable = (extend || depth < meta.depth) && !room.horizonReached()

      if (!expandable || enabled.every((label) => isFault(label) && parentFaultsLeft === 0)) {
        try {
          await room.checkLeaf()
        } catch (error) {
          finding("harness", error instanceof Error ? error.message : String(error), along)
        }
      }

      if (expandable) {
        if (enabled.length > 0xffff) throw new Error(`${enabled.length} mesh labels: a path step is two bytes`)
        const childTiles = new Set<number>()
        for (let position = 0; position < enabled.length; position++) {
          const label = enabled[position]!
          if (isFault(label) && parentFaultsLeft === 0) {
            counts.faultCuts += 1
            continue
          }
          const parent = position === 0 ? room : (await this.rebuildMesh(path)).room
          try {
            await parent.step(label)
          } catch (error) {
            finding("harness", error instanceof Error ? error.message : String(error), [...along, label])
            continue
          }
          counts.edges += 1
          const labels = [...along, label]
          for (const violation of parent.violations()) finding(violation.property, violation.detail, labels)
          for (const gap of parent.gaps()) {
            counts.gaps.count += 1
            const why = `${gap.property}: ${gap.detail}`
            counts.gaps.byWhy[why] = (counts.gaps.byWhy[why] ?? 0) + 1
          }
          const fingerprint = parent.fingerprint()
          const childId = meshStateId(fingerprint)
          const childPath = Buffer.alloc(path.length + STEP_BYTES)
          path.copy(childPath, 0)
          childPath[path.length] = position >>> 8
          childPath[path.length + 1] = position & 0xff
          const childTile = tileOf(childId, meta.tiles)
          childTiles.add(childTile)
          emit(files.inbox(depth + 1, childTile, writer), encodeRecord(childId, childPath))
          counts.spread.children += 1
          counts.spread.sameTile += childTile === tile ? 1 : 0
          if (Buffer.from(fresh[start]![0], "latin1").equals(childId)) counts.spread.selfLoops = (counts.spread.selfLoops ?? 0) + 1
        }
        if (enabled.length > 0) {
          counts.spread.sources += 1
          counts.spread.childTiles += childTiles.size
        }
      }
      processed += 1
      sample()
      if (this.stopRequested || existsSync(files.stop) || (maxStates !== undefined && processed >= maxStates)) {
        flush(false, start + 1)
        return { counts, complete: false, states: processed }
      }
    }
    flush(true, fresh.length)
    return { counts, complete: true, states: processed }
  }
}

/** Latest incomplete state-boundary commit for a tile, across any prior worker ownership. */
function partialJournal(out: string, depth: number, tile: number, extend: boolean): JournalLine | undefined {
  let latest: JournalLine | undefined
  const prefix = `${stage(depth, extend)}.`
  for (const name of listDir(join(out, "journal"))) {
    if (!name.startsWith(prefix)) continue
    for (const line of readJournal(join(out, "journal", name))) {
      if (line.tile !== tile || line.complete !== false) continue
      if ((line.nextState ?? 0) >= (latest?.nextState ?? -1)) latest = line
    }
  }
  return latest
}

function addGap(counts: PhaseCounts, gap: InclusionGap) {
  counts.gaps.count += 1
  const why = `${gap.key}: ${gap.why}`
  counts.gaps.byWhy[why] = (counts.gaps.byWhy[why] ?? 0) + 1
}

function addInclusion(counts: PhaseCounts, result: InclusionResult) {
  const totals = counts.inclusion
  totals.checked += result.checked
  totals.deferred += result.deferred
  totals.skipped += result.skipped
  totals.stepped += result.stepped
  totals.covered += result.covered
  for (const mismatch of result.mismatches) {
    totals.mismatches += 1
    const key = `${mismatch.key}: ${mismatch.detail}`
    totals.byKey[key] = (totals.byKey[key] ?? 0) + 1
  }
}

/** A journal's whole lines (a torn last line, from a kill mid-write, is left out). */
function readJournal(file: string): JournalLine[] {
  const out: JournalLine[] = []
  for (const text of readOr(file).toString("utf8").split("\n")) {
    if (!text) continue
    try {
      out.push(JSON.parse(text) as JournalLine)
    } catch {
      break
    }
  }
  return out
}

/**
 * Cut worker `worker`'s files at `depth` back to its last journal line: every inbox and pair file it
 * wrote that depth is truncated to the committed length (removed when it committed none), and a torn
 * journal line is dropped. Run before the worker (re)starts on that depth.
 */
function recoverWorker(out: string, depth: number, worker: number, extend = false): Set<number> {
  const files = paths(out)
  const lines = readJournal(files.journal(depth, worker, extend))
  const committed = lines.at(-1)?.lengths ?? {}
  const writer = `.w${pad(worker, 3)}.bin`
  for (const dir of [files.inboxDir(depth + 1), files.pairsOutDir(depth, extend)]) {
    for (const name of listDir(dir)) {
      if (!name.endsWith(writer)) continue
      const file = join(dir, name)
      const keep = committed[file] ?? 0
      if (keep === 0) rmSync(file)
      else if (statSync(file).size > keep) {
        const fd = openSync(file, "r+")
        ftruncateSync(fd, keep)
        closeSync(fd)
      }
    }
  }
  if (lines.length > 0) writeFileSync(files.journal(depth, worker, extend), lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
  else if (existsSync(files.journal(depth, worker, extend))) rmSync(files.journal(depth, worker, extend))
  return new Set(lines.filter((line) => line.complete !== false).map((line) => line.tile))
}

/** Every committed journal line of a depth, from every worker. */
export function journalLines(out: string, depth: number, extend = false): JournalLine[] {
  const prefix = `${stage(depth, extend)}.`
  const seen = new Set<number>()
  // a tile is counted once: a second line for it (a redo after a lost `done`) is dropped. Tile order,
  // not worker order: which worker took a tile is up to the queue, and the first findings merged are kept.
  return listDir(join(out, "journal"))
    .filter((name) => name.startsWith(prefix))
    .flatMap((name) => readJournal(join(out, "journal", name)))
    .filter((line) => line.complete !== false)
    .sort((a, b) => a.tile - b.tile)
    .filter((line) => !seen.has(line.tile) && seen.add(line.tile))
}

/** The tiles with an inbox at `depth`. */
function inboxTiles(out: string, depth: number): number[] {
  const tiles = new Set<number>()
  for (const name of listDir(paths(out).inboxDir(depth))) tiles.add(Number(name.slice(1, 6)))
  return [...tiles].sort((a, b) => a - b)
}

// ── the coordinator ──

export interface TiledLayer {
  depth: number
  /** distinct states through this depth (the in-memory BFS's `states`) */
  states: number
  added: number
  distinctPairs: number
  distinctPairsPerPosition: number[]
  /** this depth added nothing: the reachable set is closed (the strict "done") */
  edgeReached: boolean
  /** inbox records answered at this depth, and how many of them were already explored */
  received: number
  answered: number
  tilesWorked: number
  tileStates: { min: number; max: number; mean: number }
  /** the largest tile's explored set on disk */
  largestTileMb: number
  diskMb: number
  phaseMs: number
  workerPeakRssMb: number
  workerPeakHeapMb: number
  coordinatorRssMb: number
  /** cumulative: edges, findings and samples through the expansion of the depth below */
  edges: number
  faultCuts: number
  findingCounts: Record<string, number>
  inclusion: { checked: number; mismatches: number }
  gaps: number
  probes: { run: number; failed: number }
  /** how this depth's states' children spread over the next depth's tiles (null at the bound) */
  spreadToNext: Spread | null
  resumed: boolean
}

interface Spread {
  /** distinct next-depth tiles one source tile's children land in, on average */
  meanChildTiles: number
  /** children per source tile, on average */
  meanChildren: number
  /** the share of children that land in their source's own tile index (1/T for a uniform hash, plus the self-loops) */
  sameTileShare: number
  /** the share of children that are their parent's own state (a label that leaves the key unchanged) */
  selfLoopShare: number
}

const spreadOf = (counts: PhaseCounts): Spread | null => {
  const spread = counts.spread
  if (!spread || spread.sources === 0) return null
  const round = (value: number) => Math.round(value * 10_000) / 10_000
  return { meanChildTiles: round(spread.childTiles / spread.sources), meanChildren: round(spread.children / spread.sources), sameTileShare: round(spread.sameTile / spread.children), selfLoopShare: round((spread.selfLoops ?? 0) / spread.children) }
}

/** One line of progress.jsonl for an extension stage: a former bound's frontier expanded. */
interface TiledExtension {
  extension: true
  depth: number
  expanded: number
  edges: number
  spreadToNext: Spread | null
  phaseMs: number
  workerPeakRssMb: number
  workerPeakHeapMb: number
}

export interface TiledOptions {
  out: string
  run: RoomRun | "mesh-pair"
  depth: number
  faults?: number
  /** the room's phone count (default 3) */
  phones?: number
  /** the phone whose reload is the injected moment (default 1) */
  reloaded?: number
  /** a time horizon in ms of room time past the anchor (default none) */
  horizonMs?: number
  tiles?: number
  pairShards?: number
  inclusionEvery?: number
  probeEvery?: number
  /** worker processes; 0 runs every tile in this process (tests) */
  workers?: number
  /** a module that runs workerMain() (the forked entry); required when workers > 0 */
  workerEntry?: string
  keepInboxes?: boolean
  onLayer?: (layer: TiledLayer) => void
  /** tests: stop (as a kill would) after this many committed tiles in total */
  stopAfterTiles?: number
  /** tests: the tile at this count writes its outputs and fails before its commit */
  failTileAt?: number
  /** mesh-pair named scenario or anchor */
  scenario?: string
  heartbeat?: boolean
  version?: ExplorerVersion
  forceResume?: boolean
  /** tests and deterministic integration: checkpoint after this many state expansions in this invocation */
  stopAfterStates?: number
  /** tests: replace a mesh worker process after this many state expansions */
  workerStateLimit?: number
}

export interface TiledResult {
  meta: TiledMeta
  layers: TiledLayer[]
  states: number
  depthCompleted: number
  edgeReached: boolean
  stopped: boolean
  counts: PhaseCounts
  distinctPairs: number
  distinctPairsPerPosition: number[]
  anchorLabels: string[]
  checkpointed?: boolean
  checkpoint?: { reason: "requested" | "signal"; bytes: number; writeMs: number }
}

const dirMb = (dir: string): number => {
  let bytes = 0
  const walk = (at: string) => {
    for (const entry of listDir(at)) {
      const path = join(at, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else bytes += stat.size
    }
  }
  walk(dir)
  return Math.round(bytes / 2 ** 20)
}

/** Merge a depth's emitted pair hashes into the pair set: the set after `depth` is the set after depth - 1 plus them (an extension stage adds its own to the set after `depth`). */
function mergePairs(out: string, meta: TiledMeta, depth: number, extend = false): { total: number; perPosition: number[] } {
  const files = paths(out)
  mkdirSync(join(out, "pairs"), { recursive: true })
  let total = 0
  const positionsCount = pairsOf(metaPhones(meta)).length
  const width = maskBytes(metaPhones(meta))
  const perPosition = new Array<number>(positionsCount).fill(0)
  for (let shard = 0; shard < meta.pairShards; shard++) {
    const set = new Map<string, number>()
    const load = (buffer: Buffer) => {
      for (let at = 0; at < buffer.length; at += 16 + width) {
        const key = buffer.toString("latin1", at, at + 16)
        set.set(key, (set.get(key) ?? 0) | readMask(buffer, at + 16, width))
      }
    }
    if (extend) load(readOr(files.pairSet(depth, shard)))
    else if (depth > 0) load(readOr(files.pairSet(depth - 1, shard)))
    const prefix = `p${pad(shard, 4)}.`
    const dir = files.pairsOutDir(depth, extend)
    for (const name of listDir(dir)) if (name.startsWith(prefix)) load(readFileSync(join(dir, name)))
    const buffer = Buffer.alloc(set.size * (16 + width))
    let at = 0
    for (const [key, positions] of set) {
      buffer.write(key, at, "latin1")
      writeMask(buffer, at + 16, width, positions)
      at += 16 + width
      total += 1
      for (let position = 0; position < positionsCount; position++) if (positions & (1 << position)) perPosition[position]! += 1
    }
    writeWhole(files.pairSet(depth, shard), buffer)
    if (depth > 1 && !extend) rmSync(files.pairSet(depth - 2, shard), { force: true })
  }
  return { total, perPosition }
}

const sizes = (out: string, meta: TiledMeta, through: number) => {
  const files = paths(out)
  const perTile: number[] = []
  let largestBytes = 0
  for (let tile = 0; tile < meta.tiles; tile++) {
    let bytes = 0
    for (let depth = 0; depth <= through; depth++) if (existsSync(files.explored(tile, depth))) bytes += statSync(files.explored(tile, depth)).size
    perTile.push(bytes / ID_BYTES)
    largestBytes = Math.max(largestBytes, bytes)
  }
  const total = perTile.reduce((sum, value) => sum + value, 0)
  return { total, min: Math.min(...perTile), max: Math.max(...perTile), mean: Math.round(total / meta.tiles), largestTileMb: Math.round((largestBytes / 2 ** 20) * 100) / 100 }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex")
const meshStateId = (fingerprint: string): Buffer => createHash("sha256").update(fingerprint).digest().subarray(0, ID_BYTES)

/** Pair shards of a new run: a V8 Map holds at most 2^24 entries, so 64 shards reach about 1.07 billion distinct pairs (#1795). */
const DEFAULT_PAIR_SHARDS = 64

/** Tiles of a new run (#1775): a smaller last-wave quantum and smaller per-tile sets; measured no slower at small depths. A run on disk keeps its own. */
const DEFAULT_TILES = 1024

/**
 * Run, resume or extend a tiled search. A run directory continues only with the bounds and the key
 * format it was started with. A finished run given a deeper `depth` continues from its bound's
 * frontier: an extension stage expands the bound's new states (kept as each tile's frontier file), and
 * the next depths run as usual over the same explored sets, so no depth is recomputed.
 */
export async function runTiled(options: TiledOptions): Promise<TiledResult> {
  const { out } = options
  const files = paths(out)
  mkdirSync(out, { recursive: true })
  const run = options.run
  const mesh = run === "mesh-pair"
  const named = options.scenario ?? "rejoin-two-offers"
  const meshAnchor = mesh && isMeshAnchor(named) ? named : undefined
  const scenario = meshAnchor ? MESH_ANCHORS[meshAnchor].scenario : named as ScenarioName
  if (mesh && !Object.hasOwn(SCENARIOS, scenario)) throw new Error(`unknown mesh-pair scenario: ${named}`)
  const warmup = mesh
    ? meshAnchor
      ? readMeshAnchor(meshAnchor).warmup
      : SCENARIOS[scenario].from
        ? readMeshAnchor(SCENARIOS[scenario].from).warmup
        : []
    : []
  const faults = options.faults ?? (mesh ? SCENARIOS[scenario].defaults.faults : 1)
  const phones = options.phones ?? 3
  const reloaded = options.reloaded ?? 1
  const anchor = mesh ? undefined : roomAnchor(phones, run as RoomRun, faults, reloaded)
  const anchorParts = anchor ? roomKeyParts(anchor.room) : undefined
  let anchorId: Uint8Array
  if (mesh) {
    const { exploreRoom } = await import("../mesh/room")
    const room = await exploreRoom({
      scenario,
      phaseOffsetMs: 1000,
      faults: faults + warmup.filter(isFault).length,
      horizonMs: options.horizonMs ?? SCENARIOS[scenario].defaults.horizonMs,
      monitors: monitorsFor(1),
      heartbeat: options.heartbeat !== false,
    })
    try {
      for (const label of warmup) await room.step(label)
      const fingerprint = room.fingerprint()
      anchorId = meshStateId(fingerprint)
    } finally {
      room.close()
    }
  } else {
    anchorId = stateIdOf(anchorParts!, options.horizonMs === undefined ? undefined : 0)
  }
  // a new run takes the defaults; a run already on disk keeps the pairShards it was started with unless one is passed
  const stored = existsSync(files.meta) ? (JSON.parse(readFileSync(files.meta, "utf8")) as Partial<TiledMeta>) : undefined
  const want: TiledMeta = {
    run,
    depth: options.depth,
    faults,
    tiles: options.tiles ?? stored?.tiles ?? DEFAULT_TILES,
    pairShards: options.pairShards ?? stored?.pairShards ?? DEFAULT_PAIR_SHARDS,
    inclusionEvery: options.inclusionEvery ?? 100,
    probeEvery: options.probeEvery ?? 1000,
    keyFormat: ROOM_KEY_FORMAT,
    anchorId: hex(anchorId),
    extended: [],
    // the parameters that differ from the defaults are recorded only when they do, so a default run's meta is what it was
    ...(phones !== 3 ? { phones } : {}),
    ...(reloaded !== 1 ? { reloaded } : {}),
    ...(beatFromEnv() ? { beat: true } : {}),
    ...(rtxUnsafeKey() !== "" ? { rtxUnsafe: rtxUnsafeKey() } : {}),
    ...(frozenKey() !== "" ? { frozen: frozenKey() } : {}),
    ...(noLaneOtherFromEnv() ? { noLaneOther: true } : {}),
    ...(options.horizonMs !== undefined ? { horizonMs: options.horizonMs } : {}),
    ...(mesh ? {
      machine: "mesh-pair" as const,
      scenario,
      ...(meshAnchor ? { anchor: meshAnchor } : {}),
      warmup,
      ...(options.heartbeat === false ? { heartbeat: false } : {}),
      version: options.version,
    } : {}),
  }
  let meta: TiledMeta
  if (existsSync(files.meta)) {
    meta = JSON.parse(readFileSync(files.meta, "utf8")) as TiledMeta
    meta.extended ??= []
    for (const key of ["run", "faults", "tiles", "pairShards", "inclusionEvery", "probeEvery", "phones", "reloaded", "beat", "rtxUnsafe", "frozen", "noLaneOther", "horizonMs", "machine", "scenario", "anchor", "heartbeat"] as const) {
      if ((meta[key] ?? (key === "phones" ? 3 : key === "reloaded" ? 1 : key === "beat" || key === "noLaneOther" ? false : undefined)) !== (want[key] ?? (key === "phones" ? 3 : key === "reloaded" ? 1 : key === "beat" || key === "noLaneOther" ? false : undefined))) throw new Error(`${out} was started with ${key}=${meta[key]}, not ${want[key]}: a run resumes or extends only with the bounds it was started with`)
    }
    if (mesh) {
      if (!meta.version || !options.version) throw new Error(`${out} has no explorer source version; start a new --out`)
      assertCheckpointVersion(meta.version, options.version, options.forceResume ?? false)
    }
    if (meta.keyFormat !== want.keyFormat || meta.anchorId !== want.anchorId) {
      throw new Error(`${out} was written with room key format ${meta.keyFormat ?? "1 (before #1580's fix)"} and anchor ${meta.anchorId ?? "unrecorded"}; this code keys format ${want.keyFormat}, anchor ${want.anchorId}. Its tile files cannot be resumed or extended: start a new --out.`)
    }
    if (want.depth > meta.depth) {
      const last = lastDoneDepth(out)
      if (last === meta.depth) {
        const marker = JSON.parse(readFileSync(files.phase(last), "utf8")) as { layer: TiledLayer | null }
        if (!marker.layer?.edgeReached) {
          // a finished run: continue from its bound's frontier
          for (let tile = 0; tile < meta.tiles; tile++) {
            if (existsSync(files.explored(tile, last)) && !existsSync(files.frontier(tile, last))) throw new Error(`${out} finished at depth ${last} without frontier files (written before extension existed): it cannot be extended`)
          }
          meta = { ...meta, depth: want.depth, extended: [...meta.extended, last] }
        }
      } else if (listDir(join(out, "journal")).some((name) => name.startsWith(`${stage(meta.depth, false)}.`))) {
        throw new Error(`${out} is inside its bound depth ${meta.depth}: resume it with --depth ${meta.depth} to the end, then extend`)
      } else {
        meta = { ...meta, depth: want.depth }
      }
      writeWhole(files.meta, JSON.stringify(meta, null, 2))
    }
  } else {
    meta = want
    writeWhole(files.meta, JSON.stringify(meta, null, 2))
    mkdirSync(files.inboxDir(0), { recursive: true })
    writeWhole(files.inbox(0, tileOf(anchorId, meta.tiles), "seed"), encodeRecord(anchorId, new Uint8Array(0)))
    if (anchorParts) {
      mkdirSync(files.pairsOutDir(0), { recursive: true })
      anchorParts.pairHashes.forEach((hash, position) => {
        const entry = Buffer.alloc(16 + maskBytes(phones))
        entry.write(hash, 0, "latin1")
        writeMask(entry, 16, maskBytes(phones), position < 31 ? 1 << position : 0)
        appendFileSync(files.pairsOut(0, shardOf(hash, meta.pairShards), "seed"), entry)
      })
    }
  }

  // the layers so far, from the stage markers (progress.jsonl is rewritten from them)
  const layers: TiledLayer[] = []
  const progress: string[] = []
  let totals = emptyCounts()
  let depth = 0
  let resumed = false
  for (; existsSync(files.phase(depth)); depth++) {
    const marker = JSON.parse(readFileSync(files.phase(depth), "utf8")) as { layer: TiledLayer | null; totals: PhaseCounts }
    totals = marker.totals
    if (marker.layer) {
      layers.push(marker.layer)
      progress.push(JSON.stringify(marker.layer))
    }
    if (existsSync(files.phase(depth, true))) {
      const extension = JSON.parse(readFileSync(files.phase(depth, true), "utf8")) as { line: TiledExtension; totals: PhaseCounts }
      totals = extension.totals
      const boundLayer = layers.at(-1)
      if (boundLayer?.depth === depth) boundLayer.spreadToNext = extension.line.spreadToNext
      progress.push(JSON.stringify(extension.line))
    }
    resumed = true
  }
  writeWhole(files.progress, progress.map((line) => `${line}\n`).join(""))
  // a finished depth's inbox may outlive a kill between its marker and its cleanup
  if (!options.keepInboxes) for (let done = 0; done < depth; done++) cleanup(out, done)

  let edgeReached = layers.at(-1)?.edgeReached ?? false
  let stopped = false
  let committedTiles = 0
  let committedStates = 0
  const pool = (options.workers ?? 0) > 0
    ? mesh
      ? new MeshWorkerPool(out, options.workers!, options.workerStateLimit ?? MESH_WORKER_STATE_LIMIT)
      : new WorkerPool(out, options.workers!, options.workerEntry)
    : undefined
  const local = pool ? undefined : new TileWorker(out, 0)
  let signalRequested = false
  const onUsr1 = () => {
    signalRequested = true
    writeWhole(files.stop, "SIGUSR1\n")
    local?.requestStop()
  }
  if (mesh) process.on("SIGUSR1", onUsr1)

  /** Every tile of `tiles` at the stage, after cutting each writer back to its last commit (a resumed stage); false when stopped. */
  const runStage = async (at: number, extend: boolean, tiles: number[]): Promise<boolean> => {
    const done = new Set<number>()
    const named = new RegExp(`^${stage(at, extend)}\\.w(\\d+)\\.jsonl$`)
    for (const name of listDir(join(out, "journal"))) {
      const match = named.exec(name)
      if (match) for (const tile of recoverWorker(out, at, Number(match[1]), extend)) done.add(tile)
    }
    // a worker killed before its first journal line, then dropped by a smaller pool, left only output files
    const writers = new Set(Array.from({ length: pool ? pool.size : 1 }, (_, worker) => worker))
    for (const dir of [files.inboxDir(at + 1), files.pairsOutDir(at, extend)]) {
      for (const name of listDir(dir)) {
        const match = /\.w(\d+)\.bin$/.exec(name)
        if (match) writers.add(Number(match[1]))
      }
    }
    for (const worker of writers) recoverWorker(out, at, worker, extend)
    if (done.size > 0) resumed = true
    const todo = tiles.filter((tile) => !done.has(tile))
    if (pool) {
      const result = await pool.runDepth(at, todo, options.stopAfterTiles === undefined ? undefined : options.stopAfterTiles - committedTiles, extend)
      committedTiles += result.committed
      return !result.stopped
    }
    for (const tile of todo) {
      if (options.stopAfterTiles !== undefined && committedTiles >= options.stopAfterTiles) return false
      const remaining = options.stopAfterStates === undefined ? undefined : options.stopAfterStates - committedStates
      if (remaining !== undefined && remaining <= 0) return false
      const result = await local!.processTile(at, tile, {
        failBeforeCommit: options.failTileAt === committedTiles,
        extend,
        maxStates: remaining,
      })
      committedStates += result.states
      if (!result.complete) return false
      committedTiles += 1
    }
    return true
  }

  try {
    for (; depth <= meta.depth && !edgeReached; depth++) {
      // a former bound below: expand its frontier first (its new states become this depth's inbox)
      const bound = depth - 1
      if (meta.extended.includes(bound) && !existsSync(files.phase(bound, true))) {
        const began = Date.now()
        const tiles = Array.from({ length: meta.tiles }, (_, tile) => tile).filter((tile) => existsSync(files.frontier(tile, bound)) && statSync(files.frontier(tile, bound)).size > 0)
        if (!(await runStage(bound, true, tiles))) {
          stopped = true
          break
        }
        const phase = emptyCounts()
        for (const line of journalLines(out, bound, true)) mergeCounts(phase, line.counts)
        totals = mergeCounts(JSON.parse(JSON.stringify(totals)) as PhaseCounts, phase)
        if (!mesh) mergePairs(out, meta, bound, true)
        const line: TiledExtension = { extension: true, depth: bound, expanded: tiles.reduce((sum, tile) => sum + statSync(files.frontier(tile, bound)).size / (ID_BYTES + bound * STEP_BYTES), 0), edges: phase.edges, spreadToNext: spreadOf(phase), phaseMs: Date.now() - began, workerPeakRssMb: phase.peakRssMb, workerPeakHeapMb: phase.peakHeapMb }
        const boundLayer = layers.at(-1)
        if (boundLayer?.depth === bound) boundLayer.spreadToNext = line.spreadToNext
        writeWhole(files.phase(bound, true), JSON.stringify({ line, totals }))
        appendFileSync(files.progress, `${JSON.stringify(line)}\n`)
        console.log(`tiled ${JSON.stringify(line)}`)
        if (!options.keepInboxes) {
          rmSync(files.pairsOutDir(bound, true), { recursive: true, force: true })
          for (let tile = 0; tile < meta.tiles; tile++) rmSync(files.frontier(tile, bound), { force: true })
        }
      }

      const began = Date.now()
      if (!(await runStage(depth, false, inboxTiles(out, depth)))) {
        stopped = true
        break
      }

      // the barrier: every tile of this depth is committed
      const phase = emptyCounts()
      const lines = journalLines(out, depth)
      for (const line of lines) mergeCounts(phase, line.counts)
      const before = totals
      totals = mergeCounts(JSON.parse(JSON.stringify(before)) as PhaseCounts, phase)
      totals.newStates = before.newStates + phase.newStates
      const pairsBefore = !mesh && depth > 0 ? countPairs(out, meta, depth - 1) : { total: 0, perPosition: new Array<number>(mesh ? 0 : pairsOf(metaPhones(meta)).length).fill(0) }
      if (!mesh) mergePairs(out, meta, depth)
      let layer: TiledLayer | null = null
      if (depth > 0) {
        const tileSizes = sizes(out, meta, depth)
        layer = {
          depth,
          states: tileSizes.total,
          added: phase.newStates,
          distinctPairs: pairsBefore.total,
          distinctPairsPerPosition: pairsBefore.perPosition,
          edgeReached: phase.newStates === 0,
          received: phase.received,
          answered: phase.answered,
          tilesWorked: lines.length,
          tileStates: { min: tileSizes.min, max: tileSizes.max, mean: tileSizes.mean },
          largestTileMb: tileSizes.largestTileMb,
          diskMb: dirMb(out),
          phaseMs: Date.now() - began,
          workerPeakRssMb: phase.peakRssMb,
          workerPeakHeapMb: phase.peakHeapMb,
          coordinatorRssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
          // edges and findings at this layer: those of expanding the depth below (bfs.ts's accounting)
          edges: before.edges,
          faultCuts: before.faultCuts,
          findingCounts: { ...before.findingCounts },
          inclusion: { checked: before.inclusion.checked, mismatches: before.inclusion.mismatches },
          gaps: before.gaps.count,
          probes: { ...totals.probes },
          spreadToNext: spreadOf(phase),
          resumed,
        }
        edgeReached = layer.edgeReached
      }
      writeWhole(files.phase(depth), JSON.stringify({ layer, totals }))
      if (layer) {
        layers.push(layer)
        appendFileSync(files.progress, `${JSON.stringify(layer)}\n`)
        options.onLayer?.(layer)
      }
      if (!options.keepInboxes) cleanup(out, depth)
      resumed = false
    }
  } finally {
    if (mesh) process.off("SIGUSR1", onUsr1)
    await pool?.close()
    local?.close()
  }
  const last = layers.at(-1)
  const pairs = last ? { total: last.distinctPairs, perPosition: last.distinctPairsPerPosition } : { total: 0, perPosition: new Array<number>(pairsOf(metaPhones(meta)).length).fill(0) }
  let checkpoint: TiledResult["checkpoint"]
  if (mesh && stopped) {
    const signalStop = signalRequested || readOr(files.stop).toString("utf8").includes("SIGUSR1")
    const began = performance.now()
    const before = directoryBytes(out)
    await atomicWriteJson(files.checkpoint, {
      schema: 1,
      reason: signalStop ? "signal" : "requested",
      version: meta.version,
      options: { run: meta.run, scenario: meta.scenario, depth: meta.depth, faults: meta.faults, horizonMs: meta.horizonMs, tiles: meta.tiles, heartbeat: meta.heartbeat !== false },
      completedDepth: last?.depth ?? 0,
      layers,
      counters: totals,
      findings: totals.findings,
      progressLine: last ?? null,
      storage: { bytesBeforeManifest: before },
    })
    checkpoint = { reason: signalStop ? "signal" : "requested", bytes: directoryBytes(out), writeMs: performance.now() - began }
  }
  return {
    meta,
    layers,
    states: last?.states ?? 1,
    depthCompleted: last?.depth ?? 0,
    edgeReached,
    stopped,
    counts: totals,
    distinctPairs: pairs.total,
    distinctPairsPerPosition: pairs.perPosition,
    anchorLabels: anchor?.labels ?? warmup,
    ...(checkpoint ? { checkpointed: true, checkpoint } : {}),
  }
}

function directoryBytes(dir: string): number {
  let bytes = 0
  const walk = (at: string) => {
    for (const entry of listDir(at)) {
      const path = join(at, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else bytes += stat.size
    }
  }
  walk(dir)
  return bytes
}

function countPairs(out: string, meta: TiledMeta, depth: number): { total: number; perPosition: number[] } {
  const files = paths(out)
  let total = 0
  const positionsCount = pairsOf(metaPhones(meta)).length
  const width = maskBytes(metaPhones(meta))
  const perPosition = new Array<number>(positionsCount).fill(0)
  for (let shard = 0; shard < meta.pairShards; shard++) {
    const buffer = readOr(files.pairSet(depth, shard))
    for (let at = 0; at < buffer.length; at += 16 + width) {
      total += 1
      const positions = readMask(buffer, at + 16, width)
      for (let position = 0; position < positionsCount; position++) if (positions & (1 << position)) perPosition[position]! += 1
    }
  }
  return { total, perPosition }
}

function lastDoneDepth(out: string): number {
  let depth = 0
  while (existsSync(paths(out).phase(depth))) depth++
  return depth - 1
}

/** A finished depth's inbox and emitted pairs are consumed: remove them. */
function cleanup(out: string, depth: number) {
  const files = paths(out)
  rmSync(files.inboxDir(depth), { recursive: true, force: true })
  rmSync(files.pairsOutDir(depth), { recursive: true, force: true })
}

// ── worker processes ──

interface Assigned {
  depth: number
  tile: number
  extend: boolean
}

type Handlers = {
  onMessage: (worker: number, message: { type: string; tile?: number }) => void
  onExit: (worker: number, code: number | null, signal: string | null) => void
}

/** Mesh rooms require Vitest's fake-clock runtime, so each logical worker is one Vitest tile batch. */
export class MeshWorkerPool {
  readonly size: number
  private readonly children = new Set<ChildProcess>()
  private closing = false

  constructor(
    private readonly out: string,
    size: number,
    private readonly stateLimit: number,
  ) {
    this.size = size
    if (!Number.isInteger(stateLimit) || stateLimit <= 0) throw new Error(`mesh worker state limit must be a positive integer, got ${stateLimit}`)
  }

  /**
   * Every tile of `todo` at `depth`, from one shared queue: an idle worker takes the next tiles (as the
   * room WorkerPool does), so no worker sits idle while tiles wait. It takes a share of what is left
   * (guided scheduling: many small tiles share one Vitest start, the tail goes one tile at a time), and
   * keeps those tiles, one Vitest batch after another, until their journals say complete.
   */
  async runDepth(depth: number, todo: number[], stopAfter?: number, extend = false): Promise<{ committed: number; stopped: boolean }> {
    const limited = stopAfter === undefined ? todo : todo.slice(0, Math.max(0, stopAfter))
    const queue = [...limited]
    const stopFile = paths(this.out).stop
    const halted = () => this.closing || existsSync(stopFile)
    const appDir = resolve(import.meta.dirname, "../../..")
    const results = await Promise.all(Array.from({ length: this.size }, async (_, worker) => {
      let committed = 0
      while (!halted()) {
        let taken = queue.splice(0, Math.max(1, Math.floor(queue.length / (2 * this.size))))
        if (taken.length === 0) return { committed, stopped: false }
        for (;;) {
          const batch = { out: this.out, worker, depth, tiles: taken, extend, maxStates: this.stateLimit }
          await new Promise<void>((done, fail) => {
            const child = spawn("npx", [
              "vitest",
              "run",
              "--config",
              "vitest.explore.config.ts",
              "lib/explorer/room/tiled-worker.explore.ts",
              "--maxWorkers=1",
            ], {
              cwd: appDir,
              env: { ...process.env, TILED_MESH_BATCH: JSON.stringify(batch) },
              stdio: "inherit",
              detached: true,
            })
            this.children.add(child)
            child.on("error", fail)
            child.on("exit", (code, signal) => {
              this.children.delete(child)
              if (code === 0) done()
              else {
                // the other workers take no more tiles: the run fails and a resume picks up from the journals
                this.closing = true
                fail(new Error(`tiled mesh worker ${worker} exited ${signal ?? code}`))
              }
            })
          })
          const completed = recoverWorker(this.out, depth, worker, extend)
          const left = taken.filter((tile) => !completed.has(tile))
          committed += taken.length - left.length
          taken = left
          if (taken.length === 0) break
          if (halted()) return { committed, stopped: true }
        }
      }
      return { committed, stopped: true }
    }))
    return {
      committed: results.reduce((total, result) => total + result.committed, 0),
      stopped: limited.length < todo.length || results.some((result) => result.stopped) || existsSync(stopFile),
    }
  }

  /** Stop every batch and wait for its process group to go, so no writer outlives the run. */
  async close(): Promise<void> {
    this.closing = true
    const exits = [...this.children].map((child) => new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      const kill: { timer?: ReturnType<typeof setTimeout> } = {}
      child.once("exit", () => {
        // the child went on its own: the group may already hold a reused pid, so never signal it later
        if (kill.timer !== undefined) clearTimeout(kill.timer)
        done()
      })
      const signal = (name: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, name)
        } catch {
          child.kill(name)
        }
      }
      signal("SIGTERM")
      kill.timer = setTimeout(() => signal("SIGKILL"), 10_000)
      kill.timer.unref()
    }))
    await Promise.all(exits)
  }
}

class WorkerPool {
  private readonly children: (ChildProcess | null)[] = []
  private readonly busy: (Assigned | null)[] = []
  private closing = false
  private handlers: Handlers | null = null

  constructor(
    private readonly out: string,
    readonly size: number,
    private readonly entry: string | undefined,
  ) {
    if (!entry) throw new Error("runTiled: workers > 0 needs workerEntry")
  }

  private spawn(worker: number) {
    const child = fork(this.entry!, ["--worker", String(worker), "--out", this.out], {
      execArgv: ["--import", "tsx", ...process.execArgv.filter((arg) => arg.startsWith("--max-old-space-size"))],
      env: { ...process.env, NEXT_PUBLIC_NETWORK_NAME: process.env.NEXT_PUBLIC_NETWORK_NAME ?? "paseo" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    })
    child.on("message", (message) => this.handlers?.onMessage(worker, message as { type: string; tile?: number }))
    child.on("exit", (code, signal) => this.handlers?.onExit(worker, code, signal))
    this.children[worker] = child
  }

  /** Every tile of `todo` at `depth`, on the pool; a worker that dies is cut back to its last commit, its tile requeued, and respawned. */
  runDepth(depth: number, todo: number[], stopAfter?: number, extend = false): Promise<{ committed: number; stopped: boolean }> {
    const queue = [...todo]
    let committed = 0
    let outstanding = todo.length
    return new Promise((resolve, reject) => {
      if (outstanding === 0) return resolve({ committed, stopped: false })
      let finished = false
      const finish = (stopped: boolean) => {
        if (finished) return
        finished = true
        resolve({ committed, stopped })
      }
      const next = (worker: number) => {
        if (finished) return
        if (stopAfter !== undefined && committed >= stopAfter) return finish(true)
        const tile = queue.shift()
        if (tile === undefined) {
          this.busy[worker] = null
          return
        }
        this.busy[worker] = { depth, tile, extend }
        this.children[worker]!.send({ type: "tile", depth, tile, extend })
      }
      this.handlers = {
        onMessage: (worker, message) => {
          if (message.type === "ready") return next(worker)
          if (message.type === "done") {
            committed += 1
            outstanding -= 1
            this.busy[worker] = null
            if (outstanding === 0) return finish(false)
            return next(worker)
          }
          if (message.type === "error") {
            finished = true
            reject(new Error(`worker ${worker}: ${JSON.stringify(message)}`))
          }
        },
        onExit: (worker, code, signal) => {
          if (this.closing || finished) return
          const lost = this.busy[worker]
          console.error(`tiled: worker ${worker} exited (${signal ?? code}) ${lost ? `during tile ${lost.tile} at depth ${lost.depth}` : "idle"}: cutting its files back to its last commit and respawning`)
          const committedTiles = recoverWorker(this.out, depth, worker, extend)
          this.busy[worker] = null
          if (lost && committedTiles.has(lost.tile)) {
            // it committed the tile and died before `done` arrived: that is a done, not a redo
            committed += 1
            outstanding -= 1
          } else if (lost) queue.unshift(lost.tile)
          this.spawn(worker)
          if (outstanding === 0) finish(false)
        },
      }
      for (let worker = 0; worker < this.size; worker++) {
        if (!this.children[worker]) this.spawn(worker)
        else next(worker)
      }
    })
  }

  close() {
    this.closing = true
    for (const child of this.children) child?.kill()
  }
}

/** The forked worker's loop: answer "tile" messages until the parent goes. */
export function workerMain(argv: string[]): void {
  const at = (flag: string) => argv[argv.indexOf(flag) + 1]!
  const worker = new TileWorker(at("--out"), Number(at("--worker")))
  process.on("message", async (message: { type: string; depth: number; tile: number; extend?: boolean }) => {
    if (message.type !== "tile") return
    try {
      const result = await worker.processTile(message.depth, message.tile, { extend: message.extend ?? false })
      // tests: die once, after the journal commit and before `done` (the marker file makes it once)
      const marker = process.env.TILED_TEST_EXIT_AFTER_COMMIT
      if (marker && !existsSync(marker)) {
        writeFileSync(marker, "")
        process.exit(1)
      }
      process.send!({ type: result.complete ? "done" : "checkpointed", tile: message.tile, depth: message.depth })
    } catch (error) {
      process.send!({ type: "error", tile: message.tile, depth: message.depth, error: error instanceof Error ? error.stack : String(error) })
    }
  })
  process.on("disconnect", () => process.exit(0))
  process.send!({ type: "ready" })
}
