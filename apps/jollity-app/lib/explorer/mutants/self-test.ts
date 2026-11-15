// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The mutant self-test: does the explorer still see the bugs it
 * was built to see? Each mutant re-introduces a fixed bug as hunks on its
 * real runtime path (mutants/<id>.json, loaded by load.ts into a gitignored
 * sibling copy behind a module reset). A gating mutant counts as FOUND only
 * when all five checks pass:
 * 1. precondition: the warmup's real enabled labels replay on the UNMUTATED
 *    room, and the named precondition (preconditions.ts) holds after them;
 * 2. hunk hit, in two parts: (2a) the violating
 *    schedule ran at least one hunk's mutated statement past the warmup, so
 *    the red came through the mutant and not an unmutated module (a late
 *    doMock gives zero hits everywhere); and (2b) every hunk's statement ran
 *    past the warmup in some schedule of the mutant's search, so no hunk is
 *    dead or stale. One violating schedule cannot run every hunk of the
 *    two-hunk mutants: M1374s's two hunks are the catch and the normal return
 *    of one effect, and M1385's P1b trips before b's answer reaches the
 *    second hunk. MutantResult.hits keeps both counts;
 * 3. fixed clean: the same labels on the unmutated code trip none of the
 *    spec's `mustTrip` properties, and neither does the same warmup-seeded
 *    search with no mutant, at the spec's bounds (the unmutated tree around
 *    the mutant's shape is searched, not only the one schedule);
 * 4. mutated red: the search, enumerating from the warmup within the spec's
 *    bounds (never replaying a stored list), finds a `mustTrip` violation;
 * 5. replay: the witness written for it replays to the same violation.
 *
 * A mutant whose `mustTrip` names L1 (eventually steady) is judged by
 * room.checkLiveness at the search's depth, horizon and quiet leaves, and
 * at the end of each replay of checks 2, 3 and 5: L1 is a leaf check, not
 * a monitor.
 *
 * The spec's `bounds.depth` is the whole schedule's length, warmup included;
 * the search explores `depth - warmup.length` labels past the warmup. The
 * witness is the first (so shortest) violating schedule that hit a hunk; the
 * search then goes on only until every hunk has run somewhere (2b), or to its
 * bounds.
 *
 * A `find` that does not occur exactly once in its target is a stale mutant:
 * the result is `refresh: true` and not found (the run exits 2 with
 * "refresh mutant <id>"). A precondition name that is not a key of
 * PRECONDITIONS is a broken spec, and throws.
 */
import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { Label } from "../core/labels"
import { search, type Leaf, type SearchRoom } from "../core/search"
import { replayWitness, witnessFromFinding, writeWitness } from "../core/witness"
import { exploreRoom, type ExploreRoomOptions, type PropertyId, type Room, type Violation } from "../mesh/room"
import { SCENARIOS } from "../mesh/scenarios"
import { realMs } from "../mesh/quiescence"
import { loadMutant, mutateText, MutantRefreshError } from "./load"
import { PRECONDITIONS } from "./preconditions"
import { loadSpec, SLICE1_MUTANTS, type MutantSpec } from "./spec"

export { PRECONDITIONS } from "./preconditions"

export interface MutantResult {
  id: string
  gating: boolean
  found: boolean
  checks: { precondition: boolean; hunkHit: boolean; fixedClean: boolean; mutatedRed: boolean; replay: boolean }
  property?: PropertyId
  /** the witness file written for the violation the search found */
  witness?: string
  /** a hunk's `find` is not exactly once in its target */
  refresh?: true
  /** the violating schedule's length, warmup included */
  depth?: number
  /** the search's leaves, over every level it ran */
  leaves?: number
  /** the search's wall time */
  elapsedMs?: number
  /** check 3's warmup-seeded search with no mutant: its leaves */
  fixedSearchLeaves?: number
  /** the replay's status (check 5) */
  replayStatus?: string
  /** hunk hits per hunk: in the witness's replay (2a) and over the whole search (2b) */
  hits?: { witness: number[]; search: number[] }
  /** what a failed check saw */
  notes: string[]
  /** what a passed check qualifies (e.g. an unmutated replay that diverges before the end) */
  info: string[]
}

