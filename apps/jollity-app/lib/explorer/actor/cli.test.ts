// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseArgs } from "../core/cli"

const root = resolve(import.meta.dirname, "../../../../../")

const explore = (args: string[]) => spawnSync("npm", ["run", "explore", "--", "--machine", "peer-actor", ...args], { cwd: root, encoding: "utf8" })

const staleCheckpoint = {
  options: { depth: 8, faults: 1, maxStates: 200_000, hash: true },
  layer: {
    depth: 1,
    states: 10,
    added: 9,
    heapUsedMb: 100,
    elapsedMs: 50,
    cuts: { depth: 9, faults: 0, domain: 0 },
    edgeCount: 12,
    frontierClosed: false,
    violations: [],
  },
}

async function seedInterruptedArtifacts(out: string): Promise<void> {
  await mkdir(out, { recursive: true })
  await writeFile(join(out, "progress.json"), `${JSON.stringify(staleCheckpoint)}\n`)
  await writeFile(join(out, "vitest-timeout"), "")
}

describe("npm run explore -- --machine peer-actor", () => {
  it("parses --max-states and --hash, hashing by default", () => {
    expect(parseArgs(["--machine", "peer-actor"])).toMatchObject({ machine: "peer-actor", hash: true, maxStates: undefined })
    expect(parseArgs(["--machine", "peer-actor", "--max-states", "500", "--no-hash"])).toMatchObject({ maxStates: 500, hash: false })
    expect(parseArgs(["--machine", "peer-actor", "--no-hash", "--hash"])).toMatchObject({ hash: true })
  })

  it("runs the search and reports it clean and closed at its depth (exit 0)", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-")), "result")
    const run = explore(["--depth", "2", "--faults", "1", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({ machine: "peer-actor", bounds: { depth: 2, faults: 1, horizonMs: 0 }, closedAtDepth: 2, inconclusive: false, findings: [], source: { kind: "peer-actor-bfs", hash: true, capped: false, violations: 0 } })
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain("clean at d = 2, F = 1, H = 0 s (closed at the depth bound)")
    const stdoutLines = run.stdout.split("\n").filter((line) => line.startsWith("peer-actor depth="))
    const logLines = (await readFile(join(out, "progress.log"), "utf8")).trim().split("\n")
    expect(stdoutLines).toEqual(logLines)
    expect(logLines).toHaveLength(2)
    expect(logLines[0]).toMatch(/^peer-actor depth=1 states_new=\d+ states_total=\d+ elapsed_ms=\d+ heap_used_mb=\d+ cuts_depth=\d+ cuts_faults=\d+ cuts_domain=\d+$/)
    expect(logLines[1]).toMatch(/^peer-actor depth=2 states_new=\d+ states_total=\d+ elapsed_ms=\d+ heap_used_mb=\d+ cuts_depth=\d+ cuts_faults=\d+ cuts_domain=\d+$/)
  }, 120_000)

  it("retains only the last finished layer when SIGTERM stops the run", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-interrupted-")), "result")
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "scripts/explore.mts",
      "--machine",
      "peer-actor",
      "--depth",
      "8",
      "--faults",
      "1",
      "--max-states",
      "200000",
      "--out",
      out,
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=6144",
        npm_config_cache: "/tmp/explorer-depth-progress-npm-cache",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let stopped = false
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      if (!stopped && stdout.includes("peer-actor depth=1 ")) {
        stopped = true
        child.kill("SIGTERM")
      }
    })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.on("exit", (code, signal) => done({ code, signal }))
    })
    expect(ended, `${stdout}\n${stderr}`).toEqual({ code: 3, signal: null })
    const progress = (await readFile(join(out, "progress.log"), "utf8")).trim().split("\n")
    const lastDepth = Number(progress.at(-1)?.match(/depth=(\d+)/)?.[1])
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({
      interruption: `interrupted at d = ${lastDepth}`,
      closedAtDepth: lastDepth,
      inconclusive: true,
      source: { depthCompleted: lastDepth, interruptedAtDepth: lastDepth },
    })
    expect(await readFile(join(out, "summary.md"), "utf8")).toContain(`- Run: interrupted at d = ${lastDepth}`)
    expect(`${stdout}${stderr}`).toContain(`inconclusive at d = ${lastDepth} (interrupted)`)
  }, 120_000)

  it("does not attribute stale interruption artifacts to a later failed run", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-stale-")), "result")
    await seedInterruptedArtifacts(out)
    const run = explore(["--anchor", "not-an-anchor", "--candidates", "--depth", "1", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(4)
    await expect(readFile(join(out, "report.json"), "utf8")).rejects.toThrow()
  }, 120_000)

  it("does not replace a completed report with interrupted recovery", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-complete-")), "result")
    await mkdir(out, { recursive: true })
    execFileSync("mkfifo", [join(out, "self-test.json")])
    const parent = spawn(process.execPath, [
      "--import",
      "tsx",
      "scripts/explore.mts",
      "--machine",
      "peer-actor",
      "--depth",
      "1",
      "--faults",
      "1",
      "--out",
      out,
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=6144",
        npm_config_cache: "/tmp/explorer-depth-progress-npm-cache",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    parent.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    parent.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    let completed: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        completed = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
        break
      } catch {
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    expect(completed, `${stdout}\n${stderr}`).toBeDefined()
    parent.kill("SIGTERM")
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      parent.on("exit", (code, signal) => done({ code, signal }))
    })
    expect(ended, `${stdout}\n${stderr}`).toEqual({ code: 0, signal: null })
    expect(JSON.parse(await readFile(join(out, "report.json"), "utf8"))).toEqual(completed)
    expect(await readFile(join(out, "summary.md"), "utf8")).not.toContain("interrupted at")
  }, 120_000)

  it("stops the peer-actor child when the parent receives SIGHUP", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-sighup-")), "result")
    const parent = spawn(process.execPath, [
      "--import",
      "tsx",
      "scripts/explore.mts",
      "--machine",
      "peer-actor",
      "--depth",
      "8",
      "--faults",
      "1",
      "--max-states",
      "200000",
      "--out",
      out,
    ], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=6144",
        npm_config_cache: "/tmp/explorer-depth-progress-npm-cache",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let childPid: number | undefined
    let sawLayer = false
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for layer\n${stdout}\n${stderr}`)), 60_000)
        parent.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString()
          if (sawLayer || !stdout.includes("peer-actor depth=1 ")) return
          sawLayer = true
          const listed = execFileSync("ps", ["-o", "pid=", "--ppid", String(parent.pid)], { encoding: "utf8" }).trim()
          childPid = Number(listed.split(/\s+/)[0])
          clearTimeout(timer)
          done()
        })
        parent.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
        parent.on("error", reject)
      })
      parent.kill("SIGHUP")
      const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
        parent.on("exit", (code, signal) => done({ code, signal }))
      })
      expect(ended, `${stdout}\n${stderr}`).toEqual({ code: 3, signal: null })
      expect(() => process.kill(childPid!, 0)).toThrow()
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL")
      if (childPid !== undefined) {
        try { process.kill(-childPid, "SIGKILL") } catch {
          try { process.kill(childPid, "SIGKILL") } catch { /* already stopped */ }
        }
      }
    }
  }, 120_000)

  it("parses --candidates and --fair-depth", () => {
    expect(parseArgs(["--machine", "peer-actor", "--candidates"])).toMatchObject({ candidates: true, fairDepth: undefined })
    expect(parseArgs(["--machine", "peer-actor", "--candidates", "--fair-depth", "2"])).toMatchObject({ candidates: true, fairDepth: 2 })
  })

  it("writes the phase B candidates from full-key runs with --candidates", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-candidates-")), "result")
    const run = explore(["--depth", "2", "--fair-depth", "1", "--faults", "1", "--candidates", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const markdown = await readFile(join(out, "candidates.md"), "utf8")
    expect(markdown).toContain("uncovered within bounds (d = 2 from the start, d = 1 from the fair and seed runs, F = 1, H = n/a)")
    expect(markdown).toContain("d = 2 from the 3 initial worlds (closed at the depth bound")
    expect(markdown).toContain("d = 1 from the")
    const json = JSON.parse(await readFile(join(out, "candidates.json"), "utf8"))
    expect(json.candidates.length).toBeGreaterThan(0)
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({ source: { kind: "peer-actor-bfs", hash: false } })
  }, 180_000)

  it("exits 3 with its closed depth when the state cap stops it", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-peer-actor-cap-")), "result")
    const run = explore(["--depth", "6", "--faults", "1", "--max-states", "300", "--no-hash", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(3)
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({ inconclusive: true, source: { capped: true, hash: false, states: 300 } })
    expect(`${run.stdout}${run.stderr}`).toContain(`inconclusive at d = ${report.closedAtDepth}`)
    expect(report.closedAtDepth).toBeLessThan(6)
  }, 120_000)

  it("parses --anchor for peer-actor and mesh-pair (one mesh anchor is its --scenario)", () => {
    expect(parseArgs(["--machine", "peer-actor", "--anchor", "all"])).toMatchObject({ anchor: "all" })
    expect(parseArgs(["--machine", "mesh-pair", "--anchor", "steady"])).toMatchObject({ anchor: undefined, scenario: "steady" })
    expect(parseArgs(["--machine", "mesh-pair", "--anchor", "all"])).toMatchObject({ anchor: "all" })
    expect(() => parseArgs(["--machine", "read-retry", "--anchor", "all"])).toThrow(/--anchor is for peer-actor and mesh-pair/)
  })

  it("searches from one named anchor, its findings replayable from the start (exit 0, clean)", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-anchor-")), "result")
    const run = explore(["--anchor", "rejoin-queued-offers", "--depth", "2", "--faults", "1", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({ closedAtDepth: 2, inconclusive: false, findings: [], scenario: { name: "anchor rejoin-queued-offers" }, source: { anchor: "rejoin-queued-offers", from: "answerer", hash: true } })
    expect(report.source.sizing).toMatchObject({ bytesPerState: expect.any(Number), projectedStates: expect.any(Number) })
    expect(report.source.layers).toHaveLength(2)
  }, 120_000)

  it("runs a list of anchors one process each and writes one merged report", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-anchors-")), "result")
    const run = explore(["--anchor", "steady-initiator,camera-off-on", "--depth", "1", "--faults", "1", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const merged = JSON.parse(await readFile(join(out, "anchors.json"), "utf8"))
    expect(merged.rows.map((row: { anchor: string }) => row.anchor)).toEqual(["steady-initiator", "camera-off-on"])
    expect(merged.rows.every((row: { exit: number; closedAtDepth: number }) => row.exit === 0 && row.closedAtDepth === 1)).toBe(true)
    expect(await readFile(join(out, "anchors.md"), "utf8")).toContain("| camera-off-on | 0 | 1 |")
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({ closedAtDepth: 1, inconclusive: false, source: { kind: "anchors" } })
  }, 180_000)

  it("exits 3 for an anchor the state cap stops, at its closed depth", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-anchor-cap-")), "result")
    const run = explore(["--anchor", "network-changed", "--depth", "6", "--faults", "1", "--max-states", "300", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(3)
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"))
    expect(report).toMatchObject({ inconclusive: true, source: { capped: true, anchor: "network-changed" } })
    expect(report.closedAtDepth).toBeLessThan(6)
  }, 120_000)

  it("builds the candidates over the union of the anchors' graphs, naming each anchor", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-anchor-candidates-")), "result")
    const run = explore(["--anchor", "all", "--candidates", "--depth", "1", "--faults", "1", "--out", out])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const markdown = await readFile(join(out, "candidates.md"), "utf8")
    expect(markdown).toContain("searched from the anchors steady-initiator d = 1, steady-answerer d = 1")
    expect(markdown).toContain("camera-off-on d = 1; F = 1 past each anchor")
    expect(markdown).toContain("10 full-key searches")
  }, 180_000)
})
