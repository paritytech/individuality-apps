// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps the real timers before anything else loads
import { realMs } from "./mesh/quiescence"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { getHeapStatistics } from "node:v8"
import { describe, expect, it, onTestFailed } from "vitest"
import { exitCode, heapCheck, leafChecks, type ExploreArgs } from "./core/cli"
import { writeReport, type KnownGapSeen } from "./core/report"
import { formatMeshProgress, meshProgressRecord } from "./core/progress"
import { silenceConsoleLog } from "./core/quiet-console"
import { search, type Finding, type SearchResult, type SearchRoom } from "./core/search"
import { witnessFromFinding, writeWitness } from "./core/witness"
import { exploreRoom, type Room } from "./mesh/room"
import { SCENARIOS } from "./mesh/scenarios"
import { selfTest, selfTestPassed, selfTestTable, type MutantResult } from "./mutants/self-test"
import { formatLayerProgress, runAnchorCandidates, runPeerActor, runPeerCandidates, type PeerActorCheckpoint, type PeerActorOptions, type PeerCandidatesRun } from "./actor/run"
import { anchorNames } from "./actor/anchors"
import { isMeshAnchor, MESH_ANCHORS, readMeshAnchor } from "./mesh/anchors"
import { isFault, type Label } from "./core/labels"
import type { ScenarioName } from "./mesh/room"
import { exploreMachine } from "./machines/explore-machine"
import { MACHINES } from "./machines/registry"
import { livenessSummary, newTally, recordLeaf } from "./mesh/liveness-stats"
import { monitorsFor, type Monitor } from "./mesh/monitors"

export { leafChecks } from "./core/cli"

/** an adapter's unreached cells for the report: their count, or its words when the adapter cannot list them (D2) */
export const unreachedCells = (cells: readonly string[] | string): number | string => (typeof cells === "string" ? cells : cells.length)

