// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { availableParallelism } from "node:os"
import type { Room } from "../mesh/room"
import type { Label } from "./labels"
import type { Cut, Finding, Leaf, SearchLevel, SearchResult } from "./search"

export type MachineName =
  | "mesh-pair"
  | "payoff"
  | "peer-actor"
  | "camera"
  | "read-retry"
  | "chest-reread"
  | "launch-stall"
  | "clock-sync"
  | "report-outbox"
  | "report-retry"
  | "send-adaptation"
  | "evidence-projection"
  | "chain-health"
  | "message-expiry-clock"
  | "signup-retry"
  | "store-calibration"
  | "draw-screen"
  | "chest-screen"
  | "sweeps"
  | "self"

export interface ExploreArgs {
  machine: MachineName
  depth?: number
  faults?: number
  seed?: number
  replay?: string
  scenario?: string
  horizonS?: number
  sample?: number
  budgetMin: number
  /** peer-actor: the state cap (default 2,000,000) */
  maxStates?: number
  /** peer-actor: index visited worlds by a 64-bit hash of their key (default on) */
  hash: boolean
  /** peer-actor: write phase B's simplification candidates (full keys, so no hashing) */
  candidates?: boolean
  /** peer-actor --candidates: the depth from the fair-run and seed-run worlds (default 3) */
  fairDepth?: number
  /** Search from named anchors. peer-actor: one name, a comma list or
   *  `all` (actor/anchors.ts); mesh-pair: `all` runs every mesh anchor
   *  (mesh/anchors.ts), one name is the same as `--scenario <name>`. More
   *  than one runs one process per anchor and writes one merged report. */
  anchor?: string
  selfTest: boolean
  emitTest: boolean
  out: string
  /** search machines: vitest processes the tree is sharded over (default cores - 2) */
  workers: number
  /** set by shardPlan on each worker's args */
  shard?: { index: number; of: number; depth: 2 }
  /** the heap each vitest worker must have, checked at run start */
  heapGb?: number
  /** mesh-pair only: default-off distinct-room census; does not prune */
  census: boolean
  /** mesh-pair only: default-off visited-set pruning on the hardened room fingerprint */
  dedup: boolean
  /** ordered sampled suffix replay; defaults to 1/100 while dedup is enabled */
  dedupCheck?: { oneIn: number }
  /** mesh-pair only, default off: L1 (eventually steady, room.ts checkLiveness) at every `every`-th depth, horizon or quiet leaf */
  liveness?: { every: number; /** a leaf steady only after more than this many fake s is an L1 finding */ boundS?: number }
  /** mesh-pair only: false runs the room without the `hb:<side>` heartbeat (#1525), to compare */
  heartbeat?: false
  /** checkpointable tiled mesh-pair run to continue; also becomes `out` */
  resume?: string
  /** continue despite a git/source version mismatch in the checkpoint */
  forceResume: boolean
  /** retain the former iterative-deepening DFS for comparison until the tiled path is reviewed */
  legacyDfs: boolean
}