export interface SelfTestOptions {
  /** where the witnesses go (`<out>/witnesses`); default test-results/explorer/self-test */
  out?: string
  /** the search's wall-time cap per mutant (default 10 minutes); a capped search that found nothing is not red */
  budgetMs?: number
  phaseOffsetMs?: ExploreRoomOptions["phaseOffsetMs"]
  /** Run both the mutated and fixed searches through visited-set dedup. */
  dedup?: boolean
}

const appRoot = fileURLToPath(new URL("../../../", import.meta.url))
const DEFAULT_OUT = `${appRoot}test-results/explorer/self-test`
const DEFAULT_BUDGET_MS = 10 * 60 * 1000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Run each mutant (default: SLICE1_MUTANTS) through the five checks. */
export async function selfTest(machine: "mesh-pair", ids: readonly string[] = SLICE1_MUTANTS, options: SelfTestOptions = {}): Promise<MutantResult[]> {
  if (machine !== "mesh-pair") throw new Error(`no mutants for machine ${String(machine)}`)
  const results: MutantResult[] = []
  for (const id of ids) results.push(await runMutant(loadSpec(id), options))
  return results
}

/** One mutant through the five checks (selfTest's body; planted specs in tests call it directly). */
export async function runMutant(spec: MutantSpec, options: SelfTestOptions = {}): Promise<MutantResult> {
  if (!Object.hasOwn(PRECONDITIONS, spec.precondition)) {
    throw new Error(`mutant ${spec.id}: unknown precondition ${spec.precondition} (preconditions.ts has ${Object.keys(PRECONDITIONS).join(", ")})`)
  }
  const precondition = PRECONDITIONS[spec.precondition]!
  const checks = { precondition: false, hunkHit: false, fixedClean: false, mutatedRed: false, replay: false }
  const result: MutantResult = { id: spec.id, gating: spec.gating, found: false, checks, notes: [], info: [] }

  try {
    mutateText(spec, readFileSync(`${appRoot}${spec.target}`, "utf8"))
  } catch (error) {
    if (!(error instanceof MutantRefreshError)) throw error
    result.refresh = true
    result.notes.push(error.message)
    return result
  }

  const scenario = SCENARIOS[spec.scenario]
  const roomOptions: ExploreRoomOptions = {
    scenario: spec.scenario,
    phaseOffsetMs: options.phaseOffsetMs ?? 1000,
    faults: spec.bounds.faults,
    horizonMs: scenario.defaults.horizonMs,
    // judged without known gaps: a gap sharing a mutant's wording must not hide the mutant
    knownGaps: false,
  }
  const mustTrip = (violation: Violation) => spec.mustTrip.includes(violation.property)

  // 1. the warmup on the unmutated room
  {
    const room = await exploreRoom(roomOptions)
    try {
      await room.replay(spec.warmup)
      checks.precondition = precondition(room)
      if (!checks.precondition) result.notes.push(`precondition ${spec.precondition} does not hold after the warmup; enabled: ${room.enabled().join(" ")}`)
    } catch (error) {
      result.notes.push(`warmup does not replay on the unmutated room: ${message(error)}`)
    } finally {
      room.close()
    }
  }

  // 4. and 2. the search under the mutant, from the warmup
  let found: Found | undefined
  const mutant = await loadMutant(spec)
  try {
    const room = await exploreRoom(roomOptions)
    try {
      const searchDepth = spec.bounds.depth - spec.warmup.length
      if (searchDepth < 1) throw new Error(`mutant ${spec.id}: bounds.depth ${spec.bounds.depth} leaves no step past its ${spec.warmup.length}-label warmup`)
      const from = await searchFromWarmup(room, spec, mustTrip, mutant.hits, searchDepth, options.budgetMs ?? DEFAULT_BUDGET_MS, options.dedup === true)
      result.leaves = from.leaves
      result.elapsedMs = from.elapsedMs
      found = from.found
      if (from.inconclusive && !from.complete) result.notes.push(`search stopped by its budget after ${from.leaves} leaves`)
      if (found) {
        checks.mutatedRed = true
        result.property = found.violation.property
        result.depth = found.labels.length
        // check 2 again, on a clean replay of the witness's labels alone, counting past the warmup
        await room.reset()
        for (const label of spec.warmup) await room.step(label)
        mutant.hits.fill(0)
        for (const label of found.labels.slice(spec.warmup.length)) await room.step(label)
        if (found.violation.property === "L1") await room.checkLiveness()
        result.hits = { witness: [...mutant.hits], search: from.searchHits }
        const witnessHit = mutant.hits.some((count) => count > 0)
        const everyHunkRan = from.searchHits.every((count) => count > 0)
        checks.hunkHit = witnessHit && everyHunkRan
        if (!witnessHit) result.notes.push(`no hunk ran in the violating schedule (hits ${JSON.stringify(mutant.hits)})`)
        if (!everyHunkRan) result.notes.push(`a hunk never ran in the search (hits ${JSON.stringify(from.searchHits)})`)
      } else {
        result.notes.push(`no ${spec.mustTrip.join("/")} violation within d = ${spec.bounds.depth}, F = ${spec.bounds.faults}`)
      }
    } finally {
      room.close()
    }
  } finally {
    await mutant.undo()
  }
  if (!found) return result

  // 3. the same labels on the unmutated code
  {
    const room = await exploreRoom(roomOptions)
    try {
      await room.reset()
      let replayed = 0
      for (const label of found.labels) {
        if (!room.enabled().includes(label) || room.violations().some(mustTrip)) break
        await room.step(label)
        replayed++
      }
      if (spec.mustTrip.includes("L1") && replayed === found.labels.length && !room.violations().some(mustTrip)) await room.checkLiveness()
      const red = room.violations().filter(mustTrip)
      checks.fixedClean = red.length === 0
      if (replayed < found.labels.length && red.length === 0) {
        result.info.push(`unmutated code diverges at step ${replayed} (${found.labels[replayed]} not enabled); clean up to there`)
      }
      if (!checks.fixedClean) result.notes.push(`unmutated code trips ${red.map((v) => `${v.property}: ${v.detail}`).join("; ")}`)
      // and the whole warmup-seeded tree, unmutated, at the same bounds
      const fixedSearch = await searchFromWarmup(room, spec, mustTrip, [], spec.bounds.depth - spec.warmup.length, options.budgetMs ?? DEFAULT_BUDGET_MS, options.dedup === true)
      result.fixedSearchLeaves = fixedSearch.leaves
      if (fixedSearch.found) {
        checks.fixedClean = false
        result.notes.push(`the unmutated warmup-seeded search trips ${fixedSearch.found.violation.property} (${fixedSearch.found.violation.detail}) at ${fixedSearch.found.labels.join(" ")}`)
      } else if (fixedSearch.inconclusive) {
        checks.fixedClean = false
        result.notes.push(`the unmutated warmup-seeded search was stopped by its budget after ${fixedSearch.leaves} leaves`)
      }
    } finally {
      room.close()
    }
  }

  // 5. the witness replays to the same violation
  const witness = await witnessFromFinding(
    "mesh-pair",
    { name: spec.scenario, phaseOffsetMs: roomOptions.phaseOffsetMs, faults: spec.bounds.faults, horizonMs: roomOptions.horizonMs, slice: 1, mutant: spec.id },
    { property: found.violation.property, labels: found.labels, atStep: found.violation.atStep, detail: found.violation.detail, sampled: false },
  )
  const out = options.out ?? DEFAULT_OUT
  await mkdir(out, { recursive: true })
  result.witness = await writeWitness(out, witness, `${spec.id}-${found.violation.property}-${found.labels.length}`)
  const replay = await replayWitness(witness, spec)
  result.replayStatus = replay.status
  checks.replay = replay.status === "reproduced"
  if (!checks.replay) result.notes.push(`witness replay: ${replay.status}`)

  result.found = Object.values(checks).every(Boolean)
  return result
}

