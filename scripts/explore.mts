// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The command line of the state-machine explorer (`npm run explore` from the
 * root, which runs this through `@jollity/app`'s `explore` script). It parses
 * the arguments (apps/jollity-app/lib/explorer/core/cli.ts), runs the
 * searches in child processes, merges their reports and exits with the code
 * the findings call for (`exitCode`). What the explorer checks, and its
 * options, are in apps/jollity-app/lib/explorer/README.md.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import {
  exitCode,
  mergeReports,
  parseArgs,
  replayCommand,
  shardPlan,
  type ExploreArgs,
} from "../apps/jollity-app/lib/explorer/core/cli"
import { anchorRow, anchorsMarkdown, worstExit, type AnchorReport, type AnchorRow } from "../apps/jollity-app/lib/explorer/core/anchors-report"
import { mergeLivenessSummaries } from "../apps/jollity-app/lib/explorer/mesh/liveness-stats"
import { mergeKnownGaps, writeReport, type KnownGapSeen } from "../apps/jollity-app/lib/explorer/core/report"
import type { SearchResult } from "../apps/jollity-app/lib/explorer/core/search"
import { parseProgressJsonl, partialMeshResult } from "../apps/jollity-app/lib/explorer/core/progress"
import { waitGroupGone } from "../apps/jollity-app/lib/explorer/core/process-group"
import { interruptedPeerActor, type PeerActorCheckpoint } from "../apps/jollity-app/lib/explorer/actor/run"
import { explorerVersion } from "../apps/jollity-app/lib/explorer/core/checkpoint"

const appDir = resolve(import.meta.dirname, "../apps/jollity-app")
const rootDir = resolve(import.meta.dirname, "..")

interface Report extends SearchResult {
  bounds: { depth: number; faults: number; horizonMs: number }
  scenario?: object
  source: { liveness?: Parameters<typeof mergeLivenessSummaries>[0][number]; [key: string]: unknown }
  knownGaps?: KnownGapSeen[]
}

const activeChildren = new Set<ChildProcess>()

/** one vitest process; resolves with what ended it */
const run = (command: { env: Record<string, string>; argv: string[] }, detached = false) =>
  new Promise<string | undefined>((done) => {
    const child = spawn("npx", command.argv, {
      cwd: appDir,
      env: { ...process.env, ...command.env },
      stdio: "inherit",
      // a mesh-pair or peer-actor shard leads its own process group, so a signal reaches vitest and its workers, not only npx
      detached,
    })
    activeChildren.add(child)
    child.on("error", (error) => {
      activeChildren.delete(child)
      done(error.message)
    })
    child.on("exit", (status, signal) => {
      const reason = signal !== null
        ? `ended by ${signal}`
        : status !== 0
          ? `exited ${status}`
          : undefined
      // the wrapper can end before vitest and its workers: resolve only when the whole group is gone
      const settled = detached && child.pid !== undefined ? waitGroupGone(child.pid) : Promise.resolve()
      void settled.then(() => {
        activeChildren.delete(child)
        done(reason)
      })
    })
  })

const readJson = async <T,>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T

async function clearPeerActorRunArtifacts(out: string): Promise<void> {
  await Promise.all([
    rm(resolve(out, "progress.json"), { force: true }),
    rm(resolve(out, "progress.json.tmp"), { force: true }),
    rm(resolve(out, "vitest-timeout"), { force: true }),
    rm(resolve(out, "report.json"), { force: true }),
    rm(resolve(out, "summary.md"), { force: true }),
  ])
}

async function completedPeerActorExit(out: string): Promise<number | undefined> {
  let report: Report
  try {
    report = await readJson<Report>(resolve(out, "report.json"))
  } catch {
    return undefined
  }
  const code = exitCode({
    violations: report.findings.length,
    harnessError: report.levels.some((level) => (level.cuts.harness ?? 0) > 0),
    mutantMissed: false,
    inconclusive: report.inconclusive,
  })
  if (code === 3) console.error(`inconclusive at d = ${report.closedAtDepth}`)
  return code
}