interface CheckedLeaf {
  cut: Cut
  detail?: string
  harnessDetail?: string
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

/** Design 1.1's leaf check: every quiet leaf, every check-unowned leaf, and
 * otherwise a deterministic seeded 1-in-100 sample of non-quiet leaves. */
export function leafChecks(seed: number, checkUnowned = false): {
  onLeaf(leaf: Leaf, harnessDetail?: string): Promise<void>
  merge(result: SearchResult): void
} {
  const random = seededRandom(seed)
  const checked: CheckedLeaf[] = []
  return {
    async onLeaf(leaf, harnessDetail) {
      const record: CheckedLeaf = { cut: leaf.cut, detail: leaf.detail, harnessDetail }
      checked.push(record)
      if (harnessDetail !== undefined) return
      const shouldCheck =
        leaf.cut !== "seen" &&
        (leaf.cut === "quiet" || checkUnowned || random() < 1 / 100)
      if (!shouldCheck) return

      try {
        await (leaf.room as Room).checkLeaf()
      } catch (error) {
        record.harnessDetail = message(error)
      }
    },
    merge(result) {
      let offset = 0
      for (const level of result.levels) {
        const levelChecks = checked.slice(offset, offset + level.leaves)
        offset += level.leaves
        for (const check of levelChecks) {
          if (check.harnessDetail === undefined) continue
          level.cuts[check.cut] -= 1
          level.cuts.harness += 1
          if (check.detail !== undefined) {
            level.details[check.detail] -= 1
            if (level.details[check.detail] === 0) {
              delete level.details[check.detail]
            }
          }
          level.details[check.harnessDetail] =
            (level.details[check.harnessDetail] ?? 0) + 1
        }
      }
      result.closedAtDepth = 0
      for (const level of result.levels) {
        if (level.cuts.harness > 0) break
        result.closedAtDepth = level.depth
      }
    },
  }
}

const USAGE = `Usage: npm run explore -- --machine <mesh-pair|payoff|peer-actor|camera|read-retry|chest-reread|launch-stall|clock-sync|report-outbox|report-retry|send-adaptation|evidence-projection|chain-health|message-expiry-clock|signup-retry|store-calibration|draw-screen|chest-screen|sweeps|self>
  [--depth N] [--faults F] [--seed S] [--replay file]
  [--scenario name] [--horizon-s H] [--sample N]
  [--budget-min T] [--self-test|--no-self-test] [--emit-test] [--out dir]
  [--workers W] [--heap-gb G] [--census]
  [--dedup] [--dedup-check 1/N]
  [--resume dir] [--force-resume] [--legacy-dfs]
  mesh-pair:  [--liveness | --liveness-every N] [--liveness-bound-s B] [--no-heartbeat]
  peer-actor: [--max-states N] [--hash|--no-hash] [--candidates [--fair-depth N]]
  anchors:    --anchor <name|a,b|all>  (peer-actor; mesh-pair takes all, or --scenario <anchor>)`

const MACHINES = new Set<MachineName>([
  "mesh-pair",
  "payoff",
  "peer-actor",
  "camera",
  "read-retry",
  "chest-reread",
  "launch-stall",
  "clock-sync",
  "report-outbox",
  "report-retry",
  "send-adaptation",
  "evidence-projection",
  "chain-health",
  "message-expiry-clock",
  "signup-retry",
  "store-calibration",
  "draw-screen",
  "chest-screen",
  "sweeps",
  "self",
])

export class UsageError extends Error {
  constructor(detail: string) {
    super(`${detail}\n\n${USAGE}`)
    this.name = "UsageError"
  }
}

const integer = (
  option: string,
  value: string | undefined,
  minimum: number,
): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new UsageError(`${option} must be an integer >= ${minimum}`)
  }
  return parsed
}

const finite = (
  option: string,
  value: string | undefined,
  minimum: number,
): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new UsageError(`${option} must be a number >= ${minimum}`)
  }
  return parsed
}