export function dedupRefusal(dedup: boolean, monitors: readonly Monitor[]): string | undefined {
  if (!dedup) return undefined
  const open = monitors.find((monitor) => !monitor.closed)
  return open === undefined
    ? undefined
    : `--dedup requires trace-closed monitors; active ${open.id} is not trace-closed`
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function dedupGapState(
  dedup: boolean,
  room: Pick<SearchRoom, "fingerprint">,
): { state?: string; harnessDetail?: string } {
  if (!dedup) return {}
  try {
    const fingerprint = room.fingerprint?.()
    if (fingerprint === undefined) throw new Error("room has no fingerprint")
    // the "on:" prefix is kept: saved reports' known-gap stateKeys carry it, and shards merge by key
    return { state: `on:${fingerprint}` }
  } catch (error) {
    return { harnessDetail: `dedup gap fingerprint: ${errorMessage(error)}` }
  }
}

/**
 * The room's fingerprint, computed once per room state: a leaf that meets a
 * known gap under --dedup needs its fingerprint for the gap's state key, and
 * when the search has just fingerprinted the same node (a seen cut, or the
 * census and dedup on one node) the walk is not repeated. Every call that can
 * change the room goes through `changing`, which drops the memo before and
 * after it. EXPLORER_VERIFY_FINGERPRINT_MEMO=1 recomputes each memo hit and
 * throws on a difference.
 */
export function memoizedFingerprint(room: Pick<Room, "fingerprint">, verify = process.env.EXPLORER_VERIFY_FINGERPRINT_MEMO === "1"): {
  fingerprint: () => string
  changing: <T>(run: () => Promise<T>) => Promise<T>
} {
  let epoch = 0
  let memo: { epoch: number; value: string } | undefined
  return {
    fingerprint: () => {
      if (memo?.epoch === epoch) {
        if (verify && room.fingerprint() !== memo.value) throw new Error("fingerprint memo: the room changed without a step")
        return memo.value
      }
      const value = room.fingerprint()
      memo = { epoch, value }
      return value
    },
    changing: async (run) => {
      epoch++
      try {
        return await run()
      } finally {
        epoch++
      }
    },
  }
}

const rootDir = resolve(import.meta.dirname, "../../../..")

const parsedArgs = (): ExploreArgs | undefined => {
  const raw = process.env.EXPLORE_ARGS
  return raw === undefined ? undefined : (JSON.parse(raw) as ExploreArgs)
}

/** the peer-actor search's own numbers, for the report's source */
let peerActorSummary: Record<string, unknown> | undefined
/** phase B's candidates, with --candidates */
let peerCandidates: PeerCandidatesRun | undefined
/** a registry machine's own numbers, for the report's source */
let machineSummary: Record<string, unknown> | undefined

const progressLog = (out: string): string => resolve(out, "progress.log")
const progressCheckpoint = (out: string): string => resolve(out, "progress.json")

function preparePeerActorProgress(out: string): void {
  mkdirSync(out, { recursive: true })
  writeFileSync(progressLog(out), "")
  rmSync(progressCheckpoint(out), { force: true })
  rmSync(`${progressCheckpoint(out)}.tmp`, { force: true })
}

function recordedPeerActor(out: string, options: Omit<PeerActorOptions, "onLayer">) {
  return runPeerActor({
    ...options,
    onLayer: (layer) => {
      const line = formatLayerProgress(layer)
      const checkpoint: PeerActorCheckpoint = { options, layer }
      const temporary = `${progressCheckpoint(out)}.tmp`
      writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`)
      renameSync(temporary, progressCheckpoint(out))
      appendFileSync(progressLog(out), `${line}\n`)
      writeSync(1, `${line}\n`)
    },
  })
}

/** Known gaps counted in schedules: each leaf's gaps (in the search's leaf
 *  order, null for none) are assigned to their level by the levels' leaf
 *  counts, and only the deepest level's leaves count. Those are the search's
 *  distinct schedules; a shallower level's leaves are their prefixes, which
 *  iterative deepening replays again. */
export function gapLeavesAtDeepest(perLeaf: readonly (readonly string[] | null)[], levels: readonly { leaves: number }[], distinctStates = false): Map<string, number> {
  if (distinctStates) {
    return new Map([...gapStateKeysAtDeepest(perLeaf, levels)].map(([key, states]) => [key, states.length]))
  }
  const counts = new Map<string, number>()
  if (levels.length === 0) return counts
  const before = levels.slice(0, -1).reduce((sum, level) => sum + level.leaves, 0)
  const deepest = perLeaf.slice(before, before + levels[levels.length - 1]!.leaves)
  for (const key of deepest.flatMap((keys) => [...new Set(keys ?? [])])) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

/** The deepest level's fingerprint identities for each known gap. */
export function gapStateKeysAtDeepest(perLeaf: readonly (readonly string[] | null)[], levels: readonly { leaves: number }[]): Map<string, string[]> {
  const states = new Map<string, Set<string>>()
  if (levels.length === 0) return new Map()
  const before = levels.slice(0, -1).reduce((sum, level) => sum + level.leaves, 0)
  const deepest = perLeaf.slice(before, before + levels[levels.length - 1]!.leaves)
  for (const entry of new Set(deepest.flatMap((keys) => keys ?? []))) {
    const separator = entry.indexOf("\0state=")
    if (separator < 0) continue
    const key = entry.slice(0, separator)
    const state = entry.slice(separator + "\0state=".length)
    const found = states.get(key) ?? new Set<string>()
    found.add(state)
    states.set(key, found)
  }
  return new Map([...states].map(([key, found]) => [key, [...found]]))
}

/** mesh-pair's own numbers, for the report's source */
let meshPairSummary: Record<string, unknown> | undefined
/** the known gaps (known-gaps.ts) the mesh-pair search met, with their issues */
let meshPairGaps: KnownGapSeen[] = []

const MESH_PAIR_PHASE_OFFSET_MS = 1000 as const

/** the faults a warmup spends: the room gets them on top of F, so F counts faults past the anchor */
export const warmupFaults = (warmup: readonly Label[]): number => warmup.filter(isFault).length

/** A mesh-pair `--scenario`: a scenario (with its `from` anchor's warmup, if it names one), or a mesh anchor (mesh/anchors.ts), which is its base scenario plus a warmup. */
export function meshScenario(name: string): { scenario: ScenarioName; warmup: Label[]; anchor?: string } {
  if (isMeshAnchor(name)) return { scenario: MESH_ANCHORS[name].scenario, warmup: readMeshAnchor(name).warmup, anchor: name }
  if (!Object.hasOwn(SCENARIOS, name)) throw new Error(`unknown mesh-pair scenario: ${name} (have ${[...Object.keys(SCENARIOS), ...Object.keys(MESH_ANCHORS)].join(", ")})`)
  // a scenario that starts from an anchor replays that anchor's warmup under itself
  const from = SCENARIOS[name as ScenarioName].from
  return { scenario: name as ScenarioName, warmup: from ? readMeshAnchor(from).warmup : [] }
}

/**
 * mesh-pair: the stateless iterative-deepening search over the two-phone
 * room, sharded over depth-two label pairs by `shard`, with the room's leaf
 * checks, over the one tree there is: the peer actor driving both Meshes.
 * Every finding gets a witness in <out>/witnesses. A difference a monitor
 * matched to known-gaps.ts is not a violation: it is counted per schedule and
 * reported with its issue.
 */
async function meshPairResult(args: ExploreArgs, depth: number, faults: number, horizonMs: number, out: string): Promise<SearchResult> {
  const { scenario, warmup, anchor } = meshScenario(args.scenario ?? "rejoin-two-offers")
  const warm = warmup.length
  const gaps = new Map<string, KnownGapSeen>()
  const witnesses: string[] = []
  const activeMonitors = monitorsFor(1)
  const refusal = dedupRefusal(args.dedup, activeMonitors)
  if (refusal !== undefined) throw new Error(refusal)
  const heartbeat = args.heartbeat !== false
  const room = await exploreRoom({ scenario, phaseOffsetMs: MESH_PAIR_PHASE_OFFSET_MS, faults: faults + warmupFaults(warmup), horizonMs, monitors: activeMonitors, heartbeat })
  try {
    // an anchor's warmup replays after every reset (as the self-test's
    // does); the search's steps and a violation's step count past it, and
    // a violation inside the warmup is reported at step 0
    const fingerprints = memoizedFingerprint(room)
    const searched: SearchRoom & Pick<Room, "checkLeaf" | "checkLiveness"> = {
      enabled: () => room.enabled(),
      step: (label) => fingerprints.changing(() => room.step(label)),
      reset: () => fingerprints.changing(async () => {
        await room.reset()
        for (const label of warmup) await room.step(label)
      }),
      violations: () => room.violations().map((violation) => ({ ...violation, atStep: Math.max(0, violation.atStep - warm) })),
      faultsLeft: () => room.faultsLeft(),
      horizonReached: () => room.horizonReached(),
      fingerprint: fingerprints.fingerprint,
      collisionState: () => room.collisionState(),
      collisionDrain: () => fingerprints.changing(() => room.collisionDrain()),
      checkLeaf: () => fingerprints.changing(() => room.checkLeaf()),
      checkLiveness: (withinMs) => fingerprints.changing(() => room.checkLiveness(withinMs)),
    }
    // L1 (--liveness): every `every`-th depth, horizon or quiet leaf of the
    // deepest level, after the leaf check. A shallower level's leaves are
    // prefixes of the deepest's, or its own horizon and quiet leaves again
    // (iterative deepening), so judging them too only repeats work.
    let level = 1
    const liveness = { ...newTally(args.liveness?.every ?? 0), eligible: 0 }
    const livenessFindings: Finding[] = []
    // the known gaps each leaf met, in the search's leaf order (read before
    // the leaf check, whose fair drain steps the room on)
    const leafGaps: (string[] | null)[] = []
    const gapByKey = new Map<string, { property: string; issue: number; detail: string }>()
    const checks = leafChecks(args.seed ?? 0)
    const result = await search(async () => searched, {
      depth,
      budgetMs: args.budgetMin * 60_000,
      async onLeaf(leaf) {
        const met = room.gaps()
        const live = liveness.every > 0 && level === depth && (leaf.cut === "depth" || leaf.cut === "horizon" || leaf.cut === "quiet") && liveness.eligible++ % liveness.every === 0
        // the leaf's own state key: L1's drain steps the room on
        const gapState = met.length > 0 || live
          ? dedupGapState(args.dedup, searched)
          : {}
        const state = gapState.state
        const keyOf = (gap: { property: string; issue?: number; detail: string }) => {
          const key = `${gap.property}|${gap.issue}|${gap.detail}`
          gapByKey.set(key, { property: gap.property, issue: gap.issue!, detail: gap.detail })
          return state === undefined ? key : `${key}\0state=${state}`
        }
        const keys = met.map(keyOf)
        await checks.onLeaf(leaf, gapState.harnessDetail)
        if (live && gapState.harnessDetail === undefined) {
          const started = realMs()
          try {
            const result = await searched.checkLiveness()
            const late = recordLeaf(liveness, result, leaf.labels, args.liveness?.boundS)
            if (late) pushLivenessFinding(livenessFindings, late)
            const violation = result.violation
            if (violation?.issue !== undefined) keys.push(keyOf(violation))
            else if (violation) {
              pushLivenessFinding(livenessFindings, { property: "L1", labels: [...leaf.labels], atStep: leaf.labels.length - 1, detail: violation.detail, sampled: false, evidence: violation.evidence })
            }
          } catch {
            // a drain the harness cut proves nothing either way
            liveness.harness++
          }
          const spent = realMs() - started
          liveness.realMs += spent
          liveness.maxRealMs = Math.max(liveness.maxRealMs, spent)
        }
        leafGaps.push(keys.length === 0 ? null : keys)
      },
      shard: args.shard,
      census: args.census,
      ...(args.dedup ? { dedup: { check: args.dedupCheck } } : {}),
      now: realMs,
      // one line per finished depth, to this worker's stdout (inherited from the run) and to the run's progress.jsonl
      onLevel: (finished, { findings }) => {
        level = finished.depth + 1
        const record = meshProgressRecord({ scenario, ...(anchor ? { anchor } : {}), shard: args.shard ? { index: args.shard.index, of: args.shard.of } : null, bounds: { depth, faults, horizonMs } }, finished, findings)
        const root = args.shard ? dirname(resolve(isAbsolute(args.out) ? args.out : resolve(rootDir, args.out))) : isAbsolute(args.out) ? args.out : resolve(rootDir, args.out)
        mkdirSync(root, { recursive: true })
        appendFileSync(resolve(root, "progress.jsonl"), `${JSON.stringify(record)}\n`)
        writeSync(1, `${formatMeshProgress(record)}\n`)
      },
      ...(args.sample ? { sample: { count: args.sample, seed: args.seed ?? 0 } } : {}),
    })
    const stateKeys = args.dedup ? gapStateKeysAtDeepest(leafGaps, result.levels) : new Map<string, string[]>()
    for (const [key, count] of gapLeavesAtDeepest(leafGaps, result.levels, args.dedup)) {
      const entry = gaps.get(key) ?? { ...gapByKey.get(key)!, schedules: 0 }
      if (args.dedup) {
        entry.stateKeys = [...new Set([...(entry.stateKeys ?? []), ...(stateKeys.get(key) ?? [])])]
        entry.schedules = entry.stateKeys.length
      } else {
        entry.schedules += count
      }
      gaps.set(key, entry)
    }
    const closedBySearch = result.closedAtDepth
    checks.merge(result)
    result.findings.push(...livenessFindings)
    // an L1 drain the harness cut is a harness failure of the run, so the exit and report show it
    const deepest = result.levels.at(-1)
    if (deepest && liveness.harness > 0) deepest.cuts.harness = (deepest.cuts.harness ?? 0) + liveness.harness
    // merge recounts closedAtDepth from the levels, a partial last level included
    result.closedAtDepth = Math.min(result.closedAtDepth, closedBySearch)
    const slugs = new Map<string, number>()
    for (const finding of result.findings) {
      // the witness replays from the base scenario's start: the warmup, then the schedule
      const witness = await witnessFromFinding(
        "mesh-pair",
        { name: scenario, phaseOffsetMs: MESH_PAIR_PHASE_OFFSET_MS, faults: faults + warmupFaults(warmup), horizonMs, slice: 1, mutant: null, ...(anchor ? { anchor } : {}), ...(heartbeat ? {} : { heartbeat: false }) },
        { ...finding, labels: [...warmup, ...finding.labels], atStep: finding.atStep + warm },
      )
      if (anchor) finding.detail = `[anchor ${anchor}] ${finding.detail}`
      // L1 findings share a length (they are leaves): number the second and later of a slug
      const slug = `${finding.property}-${finding.labels.length}`
      const seen = slugs.get(slug) ?? 0
      slugs.set(slug, seen + 1)
      witnesses.push(await writeWitness(out, witness, seen === 0 ? slug : `${slug}-${seen + 1}`))
    }
    meshPairGaps = [...gaps.values()]
    const steps = result.levels.reduce((sum, level) => sum + level.leaves * level.depth, 0)
    const ms = result.levels.reduce((sum, level) => sum + level.elapsedMs, 0)
    meshPairSummary = {
      scenario,
      ...(anchor ? { anchor } : {}),
      ...(warm > 0 ? { warmupLength: warm } : {}),
      phaseOffsetMs: MESH_PAIR_PHASE_OFFSET_MS,
      witnesses,
      // a leaf at depth d replays d steps from a reset (stateless DFS); an upper
      // bound on steps, so schedules per second is the honest throughput figure
      schedulesPerSecond: ms === 0 ? 0 : (result.levels.reduce((sum, level) => sum + level.leaves, 0) / ms) * 1000,
      stepsPerSecondUpperBound: ms === 0 ? 0 : (steps / ms) * 1000,
      ...(args.shard ? { shard: args.shard } : {}),
      dedup: args.dedup,
      ...(args.dedupCheck ? { dedupCheck: `1/${args.dedupCheck.oneIn}` } : {}),
      ...(heartbeat ? {} : { heartbeat: false }),
      ...(liveness.every > 0 ? { liveness: livenessSummary(liveness) } : {}),
    }
    if (liveness.every > 0) writeSync(1, `mesh-pair L1${args.shard ? ` shard=${args.shard.index}/${args.shard.of}` : ""} ${JSON.stringify(livenessSummary(liveness))}\n`)
    return result
  } finally {
    room.close()
  }
}

/** one L1 finding per detail, the shortest witness */
function pushLivenessFinding(findings: Finding[], finding: Finding) {
  const existing = findings.findIndex((candidate) => candidate.detail === finding.detail)
  if (existing === -1) findings.push(finding)
  else if (findings[existing]!.labels.length > finding.labels.length) findings[existing] = finding
}

/** The mutant self-test before every mesh-pair run: shard 0 only. */
async function meshPairSelfTest(out: string, dedup: boolean): Promise<{ results: MutantResult[]; passed: boolean }> {
  // the mutants' witnesses go apart from the run's own findings
  const results = await selfTest("mesh-pair", undefined, { out: resolve(out, "self-test"), dedup })
  writeSync(2, `explorer self-test:\n${selfTestTable(results)}\n`)
  for (const result of results) if (result.refresh) writeSync(2, `refresh mutant ${result.id}\n`)
  return { results, passed: selfTestPassed(results) }
}

/** A registry machine (lib/explorer/machines), searched by exploreMachine in one process. Shards past the first add an
 * empty, closed part, so the merged report is the first shard's search. A state cap is inconclusive; a violation is a
 * finding. */
const machineResult = (args: ExploreArgs, depth: number): SearchResult | undefined => {
  const adapter = Object.hasOwn(MACHINES, args.machine) ? MACHINES[args.machine] : undefined
  if (adapter === undefined) return undefined
  if (args.shard !== undefined && args.shard.index > 0) {
    machineSummary = { shard: args.shard.index, searched: false }
    return { levels: [], closedAtDepth: depth, inconclusive: false, frontierClosed: true, findings: [] }
  }
  const maxStates = args.maxStates ?? 2_000_000
  const started = Date.now()
  const report = exploreMachine(adapter, { depth, maxStates })
  const capped = !report.frontierClosed && report.depthCompleted < depth
  const closedAtDepth = report.frontierClosed ? depth : report.depthCompleted
  machineSummary = {
    states: report.states,
    edges: report.edges,
    depthCompleted: report.depthCompleted,
    frontierClosed: report.frontierClosed,
    capped,
    maxStates,
    unreachedCells: unreachedCells(report.unreachedCells),
    excluded: report.excluded,
  }
  return {
    levels: [{
      depth: closedAtDepth,
      leaves: report.states,
      meanEnabled: report.states === 0 ? 0 : report.edges / report.states,
      cuts: { depth: 0, faults: 0, horizon: 0, quiet: 0, seen: 0, harness: 0 },
      details: capped ? { [`state cap ${maxStates}`]: 1 } : {},
      elapsedMs: Date.now() - started,
    }],
    closedAtDepth,
    inconclusive: capped,
    frontierClosed: report.frontierClosed,
    findings: report.violations.map((violation) => ({
      property: violation.message,
      labels: violation.trace,
      atStep: violation.trace.length - 1,
      detail: violation.message,
      sampled: false,
    })),
  }
}

const resultFor = async (args: ExploreArgs, out: string): Promise<SearchResult> => {
  if (args.machine === "mesh-pair") {
    const scenario = SCENARIOS[meshScenario(args.scenario ?? "rejoin-two-offers").scenario]
    return meshPairResult(args, args.depth ?? scenario.defaults.depth, args.faults ?? scenario.defaults.faults, (args.horizonS ?? scenario.defaults.horizonMs / 1000) * 1000, out)
  }
  const depth = args.depth ?? 1
  if (args.machine === "peer-actor" && args.anchor !== undefined) {
    const anchors = anchorNames(args.anchor)
    if (args.candidates) {
      peerCandidates = runAnchorCandidates({ anchors, depth, faults: args.faults ?? 1, maxStates: args.maxStates ?? 2_000_000 })
      peerActorSummary = { ...peerCandidates.run.summary, anchors, candidates: peerCandidates.list.length, candidateBounds: peerCandidates.bounds }
      return peerCandidates.run.result
    }
    // explore.mts runs one process per anchor; a list reaching here is a usage slip
    if (anchors.length !== 1) throw new Error(`one process searches one anchor (got ${anchors.join(", ")}): run it through npm run explore`)
    const run = recordedPeerActor(out, { depth, faults: args.faults ?? 1, maxStates: args.maxStates ?? 2_000_000, hash: args.hash ?? true, anchor: anchors[0] })
    peerActorSummary = run.summary
    return run.result
  }
  if (args.machine === "peer-actor" && args.candidates) {
    peerCandidates = runPeerCandidates({ depth, fairDepth: args.fairDepth ?? 3, faults: args.faults ?? 1, maxStates: args.maxStates ?? 2_000_000 })
    peerActorSummary = { ...peerCandidates.run.summary, candidates: peerCandidates.list.length, candidateBounds: peerCandidates.bounds }
    return peerCandidates.run.result
  }
  if (args.machine === "peer-actor") {
    const run = recordedPeerActor(out, { depth, faults: args.faults ?? 1, maxStates: args.maxStates ?? 2_000_000, hash: args.hash ?? true })
    peerActorSummary = run.summary
    return run.result
  }
  if (args.machine === "self") {
    if (args.budgetMin === 0) {
      return {
        levels: [],
        closedAtDepth: 0,
        inconclusive: true,
        findings: [],
      }
    }
    return {
      levels: [
        {
          depth,
          leaves: 1,
          meanEnabled: 0,
          cuts: {
            depth: 0,
            faults: 0,
            horizon: 0,
            quiet: 1,
            seen: 0,
            harness: 0,
          },
          details: {},
          elapsedMs: 0,
        },
      ],
      closedAtDepth: depth,
      inconclusive: false,
      findings: [],
    }
  }

  const registered = machineResult(args, depth)
  if (registered !== undefined) return registered

  const detail = `machine adapter not available yet: ${args.machine}`
  return {
    levels: [
      {
        depth,
        leaves: 1,
        meanEnabled: 0,
        cuts: {
          depth: 0,
          faults: 0,
          horizon: 0,
          quiet: 0,
          seen: 0,
          harness: 1,
        },
        details: { [detail]: 1 },
        elapsedMs: 0,
      },
    ],
    closedAtDepth: 0,
    inconclusive: true,
    findings: [],
  }
}

const args = parsedArgs()

if (args === undefined) {
  describe.skip("explorer run", () => {
    it("requires EXPLORE_ARGS", () => undefined)
  })
} else {
  describe("explorer run", () => {
    it(`dispatches ${args.machine}`, async () => {
      const active = args
      // this worker's real heap, before any search: NODE_OPTIONS that did not
      // reach it fails here, not as an out-of-memory crash hours in
      const heap = heapCheck(getHeapStatistics().heap_size_limit, active.heapGb)
      writeSync(2, `explorer worker ${active.shard ? `shard ${active.shard.index}/${active.shard.of} ` : ""}${heap.line}\n`)
      if (!heap.ok) throw new Error(`explorer worker ${heap.line}: set NODE_OPTIONS=--max-old-space-size`)
      const out = isAbsolute(active.out)
        ? active.out
        : resolve(rootDir, active.out)
      if (active.machine === "peer-actor" && !active.candidates) {
        preparePeerActorProgress(out)
        const timeoutMarker = resolve(out, "vitest-timeout")
        rmSync(timeoutMarker, { force: true })
        onTestFailed(({ task }) => {
          if (task.result?.errors?.some((error) => error.message.includes("Test timed out"))) writeFileSync(timeoutMarker, "")
        })
      }
      const meshDefaults = active.machine === "mesh-pair" ? SCENARIOS[meshScenario(active.scenario ?? "rejoin-two-offers").scenario] : undefined
      const restoreConsole = active.machine === "mesh-pair" ? silenceConsoleLog() : () => undefined
      let selfTested: Awaited<ReturnType<typeof meshPairSelfTest>> | undefined
      let result: SearchResult
      try {
        // the self-test runs first: a blind explorer's clean tree means nothing
        selfTested = active.machine === "mesh-pair" && active.selfTest ? await meshPairSelfTest(out, active.dedup) : undefined
        result = await resultFor(active, out)
      } finally {
        restoreConsole()
      }
      const bounds = {
        depth: active.depth ?? meshDefaults?.defaults.depth ?? 1,
        faults: active.faults ?? meshDefaults?.defaults.faults ?? (active.machine === "peer-actor" ? 1 : 0),
        horizonMs: active.horizonS !== undefined ? active.horizonS * 1_000 : (meshDefaults?.defaults.horizonMs ?? 0),
        ...(active.dedup ? { dedup: true } : {}),
      }
      await writeReport(out, active.machine, result, {
        bounds,
        scenario:
          active.machine === "mesh-pair"
            ? { name: active.scenario ?? "rejoin-two-offers", phaseOffsetMs: MESH_PAIR_PHASE_OFFSET_MS }
            : active.anchor !== undefined
              ? { name: `anchor ${active.anchor}` }
              : active.scenario === undefined
                ? undefined
                : { name: active.scenario },
        source: active.machine === "peer-actor"
          ? { kind: "peer-actor-bfs", ...peerActorSummary }
          : machineSummary !== undefined
            ? { kind: "machine-adapter-bfs", ...machineSummary }
            : meshPairSummary !== undefined
              ? { kind: "mesh-pair-dfs", ...meshPairSummary }
              : { kind: `${active.machine}-stub`, seed: active.seed ?? 0 },
        ...(active.machine === "mesh-pair" ? { knownGaps: meshPairGaps } : {}),
        ...(active.machine === "mesh-pair" && active.shard ? { censusKeys: true } : {}),
      })
      if (peerCandidates) {
        await writeFile(resolve(out, "candidates.md"), peerCandidates.markdown)
        await writeFile(resolve(out, "candidates.json"), `${JSON.stringify({ bounds: peerCandidates.bounds, candidates: peerCandidates.list }, null, 2)}\n`)
      }
      await mkdir(resolve(out, "witnesses"), { recursive: true })
      // peer-actor findings as witnesses: the labels walk from the named initial world (bfs.ts walk)
      if (active.machine === "peer-actor") {
        let index = 0
        for (const finding of result.findings) {
          index += 1
          await writeFile(resolve(out, "witnesses", `peer-actor-${active.anchor ?? "start"}-${index}.json`), `${JSON.stringify({ machine: "peer-actor", anchor: active.anchor ?? null, from: peerActorSummary?.from ?? null, property: finding.property, labels: finding.labels }, null, 2)}\n`)
        }
      }
      await writeFile(
        resolve(out, "self-test.json"),
        `${JSON.stringify(
          selfTested !== undefined
            ? { requested: true, passed: selfTested.passed, dedup: active.dedup, results: selfTested.results }
            : { requested: active.selfTest, passed: active.machine === "self" },
        )}\n`,
      )

      const code = exitCode({
        violations: result.findings.length,
        mutantMissed: false,
        harnessError: result.levels.some((level) => level.cuts.harness > 0),
        inconclusive: result.inconclusive,
      })
      // the peer-actor and registry searches' exit is their own outcome, which explore.mts reads from the report
      if (active.machine !== "peer-actor" && active.machine !== "mesh-pair" && machineSummary === undefined) {
        expect(code).toBe(
          active.machine === "self" ? (active.budgetMin === 0 ? 3 : 0) : 4,
        )
      }
    })
  })
}