interface Found {
  violation: Violation
  labels: Label[]
  /** some hunk ran in this schedule */
  hitAny: boolean
}

/**
 * The search from the warmup: the room is reset and the warmup replayed at
 * every schedule's start, and only `mustTrip` violations past the warmup cut
 * a schedule. The hunk counters are added to the search-wide total and
 * zeroed after each schedule's warmup, so at a violation they count that
 * schedule's steps past the warmup alone. With no hunks (`hits` empty: the
 * unmutated search of check 3) it runs to its bounds and reports the first
 * violation. The witness is the first violating schedule that ran a hunk (ID-DFS:
 * the shortest); once it exists and every hunk has run somewhere, every
 * further schedule is cut at its reset.
 */
async function searchFromWarmup(
  room: Room,
  spec: MutantSpec,
  mustTrip: (violation: Violation) => boolean,
  hits: number[],
  depth: number,
  budgetMs: number,
  dedup: boolean,
): Promise<{ found?: Found; leaves: number; elapsedMs: number; inconclusive: boolean; complete: boolean; searchHits: number[] }> {
  const warm = spec.warmup.length
  const total = hits.map(() => 0)
  const collect = () => hits.forEach((count, index) => { total[index]! += count })
  let current: Label[] = []
  let found: Found | undefined
  // with no hunks (check 3's unmutated search) the first violation ends it
  const done = () => found !== undefined && (hits.length === 0 || (found.hitAny && total.every((count) => count > 0)))
  const wrapped: SearchRoom = {
    enabled: () => room.enabled(),
    async step(label) {
      const record = await room.step(label)
      current.push(label)
      return record
    },
    async reset() {
      collect()
      if (done()) throw new Error("self-test search done")
      current = []
      await room.reset()
      for (const label of spec.warmup) await room.step(label)
      // the counters count past the warmup only
      hits.fill(0)
    },
    violations() {
      const red = room.violations().filter((violation) => mustTrip(violation) && violation.atStep >= warm)
      if (red.length > 0 && found?.hitAny !== true) {
        const hitAny = hits.some((count) => count > 0)
        if (!found || hitAny) found = { violation: red[0]!, labels: [...spec.warmup, ...current], hitAny }
      }
      return red.map((violation) => ({ ...violation, atStep: violation.atStep - warm }))
    },
    faultsLeft: () => room.faultsLeft(),
    horizonReached: () => room.horizonReached(),
    fingerprint: () => room.fingerprint(),
    collisionState: () => room.collisionState(),
    collisionDrain: () => room.collisionDrain(),
  }
  // L1 is judged at the leaves: its drain steps the room on, which the search
  // allows there (the next schedule resets)
  const onLeaf = async (leaf: Leaf) => {
    if (leaf.cut !== "depth" && leaf.cut !== "horizon" && leaf.cut !== "quiet") return
    if (found?.hitAny === true) return
    const violation = (await room.checkLiveness()).violation
    if (!violation || violation.issue !== undefined || !mustTrip(violation)) return
    const hitAny = hits.some((count) => count > 0)
    if (!found || hitAny) found = { violation, labels: [...spec.warmup, ...current], hitAny }
  }
  const started = realMs()
  const searched = await search(async () => wrapped, {
    depth,
    budgetMs,
    now: realMs,
    ...(dedup ? { dedup: {} } : {}),
    ...(spec.mustTrip.includes("L1") ? { onLeaf } : {}),
  })
  collect()
  hits.fill(0)
  return {
    found,
    leaves: searched.levels.reduce((sum, level) => sum + level.leaves, 0),
    elapsedMs: realMs() - started,
    inconclusive: searched.inconclusive,
    complete: done(),
    searchHits: total,
  }
}