const valueAfter = (argv: readonly string[], index: number): string => {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${argv[index]} requires a value`)
  }
  return value
}

export function outputDir(machine: MachineName, at = new Date()): string {
  const stamp = at
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z")
  return `test-results/explorer/${stamp}-${machine}`
}

export function parseArgs(argv: readonly string[]): ExploreArgs {
  let machine: MachineName | undefined
  let depth: number | undefined
  let faults: number | undefined
  let seed: number | undefined
  let replay: string | undefined
  let scenario: string | undefined
  let horizonS: number | undefined
  let sample: number | undefined
  let budgetMin = 30
  let budgetMinExplicit = false
  let maxStates: number | undefined
  let hash = true
  let candidates: boolean | undefined
  let fairDepth: number | undefined
  let anchor: string | undefined
  let selfTest: boolean | undefined
  let emitTest = false
  let out: string | undefined
  let workers = Math.max(1, availableParallelism() - 2)
  let heapGb: number | undefined
  let census = false
  let dedup = false
  let dedupCheck: { oneIn: number } | undefined
  let liveness: { every: number } | undefined
  let livenessBoundS: number | undefined
  let heartbeat: false | undefined
  let resume: string | undefined
  let forceResume = false
  let legacyDfs = false

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    switch (option) {
      case "--machine": {
        const value = valueAfter(argv, index)
        if (!MACHINES.has(value as MachineName)) {
          throw new UsageError(`unknown machine: ${value}`)
        }
        machine = value as MachineName
        index += 1
        break
      }
      case "--depth":
        depth = integer(option, valueAfter(argv, index), 1)
        index += 1
        break
      case "--faults":
        faults = integer(option, valueAfter(argv, index), 0)
        index += 1
        break
      case "--seed":
        seed = integer(option, valueAfter(argv, index), 0)
        index += 1
        break
      case "--replay":
        replay = valueAfter(argv, index)
        index += 1
        break
      case "--scenario":
        scenario = valueAfter(argv, index)
        index += 1
        break
      case "--horizon-s":
        horizonS = finite(option, valueAfter(argv, index), 0)
        index += 1
        break
      case "--sample":
        sample = integer(option, valueAfter(argv, index), 0)
        index += 1
        break
      case "--budget-min":
        budgetMin = finite(option, valueAfter(argv, index), 0)
        budgetMinExplicit = true
        index += 1
        break
      case "--max-states":
        maxStates = integer(option, valueAfter(argv, index), 1)
        index += 1
        break
      case "--hash":
        hash = true
        break
      case "--no-hash":
        hash = false
        break
      case "--candidates":
        candidates = true
        break
      case "--fair-depth":
        fairDepth = integer(option, valueAfter(argv, index), 1)
        index += 1
        break
      case "--anchor":
        anchor = valueAfter(argv, index)
        index += 1
        break
      case "--self-test":
        selfTest = true
        break
      case "--no-self-test":
        selfTest = false
        break
      case "--emit-test":
        emitTest = true
        break
      case "--out":
        out = valueAfter(argv, index)
        index += 1
        break
      case "--workers":
        workers = integer(option, valueAfter(argv, index), 1)
        index += 1
        break
      case "--heap-gb":
        heapGb = finite(option, valueAfter(argv, index), 0)
        index += 1
        break
      case "--census":
        census = true
        break
      case "--dedup":
        dedup = true
        break
      case "--dedup-check": {
        const value = valueAfter(argv, index)
        const match = /^1\/([1-9]\d*)$/.exec(value)
        if (match === null) throw new UsageError("--dedup-check must be 1/N with N >= 1")
        dedup = true
        dedupCheck = { oneIn: Number(match[1]) }
        index += 1
        break
      }
      case "--liveness":
        liveness = { every: liveness?.every ?? 1 }
        break
      case "--liveness-every":
        liveness = { every: integer(option, valueAfter(argv, index), 1) }
        index += 1
        break
      case "--liveness-bound-s":
        livenessBoundS = finite(option, valueAfter(argv, index), Number.MIN_VALUE)
        index += 1
        break
      case "--no-heartbeat":
        heartbeat = false
        break
      case "--resume":
        resume = valueAfter(argv, index)
        index += 1
        break
      case "--force-resume":
        forceResume = true
        break
      case "--legacy-dfs":
        legacyDfs = true
        break
      default:
        throw new UsageError(`unknown option: ${option}`)
    }
  }

  if (machine === undefined) throw new UsageError("--machine is required")
  if (census && machine !== "mesh-pair") throw new UsageError("--census is for mesh-pair")
  if (dedup && machine !== "mesh-pair") throw new UsageError("--dedup is for mesh-pair")
  if (resume !== undefined && (!dedup || machine !== "mesh-pair")) throw new UsageError("--resume requires --dedup and --machine mesh-pair")
  if (forceResume && resume === undefined) throw new UsageError("--force-resume needs --resume")
  if (legacyDfs && (!dedup || machine !== "mesh-pair")) throw new UsageError("--legacy-dfs requires --machine mesh-pair --dedup")
  if (resume !== undefined && out !== undefined && out !== resume) throw new UsageError("--resume and --out must name the same directory")
  if (livenessBoundS !== undefined && !liveness) throw new UsageError("--liveness-bound-s needs --liveness or --liveness-every")
  if ((liveness || heartbeat === false) && machine !== "mesh-pair") throw new UsageError("--liveness, --liveness-every and --no-heartbeat are for mesh-pair")
  if (machine === "mesh-pair" && dedup && !legacyDfs) {
    const unsupported = [
      ...(liveness ? ["--liveness/--liveness-every"] : []),
      ...(sample !== undefined ? ["--sample"] : []),
      ...(census ? ["--census"] : []),
      ...(budgetMinExplicit ? ["--budget-min"] : []),
      ...(dedupCheck ? ["--dedup-check"] : []),
    ]
    if (unsupported.length > 0) {
      throw new UsageError(`${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} not supported by the checkpointable tiled mesh-pair explorer; pass --legacy-dfs explicitly to request that analysis`)
    }
  }
  if (anchor !== undefined && machine !== "peer-actor" && machine !== "mesh-pair") throw new UsageError("--anchor is for peer-actor and mesh-pair")
  if (anchor !== undefined && machine === "mesh-pair") {
    if (scenario !== undefined && anchor !== "all") throw new UsageError("mesh-pair: pass --anchor all, or --scenario <anchor>")
    if (anchor !== "all") {
      scenario = anchor
      anchor = undefined
    }
  }
  return {
    machine,
    depth,
    faults,
    seed,
    replay,
    scenario,
    horizonS,
    sample,
    budgetMin,
    maxStates,
    hash,
    candidates,
    fairDepth,
    anchor,
    selfTest: selfTest ?? machine === "mesh-pair",
    emitTest,
    out: resume ?? out ?? outputDir(machine),
    workers,
    heapGb,
    census,
    dedup,
    ...(dedup && legacyDfs ? { dedupCheck: dedupCheck ?? { oneIn: 100 } } : {}),
    ...(liveness ? { liveness: { ...liveness, ...(livenessBoundS === undefined ? {} : { boundS: livenessBoundS }) } } : {}),
    ...(heartbeat === false ? { heartbeat } : {}),
    ...(resume === undefined ? {} : { resume }),
    forceResume,
    legacyDfs,
  }
}

export function vitestCommand(args: ExploreArgs): {
  env: Record<string, string>
  argv: string[]
} {
  return {
    env: { EXPLORE_ARGS: JSON.stringify(args) },
    argv: [
      "vitest",
      "run",
      "--config",
      "vitest.explore.config.ts",
      "lib/explorer/run.explore.ts",
    ],
  }
}

/** `--replay`: one vitest process on replay.explore.ts, which writes <out>/replay.json */
export function replayCommand(args: ExploreArgs): {
  env: Record<string, string>
  argv: string[]
} {
  return {
    env: { EXPLORE_ARGS: JSON.stringify(args) },
    argv: ["vitest", "run", "--config", "vitest.explore.config.ts", "lib/explorer/replay.explore.ts"],
  }
}

/** the machines whose runs are the tree search, and so can be sharded; report-outbox and report-retry search in one process */
const SHARDED = new Set<MachineName>(["mesh-pair"])

/** One vitest process per worker, each with its shard of the tree in
 * EXPLORE_ARGS and its own output directory under args.out. The mutant
 * self-test runs once, in shard 0. peer-actor (its own BFS), self and sweeps
 * run as a single process. */
export function shardPlan(args: ExploreArgs): {
  env: Record<string, string>
  argv: string[]
}[] {
  if (args.workers <= 1 || !SHARDED.has(args.machine)) {
    return [vitestCommand(args)]
  }
  return Array.from({ length: args.workers }, (_, index) =>
    vitestCommand({
      ...args,
      shard: { index, of: args.workers, depth: 2 },
      out: `${args.out}/shard-${index}`,
      selfTest: index === 0 && args.selfTest,
    }),
  )
}

/** Adds shard reports up: leaves, cuts and details add per depth, a level
 * takes its slowest shard's time, closedAtDepth is the minimum, the run is
 * inconclusive if any shard is, and findings keep one shortest witness per
 * property and detail (as one search would). */
export function mergeReports(parts: readonly SearchResult[]): SearchResult {
  if (parts.length === 0) throw new RangeError("mergeReports needs a part")
  const byDepth = new Map<number, SearchLevel[]>()
  for (const part of parts) {
    for (const level of part.levels) {
      byDepth.set(level.depth, [...(byDepth.get(level.depth) ?? []), level])
    }
  }
  const levels = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((depth): SearchLevel => {
      const shards = byDepth.get(depth) ?? []
      const cuts: Record<Cut, number> = {
        depth: 0,
        faults: 0,
        horizon: 0,
        quiet: 0,
        seen: 0,
        harness: 0,
      }
      const details: Record<string, number> = {}
      let leaves = 0
      let nodes = 0
      let enabledTotal = 0
      let elapsedMs = 0
      let expanded = 0
      let seen = 0
      let dedupEntries = 0
      let dedupBytes = 0
      let hasDedupTable = false
      let hasDedup = false
      const censusKeys = new Set<string>()
      const censusPaths = new Map<string, Label[][]>()
      let hasCensus = false
      for (const level of shards) {
        leaves += level.leaves
        for (const cut of Object.keys(cuts) as Cut[]) cuts[cut] += level.cuts[cut] ?? 0
        for (const [detail, count] of Object.entries(level.details)) {
          details[detail] = (details[detail] ?? 0) + count
        }
        const weight = level.nodes ?? 1
        nodes += weight
        enabledTotal += level.meanEnabled * weight
        elapsedMs = Math.max(elapsedMs, level.elapsedMs)
        if (level.expanded !== undefined || level.seen !== undefined) {
          hasDedup = true
          expanded += level.expanded ?? 0
          seen += level.seen ?? 0
        }
        if (level.dedupEntries !== undefined || level.dedupBytes !== undefined) {
          hasDedupTable = true
          dedupEntries += level.dedupEntries ?? 0
          dedupBytes += level.dedupBytes ?? 0
        }
        if (level.census) {
          hasCensus = true
          for (const key of level._censusKeys ?? []) censusKeys.add(key)
          for (const entry of level._censusPaths ?? []) {
            const paths = censusPaths.get(entry.key) ?? []
            for (const path of entry.paths) {
              if (paths.length >= 2) break
              if (!paths.some((held) => held.join("\0") === path.join("\0"))) paths.push([...path])
            }
            censusPaths.set(entry.key, paths)
          }
        }
      }
      const distinctFingerprints = censusKeys.size
      return {
        depth,
        leaves,
        meanEnabled: nodes === 0 ? 0 : enabledTotal / nodes,
        cuts,
        details,
        elapsedMs,
        nodes,
        ...(hasDedup ? { expanded, seen } : {}),
        ...(hasDedupTable ? { dedupEntries, dedupBytes } : {}),
        ...(hasCensus ? {
          census: {
            depthLeaves: cuts.depth,
            distinctFingerprints,
            ratio: distinctFingerprints === 0 ? 0 : cuts.depth / distinctFingerprints,
          },
          _censusKeys: [...censusKeys].sort(),
          _censusPaths: [...censusPaths].map(([key, paths]) => ({ key, paths })).sort((a, b) => a.key.localeCompare(b.key)),
        } : {}),
      }
    })

  const findings: Finding[] = []
  for (const finding of parts.flatMap((part) => part.findings)) {
    const existing = findings.findIndex(
      (candidate) =>
        candidate.property === finding.property &&
        candidate.detail === finding.detail &&
        candidate.sampled === finding.sampled,
    )
    if (existing === -1) findings.push(finding)
    else if (findings[existing].labels.length > finding.labels.length) {
      findings[existing] = finding
    }
  }

  const frontierClosed = parts.every((part) => part.frontierClosed === true)
  return {
    levels,
    closedAtDepth: Math.min(...parts.map((part) => part.closedAtDepth)),
    inconclusive: parts.some((part) => part.inconclusive),
    findings,
    ...(frontierClosed ? { frontierClosed } : {}),
  }
}

/** The vitest worker's real heap limit (v8 heap_size_limit) against the heap
 * the run asked for: a NODE_OPTIONS that did not reach the worker fails the
 * run at its start, not hours later as an out-of-memory crash. */
export function heapCheck(
  limitBytes: number,
  heapGb: number | undefined,
): { ok: boolean; line: string } {
  const have = `heap limit ${(limitBytes / 1024 ** 3).toFixed(2)} GiB`
  if (heapGb === undefined) return { ok: true, line: have }
  return {
    ok: limitBytes >= heapGb * 1024 ** 3,
    line: `${have} (wanted >= ${heapGb} GiB)`,
  }
}

export function exitCode(outcome: {
  violations: number
  mutantMissed: boolean
  harnessError: boolean
  inconclusive: boolean
  replay?: "reproduced" | "different-violation" | "not-reproduced" | "out-of-date"
}): 0 | 1 | 2 | 3 | 4 {
  if (outcome.harnessError || outcome.replay === "out-of-date") return 4
  if (outcome.violations > 0 || outcome.replay === "reproduced" || outcome.replay === "different-violation") return 1
  if (outcome.mutantMissed) return 2
  if (outcome.inconclusive) return 3
  return 0
}