async function retainInterruptedPeerActor(out: string): Promise<number | undefined> {
  let checkpoint: PeerActorCheckpoint
  try {
    checkpoint = await readJson<PeerActorCheckpoint>(resolve(out, "progress.json"))
  } catch {
    return undefined
  }
  const interrupted = interruptedPeerActor(checkpoint)
  await writeReport(out, "peer-actor", interrupted.result, {
    bounds: { depth: checkpoint.options.depth, faults: checkpoint.options.faults, horizonMs: 0 },
    scenario: checkpoint.options.anchor === undefined ? undefined : { name: `anchor ${checkpoint.options.anchor}` },
    source: { kind: "peer-actor-bfs", ...interrupted.summary },
    interruptedAtDepth: checkpoint.layer.depth,
  })
  console.error(`inconclusive at d = ${checkpoint.layer.depth} (interrupted)`)
  return 3
}

/** The depths every shard had finished when a mesh-pair run was stopped, from <out>/progress.jsonl, as an inconclusive report. */
async function retainInterruptedMeshPair(out: string): Promise<number | undefined> {
  let text: string
  try {
    text = await readFile(resolve(out, "progress.jsonl"), "utf8")
  } catch {
    return undefined
  }
  const records = parseProgressJsonl(text)
  const partial = partialMeshResult(records)
  if (partial === undefined) return undefined
  const first = records[0]!
  await writeReport(out, "mesh-pair", partial.result, {
    bounds: partial.bounds,
    scenario: { name: first.anchor ?? first.scenario },
    source: { kind: "mesh-pair-dfs", shards: first.shard?.of ?? 1, findingsSoFar: partial.findingsSoFar },
    interruptedAtDepth: partial.interruptedAtDepth,
  })
  console.error(`inconclusive at d = ${partial.interruptedAtDepth} (interrupted; ${partial.findingsSoFar} findings so far)`)
  return 3
}

