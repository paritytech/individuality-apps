// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { availableParallelism, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { writeReport } from "./report"
import type { Leaf, SearchResult } from "./search"
import { HarnessError, type Room } from "../mesh/room"
import {
  exitCode,
  heapCheck,
  leafChecks,
  mergeReports,
  outputDir,
  parseArgs,
  shardPlan,
  UsageError,
  vitestCommand,
} from "./cli"

const emptyResult: SearchResult = {
  levels: [
    {
      depth: 1,
      leaves: 1,
      meanEnabled: 0,
      cuts: { depth: 0, faults: 0, horizon: 0, quiet: 1, seen: 0, harness: 0 },
      details: {},
      elapsedMs: 1,
    },
  ],
  closedAtDepth: 1,
  inconclusive: false,
  findings: [],
}

const root = resolve(import.meta.dirname, "../../../../../")

describe("explorer CLI", () => {
  it("parses --machine --depth --faults --seed --replay", () => {
    expect(
      parseArgs([
        "--machine",
        "mesh-pair",
        "--depth",
        "12",
        "--faults",
        "2",
        "--seed",
        "41",
        "--replay",
        "witness.json",
      ]),
    ).toMatchObject({
      machine: "mesh-pair",
      depth: 12,
      faults: 2,
      seed: 41,
      replay: "witness.json",
    })
  })

  it("defaults: budget 30 min, self-test on for mesh-pair", () => {
    expect(parseArgs(["--machine", "mesh-pair"])).toMatchObject({
      budgetMin: 30,
      selfTest: true,
      emitTest: false,
      census: false,
      dedup: false,
    })
    expect(parseArgs(["--machine", "mesh-pair", "--census"]).census).toBe(true)
  })

  it("keeps the ordered first-week 1/100 check on the explicit legacy path", () => {
    expect(parseArgs(["--machine", "mesh-pair", "--dedup", "--legacy-dfs"])).toMatchObject({
      dedup: true,
      dedupCheck: { oneIn: 100 },
    })
    expect(parseArgs(["--machine", "mesh-pair", "--dedup-check", "1/250", "--legacy-dfs"])).toMatchObject({
      dedup: true,
      dedupCheck: { oneIn: 250 },
    })
    expect(parseArgs(["--machine", "mesh-pair"])).not.toHaveProperty("liveness")
    expect(parseArgs(["--machine", "mesh-pair"])).not.toHaveProperty("heartbeat")
    expect(parseArgs(["--machine", "mesh-pair", "--liveness"]).liveness).toEqual({ every: 1 })
    expect(parseArgs(["--machine", "mesh-pair", "--liveness-every", "10"]).liveness).toEqual({ every: 10 })
    expect(parseArgs(["--machine", "mesh-pair", "--liveness", "--liveness-bound-s", "40.5"]).liveness).toEqual({ every: 1, boundS: 40.5 })
    expect(parseArgs(["--machine", "mesh-pair", "--liveness-bound-s", "30", "--liveness-every", "5"]).liveness).toEqual({ every: 5, boundS: 30 })
    expect(() => parseArgs(["--machine", "mesh-pair", "--liveness-bound-s", "30"])).toThrow(UsageError)
    expect(() => parseArgs(["--machine", "mesh-pair", "--liveness", "--liveness-bound-s", "0"])).toThrow(UsageError)
    expect(parseArgs(["--machine", "mesh-pair", "--no-heartbeat"]).heartbeat).toBe(false)
    expect(() => parseArgs(["--machine", "peer-actor", "--liveness"])).toThrow(UsageError)
    expect(() => parseArgs(["--machine", "mesh-pair", "--liveness-every", "0"])).toThrow(UsageError)
    expect(() => parseArgs(["--machine", "mesh-pair", "--dedup-check", "2/100"])).toThrow(UsageError)
    expect(() => parseArgs(["--machine", "mesh-pair", "--dedup-check", "1/0"])).toThrow(UsageError)
  })

  it("selects the checkpointable tiled mesh path and parses resume controls", () => {
    const tiled = parseArgs(["--machine", "mesh-pair", "--dedup"])
    expect(tiled).toMatchObject({
      dedup: true,
      legacyDfs: false,
      forceResume: false,
    })
    expect(tiled).not.toHaveProperty("dedupCheck")
    expect(parseArgs([
      "--machine",
      "mesh-pair",
      "--dedup",
      "--resume",
      "/tmp/mesh-run",
      "--force-resume",
      "--workers",
      "7",
    ])).toMatchObject({
      out: "/tmp/mesh-run",
      resume: "/tmp/mesh-run",
      forceResume: true,
      workers: 7,
    })
    expect(parseArgs(["--machine", "mesh-pair", "--dedup", "--legacy-dfs"]).legacyDfs).toBe(true)
    expect(() => parseArgs(["--machine", "mesh-pair", "--resume", "/tmp/mesh-run"])).toThrow(/--resume requires --dedup/)
    expect(() => parseArgs(["--machine", "peer-actor", "--force-resume"])).toThrow(/--force-resume needs --resume/)
  })

  it.each([
    ["--liveness"],
    ["--sample", "1"],
    ["--census"],
    ["--budget-min", "1"],
    ["--dedup-check", "1/100"],
  ])("refuses unsupported tiled mesh analysis option %s", (...option) => {
    expect(() => parseArgs(["--machine", "mesh-pair", "--dedup", ...option])).toThrow(/not supported by the checkpointable tiled mesh-pair explorer.*--legacy-dfs/s)
  })

  it("keeps unsupported tiled analysis explicit on the legacy route", () => {
    expect(parseArgs([
      "--machine", "mesh-pair", "--dedup", "--legacy-dfs",
      "--liveness", "--sample", "1", "--census", "--budget-min", "1", "--dedup-check", "1/250",
    ])).toMatchObject({
      legacyDfs: true,
      liveness: { every: 1 },
      sample: 1,
      census: true,
      budgetMin: 1,
      dedupCheck: { oneIn: 250 },
    })
  })

  it("rejects an unknown machine with the usage text", () => {
    expect(() => parseArgs(["--machine", "nope"])).toThrow(UsageError)
    expect(() => parseArgs(["--machine", "nope"])).toThrow(
      /Usage: npm run explore/,
    )
  })

  it("builds one vitest command with EXPLORE_ARGS", () => {
    const args = parseArgs(["--machine", "self", "--budget-min", "1"])
    expect(vitestCommand(args)).toEqual({
      env: { EXPLORE_ARGS: JSON.stringify(args) },
      argv: [
        "vitest",
        "run",
        "--config",
        "vitest.explore.config.ts",
        "lib/explorer/run.explore.ts",
      ],
    })
  })

  it("maps outcomes to exit codes 0, 1, 2 and 4", () => {
    expect(
      exitCode({
        violations: 0,
        mutantMissed: false,
        harnessError: false,
        inconclusive: false,
      }),
    ).toBe(0)
    expect(
      exitCode({
        violations: 1,
        mutantMissed: false,
        harnessError: false,
        inconclusive: false,
      }),
    ).toBe(1)
    expect(
      exitCode({
        violations: 0,
        mutantMissed: true,
        harnessError: false,
        inconclusive: false,
      }),
    ).toBe(2)
    expect(
      exitCode({
        violations: 0,
        mutantMissed: false,
        harnessError: true,
        inconclusive: false,
      }),
    ).toBe(4)
  })

  it("maps an inconclusive run to exit 3 after harness, violations and mutants", () => {
    expect(
      exitCode({
        violations: 0,
        mutantMissed: false,
        harnessError: false,
        inconclusive: true,
      }),
    ).toBe(3)
    expect(
      exitCode({
        violations: 1,
        mutantMissed: true,
        harnessError: true,
        inconclusive: true,
      }),
    ).toBe(4)
    expect(
      exitCode({
        violations: 1,
        mutantMissed: true,
        harnessError: false,
        inconclusive: true,
      }),
    ).toBe(1)
    expect(
      exitCode({
        violations: 0,
        mutantMissed: true,
        harnessError: false,
        inconclusive: true,
      }),
    ).toBe(2)
  })

  it("exits 4 when a replay is out of date", async () => {
    expect(
      exitCode({
        violations: 0,
        mutantMissed: false,
        harnessError: false,
        inconclusive: false,
        replay: "out-of-date",
      }),
    ).toBe(4)

    const dir = await mkdtemp(join(tmpdir(), "explorer-cli-replay-"))
    const witness = join(dir, "disabled-label.json")
    await writeFile(
      witness,
      `${JSON.stringify({ schema: 1, machine: "mesh-pair", source: { commit: "x", dirty: false, files: {} }, scenario: { name: "single-offer", phaseOffsetMs: 1000, mutant: null }, labels: ["env:disabled"], violation: { property: "P2", atStep: 0, detail: "x" } })}\n`,
    )
    const run = spawnSync(
      "npm",
      [
        "run",
        "explore",
        "--",
        "--machine",
        "mesh-pair",
        "--replay",
        witness,
      ],
      { cwd: root, encoding: "utf8" },
    )
    expect(run.status).toBe(4)
    expect(`${run.stdout}${run.stderr}`).toContain("witness out of date at step 0")
  }, 30_000)

  it("replays a generated liveness-bound witness with its typed threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-cli-bound-replay-"))
    const boundedOut = join(dir, "bounded")
    const common = [
      "run",
      "explore",
      "--",
      "--machine",
      "mesh-pair",
      "--scenario",
      "mid-rebuild",
      "--depth",
      "1",
      "--faults",
      "1",
      "--liveness",
      "--workers",
      "1",
      "--no-self-test",
    ]
    const bounded = spawnSync(
      "npm",
      [...common, "--liveness-bound-s", "0.1", "--out", boundedOut],
      { cwd: root, encoding: "utf8" },
    )
    expect(bounded.status, `${bounded.stdout}${bounded.stderr}`).toBe(1)
    const witness = join(boundedOut, "witnesses", "L1-1.json")
    expect(JSON.parse(await readFile(witness, "utf8"))).toMatchObject({
      check: { kind: "liveness-bound", boundS: 0.1 },
      violation: { property: "L1" },
    })

    const replayOut = join(dir, "replay")
    const replay = spawnSync(
      "npm",
      ["run", "explore", "--", "--machine", "mesh-pair", "--replay", witness, "--out", replayOut],
      { cwd: root, encoding: "utf8" },
    )
    expect(replay.status, `${replay.stdout}${replay.stderr}`).toBe(1)
    expect(`${replay.stdout}${replay.stderr}`).toContain("reproduced L1")

    const defaultOff = spawnSync(
      "npm",
      [...common, "--out", join(dir, "default-off")],
      { cwd: root, encoding: "utf8" },
    )
    expect(defaultOff.status, `${defaultOff.stdout}${defaultOff.stderr}`).toBe(0)
  }, 60_000)

  it("exits 3 end to end for a stubbed budget-stopped inconclusive run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "explorer-cli-inconclusive-"))
    const out = join(dir, "result")
    const run = spawnSync(
      "npm",
      [
        "run",
        "explore",
        "--",
        "--machine",
        "self",
        "--budget-min",
        "0",
        "--out",
        out,
      ],
      { cwd: root, encoding: "utf8" },
    )
    expect(run.status).toBe(3)
    expect(`${run.stdout}${run.stderr}`).toContain("self explorer stub")
    expect(`${run.stdout}${run.stderr}`).toContain("inconclusive at d = 0")
    expect(JSON.parse(await readFile(join(out, "report.json"), "utf8"))).toMatchObject({
      inconclusive: true,
      closedAtDepth: 0,
    })
  }, 30_000)

  it("keeps Room.checkLeaf harness details on their exact search levels", async () => {
    const checker = leafChecks(17)
    const throwingRoom = (detail: string): Room =>
      ({
        checkLeaf: async () => {
          throw new HarnessError(detail)
        },
      }) as unknown as Room
    await checker.onLeaf({
      labels: [],
      cut: "quiet",
      room: throwingRoom("unowned wait: x"),
    } as Leaf)
    await checker.onLeaf({
      labels: ["clock:next"],
      cut: "quiet",
      room: throwingRoom("real timer: 2"),
    } as Leaf)
    const result: SearchResult = {
      levels: [
        {
          depth: 1,
          leaves: 1,
          meanEnabled: 0,
          cuts: { depth: 0, faults: 0, horizon: 0, quiet: 1, seen: 0, harness: 0 },
          details: {},
          elapsedMs: 0,
        },
        {
          depth: 2,
          leaves: 1,
          meanEnabled: 0,
          cuts: { depth: 0, faults: 0, horizon: 0, quiet: 1, seen: 0, harness: 0 },
          details: {},
          elapsedMs: 0,
        },
      ],
      closedAtDepth: 2,
      inconclusive: false,
      findings: [],
    }
    checker.merge(result)
    expect(result.levels[0]).toMatchObject({
      cuts: { quiet: 0, harness: 1 },
      details: { "unowned wait: x": 1 },
    })
    expect(result.levels[1]).toMatchObject({
      cuts: { quiet: 0, harness: 1 },
      details: { "real timer: 2": 1 },
    })
    expect(result.closedAtDepth).toBe(0)
  })

  it("records a guarded gap-fingerprint failure as a harness cut", async () => {
    const checker = leafChecks(17)
    await checker.onLeaf({
      labels: ["clock:next"],
      cut: "depth",
      room: { checkLeaf: async () => {} } as unknown as Room,
    } as Leaf, "dedup gap fingerprint: fingerprint failed")
    const result: SearchResult = {
      levels: [{
        depth: 1,
        leaves: 1,
        meanEnabled: 0,
        cuts: { depth: 1, faults: 0, horizon: 0, quiet: 0, seen: 0, harness: 0 },
        details: {},
        elapsedMs: 0,
      }],
      closedAtDepth: 1,
      inconclusive: false,
      findings: [],
    }

    checker.merge(result)

    expect(result.levels[0]).toMatchObject({
      cuts: { depth: 0, harness: 1 },
      details: { "dedup gap fingerprint: fingerprint failed": 1 },
    })
    expect(result.closedAtDepth).toBe(0)
  })

  it("samples the same non-quiet leaves for the same seed", async () => {
    const selected = async (seed: number): Promise<number[]> => {
      const indexes: number[] = []
      const checker = leafChecks(seed)
      for (let index = 0; index < 1_000; index += 1) {
        await checker.onLeaf({
          labels: [`clock:next:${index}`],
          cut: "depth",
          room: {
            checkLeaf: async () => {
              indexes.push(index)
            },
          } as unknown as Room,
        } as Leaf)
      }
      return indexes
    }
    const first = await selected(742)
    expect(first.length).toBeGreaterThan(0)
    expect(await selected(742)).toEqual(first)
  })

  it("writes outputs under test-results/explorer/<UTC stamp>-<machine> with times in the local zone, labelled", async () => {
    const at = new Date("2026-10-28T22:45:01.234Z")
    const relative = outputDir("self", at)
    expect(relative).toBe("test-results/explorer/20261028T224501Z-self")

    const dir = await mkdtemp(join(tmpdir(), "explorer-cli-output-"))
    const target = join(dir, relative)
    await writeReport(target, "self", emptyResult, {
      bounds: { depth: 1, faults: 0, horizonMs: 1_000 },
      source: { kind: "self" },
    })
    const summary = await readFile(join(target, "summary.md"), "utf8")
    const zone = new Intl.DateTimeFormat("en-GB", {
      timeZoneName: "short",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value
    expect(zone).toBeTruthy()
    expect(summary).toContain(zone)
  })

  const level = (
    depth: number,
    leaves: number,
    cuts: Partial<Record<"depth" | "faults" | "horizon" | "quiet" | "harness", number>>,
    extra: { details?: Record<string, number>; elapsedMs?: number } = {},
  ) => ({
    depth,
    leaves,
    meanEnabled: 2,
    cuts: { depth: 0, faults: 0, horizon: 0, quiet: 0, seen: 0, harness: 0, ...cuts },
    details: extra.details ?? {},
    elapsedMs: extra.elapsedMs ?? 1,
  })

  it("merges shard reports: leaves add, closedAtDepth is the minimum, inconclusive if any", () => {
    const finding = (labels: string[]) => ({
      property: "toy",
      labels,
      atStep: labels.length - 1,
      detail: "planted",
      sampled: false,
    })
    const merged = mergeReports([
      {
        levels: [level(1, 1, { depth: 1 }, { elapsedMs: 5 }), level(2, 2, { depth: 1, quiet: 1 })],
        closedAtDepth: 2,
        inconclusive: false,
        findings: [finding(["x", "y", "x", "y"])],
      },
      {
        levels: [
          level(1, 1, { depth: 1 }, { elapsedMs: 9 }),
          level(2, 3, { depth: 2, harness: 1 }, { details: { boom: 1 } }),
        ],
        closedAtDepth: 1,
        inconclusive: true,
        findings: [finding(["x", "y", "x"])],
      },
    ])
    expect(merged.levels.map(({ leaves }) => leaves)).toEqual([2, 5])
    expect(merged.levels[1].cuts).toEqual({ depth: 3, faults: 0, horizon: 0, quiet: 1, seen: 0, harness: 1 })
    expect(merged.levels[1].details).toEqual({ boom: 1 })
    // the shards run side by side: a level takes as long as its slowest shard
    expect(merged.levels[0].elapsedMs).toBe(9)
    expect(merged.closedAtDepth).toBe(1)
    expect(merged.inconclusive).toBe(true)
    // one finding per property and detail, the shortest witness
    expect(merged.findings).toEqual([finding(["x", "y", "x"])])
    expect(() => mergeReports([])).toThrow()
  })

  it("merges census fingerprints across shards without double-counting shared states", () => {
    const part = (leaves: number, keys: string[], suffix: string): SearchResult => ({
      levels: [{
        ...level(2, leaves, { depth: leaves }),
        census: { depthLeaves: leaves, distinctFingerprints: keys.length, ratio: leaves / keys.length },
        _censusKeys: keys,
        _censusPaths: keys.map((key) => ({ key, paths: [[`${key}-${suffix}`]] })),
      }],
      closedAtDepth: 2,
      inconclusive: false,
      findings: [],
    })
    const merged = mergeReports([part(3, ["a", "shared"], "left"), part(2, ["shared", "b"], "right")])
    expect(merged.levels[0].census).toEqual({ depthLeaves: 5, distinctFingerprints: 3, ratio: 5 / 3 })
    expect(merged.levels[0]._censusKeys).toEqual(["a", "b", "shared"])
    expect(merged.levels[0]._censusPaths).toEqual([
      { key: "a", paths: [["a-left"]] },
      { key: "b", paths: [["b-right"]] },
      { key: "shared", paths: [["shared-left"], ["shared-right"]] },
    ])
  })

  it("plans one vitest process per worker with EXPLORE_ARGS and a shard index", () => {
    const args = parseArgs(["--machine", "mesh-pair", "--workers", "3", "--out", "out/run"])
    expect(args.workers).toBe(3)
    const plan = shardPlan(args)
    expect(plan).toHaveLength(3)
    plan.forEach((command, index) => {
      expect(command.argv).toEqual(vitestCommand(args).argv)
      const shardArgs = JSON.parse(command.env.EXPLORE_ARGS)
      expect(shardArgs).toMatchObject({
        machine: "mesh-pair",
        shard: { index, of: 3, depth: 2 },
        out: `out/run/shard-${index}`,
        // the mutant self-test runs once, in shard 0
        selfTest: index === 0,
      })
    })
  })

  it("defaults --workers to the cores less two, and runs peer-actor and self as one process", () => {
    expect(parseArgs(["--machine", "mesh-pair"]).workers).toBe(
      Math.max(1, availableParallelism() - 2),
    )
    expect(() => parseArgs(["--machine", "mesh-pair", "--workers", "0"])).toThrow(UsageError)
    for (const machine of ["peer-actor", "self", "sweeps"]) {
      const args = parseArgs(["--machine", machine, "--workers", "4"])
      expect(shardPlan(args)).toEqual([vitestCommand(args)])
    }
    const one = parseArgs(["--machine", "mesh-pair", "--workers", "1"])
    expect(shardPlan(one)).toEqual([vitestCommand(one)])
  })

  it("checks the worker's real heap limit against --heap-gb", () => {
    expect(parseArgs(["--machine", "peer-actor", "--heap-gb", "110"]).heapGb).toBe(110)
    const gib = 1024 ** 3
    expect(heapCheck(6.2 * gib, 6)).toEqual({
      ok: true,
      line: "heap limit 6.20 GiB (wanted >= 6 GiB)",
    })
    expect(heapCheck(4.1 * gib, 6)).toEqual({
      ok: false,
      line: "heap limit 4.10 GiB (wanted >= 6 GiB)",
    })
    expect(heapCheck(4.1 * gib, undefined)).toEqual({
      ok: true,
      line: "heap limit 4.10 GiB",
    })
  })
})