/** The self-test's verdict for a run: false (exit 2, "explorer blind") when a
 *  mutant needs a refresh or a gating mutant was not found. Reported-only
 *  mutants never change it. */
export function selfTestPassed(results: readonly MutantResult[]): boolean {
  return results.every((result) => !result.refresh && (!result.gating || result.found))
}

/** one line per mutant, for the run's log and the gate post */
export function selfTestTable(results: readonly MutantResult[]): string {
  const yes = (value: boolean) => (value ? "yes" : "NO")
  const lines = ["| mutant | gating | found | property | depth | leaves | precondition | hunk hit | fixed clean (unmutated leaves) | mutated red | replay |", "|---|---|---|---|---|---|---|---|---|---|---|"]
  for (const r of results) {
    lines.push(`| ${r.id} | ${r.gating ? "yes" : "no"} | ${r.refresh ? "REFRESH" : yes(r.found)} | ${r.property ?? "-"} | ${r.depth ?? "-"} | ${r.leaves ?? "-"} | ${yes(r.checks.precondition)} | ${yes(r.checks.hunkHit)} ${r.hits ? `(witness ${r.hits.witness.join("/")}, search ${r.hits.search.join("/")})` : ""} | ${yes(r.checks.fixedClean)}${r.fixedSearchLeaves !== undefined ? ` (${r.fixedSearchLeaves})` : ""} | ${yes(r.checks.mutatedRed)} | ${yes(r.checks.replay)} |`)
  }
  return lines.join("\n")
}