/** One search (sharded or not) into args.out; resolves with its exit code. */
async function searchOnce(args: ExploreArgs): Promise<number> {
  const tiledMesh = args.machine === "mesh-pair" && args.dedup && !args.legacyDfs
  const version = tiledMesh
    ? await explorerVersion(rootDir, execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim())
    : undefined
  const plan = tiledMesh
    ? [{
        env: { EXPLORE_ARGS: JSON.stringify(args), EXPLORER_VERSION: JSON.stringify(version) },
        argv: ["vitest", "run", "--config", "vitest.explore.config.ts", "lib/explorer/mesh/tiled-run.explore.ts", "--maxWorkers=1"],
      }]
    : shardPlan(args)
  const out = isAbsolute(args.out) ? args.out : resolve(rootDir, args.out)
  if (args.machine === "peer-actor") await clearPeerActorRunArtifacts(out)
  if (tiledMesh) await rm(resolve(out, "stop.requested"), { force: true })
  if (args.machine === "mesh-pair" && !tiledMesh) await rm(resolve(out, "progress.jsonl"), { force: true })
  if (plan.length > 1) {
    console.log(`explorer: ${plan.length} shards under ${out}`)
  }
  let interruptedBySignal = false
  const stop = (signal: NodeJS.Signals) => () => {
    interruptedBySignal = true
    for (const child of activeChildren) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
  }
  const onTerm = stop("SIGTERM")
  const onInt = stop("SIGINT")
  const onHup = stop("SIGHUP")
  const onUsr1 = () => {
    mkdirSync(out, { recursive: true })
    const file = resolve(out, "stop.requested")
    const temporary = `${file}.tmp-${process.pid}`
    writeFileSync(temporary, "SIGUSR1\n")
    renameSync(temporary, file)
    console.error(`explorer: checkpoint requested; shards will stop after their current state`)
  }
  if (args.machine === "peer-actor" || args.machine === "mesh-pair") {
    process.on("SIGTERM", onTerm)
    process.on("SIGINT", onInt)
    process.on("SIGHUP", onHup)
    if (tiledMesh) process.on("SIGUSR1", onUsr1)
  }
  let ended: (string | undefined)[]
  try {
    ended = await Promise.all(plan.map((command) => run(command, args.machine === "mesh-pair" || args.machine === "peer-actor")))
  } finally {
    if (args.machine === "peer-actor" || args.machine === "mesh-pair") {
      process.off("SIGTERM", onTerm)
      process.off("SIGINT", onInt)
      process.off("SIGHUP", onHup)
      if (tiledMesh) process.off("SIGUSR1", onUsr1)
    }
  }
  const failed = ended.flatMap((reason, index) =>
    reason === undefined ? [] : [`shard ${index}: ${reason}`],
  )
  if (failed.length > 0) {
    const childInterrupted = ended.some((reason) => reason === "ended by SIGTERM" || reason === "ended by SIGINT")
    const vitestTimedOut = args.machine === "peer-actor"
      && await readFile(resolve(out, "vitest-timeout"), "utf8").then(() => true, () => false)
    if (args.machine === "peer-actor" && (interruptedBySignal || childInterrupted || vitestTimedOut)) {
      const completed = await completedPeerActorExit(out)
      if (completed !== undefined) return completed
      const retained = await retainInterruptedPeerActor(out)
      if (retained !== undefined) return retained
    }
    if (args.machine === "mesh-pair" && interruptedBySignal) {
      const retained = await retainInterruptedMeshPair(out)
      if (retained !== undefined) return retained
    }
    // a shard that died (killed, out of memory, preempted) leaves no merged
    // report: the run is a harness failure, never a partial "clean"
    for (const line of failed) console.error(`explorer process ${line}`)
    return 4
  } else {
    if (tiledMesh) {
      const checkpointed = await Promise.all([
        readJson<{ inconclusive?: boolean }>(resolve(out, "report.json")).catch(() => ({})),
        readFile(resolve(out, "checkpoint.json"), "utf8").then(() => true, () => false),
      ])
      if (checkpointed[0].inconclusive === true && checkpointed[1]) return 0
    }
    if (plan.length > 1) {
      const parts = await Promise.all(
        plan.map((_, index) =>
          readJson<Report>(resolve(out, `shard-${index}`, "report.json")),
        ),
      )
      const [first] = parts
      await writeReport(out, args.machine, mergeReports(parts), {
        bounds: first.bounds,
        scenario: first.scenario,
        source: {
          ...first.source,
          shards: parts.length,
          ...(first.source.liveness !== undefined ? { liveness: mergeLivenessSummaries(parts.flatMap((part) => part.source.liveness ?? [])) } : {}),
        },
        ...(first.knownGaps !== undefined ? { knownGaps: mergeKnownGaps(parts.map((part) => part.knownGaps)) } : {}),
      })
      await copyFile(
        resolve(out, "shard-0", "self-test.json"),
        resolve(out, "self-test.json"),
      )
    }
    const report = await readJson<{
      findings?: unknown[]
      levels?: { cuts?: { harness?: number } }[]
      closedAtDepth?: number
      inconclusive?: boolean
    }>(resolve(out, "report.json"))
    const selfTest = await readJson<{ requested?: boolean; passed?: boolean }>(
      resolve(out, "self-test.json"),
    )
    const code = exitCode({
      violations: report.findings?.length ?? 0,
      harnessError:
        report.levels?.some((level) => (level.cuts?.harness ?? 0) > 0) ??
        true,
      mutantMissed: selfTest.requested === true && selfTest.passed !== true,
      inconclusive: report.inconclusive === true,
    })
    if (code === 3) {
      console.error(`inconclusive at d = ${report.closedAtDepth ?? 0}`)
    }
    return code
  }
  return 4
}

const anchorDir = (machine: string) => resolve(appDir, "lib/explorer", machine === "peer-actor" ? "actor/anchors" : "mesh/anchors")

/** --anchor with more than one anchor (and no --candidates, which searches the union in one process) */
function anchorLoop(args: ExploreArgs): boolean {
  if (args.anchor === undefined || args.candidates) return false
  return args.machine === "mesh-pair" || args.anchor === "all" || args.anchor.includes(",")
}

/** T17: one process per anchor, one after the other (each with a fresh heap,
 *  so one that runs out of memory does not take the rest), then one merged
 *  report: report.json and summary.md over all, anchors.md and anchors.json
 *  with one row each. */
async function searchAnchors(args: ExploreArgs): Promise<number> {
  const out = isAbsolute(args.out) ? args.out : resolve(rootDir, args.out)
  const names = args.anchor === "all"
    ? (await readdir(anchorDir(args.machine))).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort()
    : args.anchor!.split(",")
  const rows: AnchorRow[] = []
  const parts: Report[] = []
  for (const name of names) {
    const sub: ExploreArgs = args.machine === "peer-actor"
      ? { ...args, anchor: name, out: resolve(out, name) }
      : { ...args, anchor: undefined, scenario: name, out: resolve(out, name) }
    console.log(`explorer: anchor ${name} -> ${sub.out}`)
    const code = await searchOnce(sub)
    let report: Report
    try {
      report = await readJson<Report>(resolve(sub.out, "report.json"))
    } catch {
      rows.push({ anchor: name, exit: code, closedAtDepth: 0, inconclusive: true, frontierClosed: false, states: 0, cuts: { harness: 1 }, violations: 0, witnesses: [], elapsedMs: 0 })
      continue
    }
    // a sharded run keeps its witnesses per shard (shard-<i>/witnesses)
    const witnessDirs = ["witnesses", ...(await readdir(sub.out).catch(() => [] as string[])).filter((dir) => dir.startsWith("shard-")).map((dir) => `${dir}/witnesses`)]
    const witnesses: string[] = []
    for (const dir of witnessDirs) for (const file of await readdir(resolve(sub.out, dir)).catch(() => [] as string[])) witnesses.push(`${name}/${dir}/${file}`)
    rows.push(anchorRow(name, report as AnchorReport, code, witnesses))
    parts.push(report)
    console.log(`explorer: anchor ${name} exit ${code}, closed at d = ${report.closedAtDepth}`)
  }
  const bounds = parts[0]?.bounds ?? { depth: args.depth ?? 0, faults: args.faults ?? 0, horizonMs: 0 }
  if (parts.length > 0) {
    await writeReport(out, args.machine, mergeReports(parts), {
      bounds,
      scenario: { name: `anchors: ${names.join(", ")}` },
      source: { kind: "anchors", anchors: rows },
      ...(parts.some((part) => part.knownGaps !== undefined) ? { knownGaps: mergeKnownGaps(parts.map((part) => part.knownGaps)) } : {}),
    })
  }
  await writeFile(resolve(out, "anchors.json"), `${JSON.stringify({ machine: args.machine, bounds, rows }, null, 2)}\n`)
  await writeFile(resolve(out, "anchors.md"), anchorsMarkdown(args.machine, bounds, rows))
  const code = parts.length < names.length ? 4 : worstExit(rows.map((row) => row.exit))
  console.log(anchorsMarkdown(args.machine, bounds, rows))
  return code
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.machine === "self") console.log("self explorer stub")
  if (args.replay !== undefined) {
    const out = isAbsolute(args.out) ? args.out : resolve(rootDir, args.out)
    const file = isAbsolute(args.replay) ? args.replay : resolve(rootDir, args.replay)
    const stored = await readJson<{ machine?: string; violation?: { detail: string } }>(file)
    const machine = stored.machine
    if (machine !== "mesh-pair" || args.machine !== machine) {
      throw new Error(`--replay replays mesh-pair witnesses only (witness: ${machine}, --machine: ${args.machine})`)
    }
    await rm(resolve(out, "replay.json"), { force: true })
    const expectedDetail = stored.violation?.detail
    const ended = await run(replayCommand({ ...args, out }))
    if (ended !== undefined) {
      console.error(`explorer replay ${ended}`)
      process.exitCode = 4
    } else {
      const result = await readJson<{
        status: "reproduced" | "different-violation" | "not-reproduced" | "out-of-date"
        violation?: { property: string; atStep: number; detail: string }
        atStep?: number
        label?: string
        emitted?: string
      }>(resolve(out, "replay.json"))
      if (result.status === "out-of-date") {
        console.error(`witness out of date at step ${result.atStep}: ${result.label}`)
      } else if (result.status === "different-violation") {
        console.error(
          `different violation (witness expected: ${expectedDetail}); found ${result.violation?.property} at step ${result.violation?.atStep}: ${result.violation?.detail}`,
        )
      } else if (result.status === "reproduced") {
        console.error(
          `reproduced ${result.violation?.property} at step ${result.violation?.atStep}: ${result.violation?.detail}`,
        )
      } else {
        console.error("not reproduced")
      }
      if (result.emitted !== undefined) console.log(result.emitted)
      process.exitCode = exitCode({
        violations: 0,
        harnessError: false,
        mutantMissed: false,
        inconclusive: false,
        replay: result.status,
      })
    }
  } else if (anchorLoop(args)) {
    process.exitCode = await searchAnchors(args)
  } else {
    process.exitCode = await searchOnce(args)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 4
}
