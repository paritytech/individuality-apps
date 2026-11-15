// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The scheduler spike, the explorer's first feasibility check: can two Meshes over FakePC be driven
 * only by explorer-owned choices, one task per step and a watchdogged drain,
 * with byte-identical replay, a reset that reinstalls the fake clock without
 * a module reset, a detector that catches unowned waits, and a tree that
 * closes at a useful depth? One `it` per criterion, kept as a permanent
 * self-check of the harness. The criteria are S1-S5, one `it` each below.
 *
 * Run: npx vitest run --config vitest.explore.config.ts lib/explorer/spike.explore.ts
 * Each criterion writes its numbers to test-results/explorer/t0/<S>.json.
 * SPIKE_S5_BUDGET_MIN (default 60) bounds S5; SPIKE_S1_N/SPIKE_S2_N (default
 * 1000) the sampled schedules.
 */
// quiescence first: it traps the real timers before anything else loads
import { liveRealTimers, realMs, trapFunctions } from "./mesh/quiescence"
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { FakePC } from "../webrtc/test-pc"
import { getDevLogEntries } from "../debug/log-store"
import type { Label } from "./core/labels"
import { loadMutant, type MutantSpec } from "./mutants/load"
import { capturedRealSetTimeout, REJOIN_TWO_OFFERS, SpikeRoom, type Cut, type MeshClass } from "./mesh/spike-room"

const appRoot = fileURLToPath(new URL("../../", import.meta.url))
const outDir = `${appRoot}test-results/explorer/t0`
const write = (name: string, data: unknown) => {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(`${outDir}/${name}.json`, `${JSON.stringify(data, null, 2)}\n`)
  process.stderr.write(`[spike] ${name}: ${JSON.stringify(data).slice(0, 4000)}\n`)
}

/** M1385, the pre-fix code of #1385: both hunks, plus #1500's guard undone
 *  (the third hunk of mutants/M1385-on.json; without it the mutated Mesh still
 *  rebuilds for the second session's offer and the search finds nothing) */
const M1385: MutantSpec = {
  id: "M1385",
  target: "lib/webrtc/mesh.ts",
  hunks: [
    { find: "if (payload.rtc.desc) {", replace: "if (false && payload.rtc.desc) {" },
    {
      find: 'if (conn.offersApplied !== applied || pc.localDescription?.type !== "answer") {',
      replace: "if (conn.offersApplied !== applied) {",
    },
    {
      find: "const held = remoteSessionOf(conn.pc.remoteDescription?.sdp) ?? this.answeringOn(peerId)?.session ?? null",
      replace: "const held = remoteSessionOf(conn.pc.remoteDescription?.sdp) ?? null",
    },
  ],
}

/** M1385's warmup: a's offer from
 *  a/1 stored, b reloads, b's new transport captures that offer. a has not
 *  heard b's hello yet, so its rebuild and a/2's offer are the search's. */
const M1385_WARMUP: Label[] = ["pc:a/1:negotiationneeded", "pc:a/1:sld:resolve", "pc:a/1:gather", "env:reload:b", "wire:a>b:f1:capture"]

const consoleLog = console.log
let Mesh: MeshClass
let monoNow: () => number

const fingerprint = () => ({
  logEntries: getDevLogEntries().length,
  legacySinks: (globalThis as { __jollityLegacyDecisionCaptureRegistry?: { sinks: Set<unknown> } }).__jollityLegacyDecisionCaptureRegistry?.sinks.size ?? 0,
})

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** a seeded random schedule of at most `depth` labels; returns the labels and the record JSON */
async function sample(room: SpikeRoom, random: () => number, depth: number) {
  await room.reset()
  const labels: Label[] = []
  while (labels.length < depth && room.harness.length === 0) {
    const enabled = room.enabled()
    if (enabled.length === 0) break
    const label = enabled[Math.floor(random() * enabled.length)]
    labels.push(label)
    await room.step(label)
  }
  return { labels, json: snapshot(room) }
}

const snapshot = (room: SpikeRoom) => JSON.stringify({ records: room.records, violations: room.violations, harness: room.harness })

interface TreeStats {
  depth: number
  leaves: number
  internal: number
  enabledSum: number
  cuts: Record<Cut, number>
  harnessDetails: Record<string, number>
  steps: number
  elapsedMs: number
  completed: boolean
  violation: null | { property: string; depth: number; labels: Label[]; detail: string }
}

interface TreeOptions {
  checkUnowned?: boolean
  stopOnViolation?: boolean
  deadline?: number
  /** `reached`: the S3 control was handed out before the leaf's own check began */
  onLeaf?: (room: SpikeRoom, labels: Label[], cut: Cut, reached: boolean) => void
}

class Stop extends Error {}

/** Stateless depth-first enumeration of every schedule from `prefix` to
 *  `depth` labels: the first child continues from the live room, every
 *  other child replays its prefix on a fresh reset. Nothing is deduplicated. */
async function enumerate(room: SpikeRoom, prefix: Label[], depth: number, options: TreeOptions = {}): Promise<TreeStats> {
  const stats: TreeStats = {
    depth, leaves: 0, internal: 0, enabledSum: 0, steps: 0, elapsedMs: 0, completed: false, violation: null,
    cuts: { depth: 0, faults: 0, horizon: 0, quiet: 0, harness: 0, violation: 0 }, harnessDetails: {},
  }
  const started = realMs()
  const leaf = async (labels: Label[], idle: Cut | null) => {
    const reached = room.controlReached
    let cut: Cut = room.violations.length > 0 ? "violation" : room.harness.length > 0 ? "harness" : idle ?? "depth"
    if (cut !== "violation" && cut !== "harness" && (options.checkUnowned || cut === "quiet")) {
      await room.checkUnowned()
      if (room.harness.length > 0) cut = "harness"
    }
    if (cut === "harness") for (const detail of room.harness) stats.harnessDetails[detail] = (stats.harnessDetails[detail] ?? 0) + 1
    stats.leaves++
    stats.cuts[cut]++
    options.onLeaf?.(room, labels, cut, reached)
    if (cut === "violation" && options.stopOnViolation) {
      const first = room.violations[0]
      stats.violation = { property: first.property, depth: labels.length, labels: [...labels], detail: first.detail }
      throw new Stop()
    }
    if (options.deadline !== undefined && realMs() > options.deadline) throw new Stop()
  }
  const visit = async (labels: Label[]): Promise<void> => {
    if (room.violations.length > 0 || room.harness.length > 0 || labels.length === depth) return leaf(labels, null)
    const enabled = room.enabled()
    if (enabled.length === 0) return leaf(labels, room.idleCut())
    stats.internal++
    stats.enabledSum += enabled.length
    for (let i = 0; i < enabled.length; i++) {
      if (i > 0) {
        await room.replay(labels)
        stats.steps += labels.length
      }
      await room.step(enabled[i])
      stats.steps++
      await visit([...labels, enabled[i]])
    }
  }
  try {
    await room.replay(prefix)
    stats.steps += prefix.length
    await visit([...prefix])
    stats.completed = true
  } catch (error) {
    if (!(error instanceof Stop)) throw error
  }
  stats.elapsedMs = Math.round(realMs() - started)
  return stats
}

const summary = (stats: TreeStats) => ({
  depth: stats.depth, closed: stats.completed && stats.cuts.harness === 0, leaves: stats.leaves,
  meanEnabled: stats.internal ? Number((stats.enabledSum / stats.internal).toFixed(3)) : 0,
  cuts: stats.cuts, harnessDetails: stats.harnessDetails, steps: stats.steps, elapsedMs: stats.elapsedMs,
  msPerStep: stats.steps ? Number((stats.elapsedMs / stats.steps).toFixed(4)) : 0,
})

async function dispose(room: SpikeRoom) {
  await room.dispose()
}

describe("scheduler spike", () => {
  beforeAll(async () => {
    // Mesh logs every event; a spy would keep every call's arguments
    console.log = () => {}
    vi.stubGlobal("RTCPeerConnection", FakePC)
    ;({ Mesh, monoNow } = await import("../webrtc/mesh"))
  })
  afterAll(() => {
    console.log = consoleLog
    FakePC.controller = null
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("S1 replays 1000 sampled depth-12 schedules byte-identically", async () => {
    const n = Number(process.env.SPIKE_S1_N ?? 1000)
    const room = new SpikeRoom(Mesh, monoNow, REJOIN_TWO_OFFERS)
    const random = rng(1)
    let differing = 0
    let watchdogs = 0
    let steps = 0
    const started = realMs()
    for (let k = 0; k < n; k++) {
      const first = await sample(room, random, 12)
      await room.replay(first.labels)
      const second = snapshot(room)
      if (second !== first.json) differing++
      if (first.json.includes('"watchdog"')) watchdogs++
      steps += 2 * first.labels.length
    }
    await dispose(room)
    const elapsedMs = Math.round(realMs() - started)
    write("S1", { schedules: n, depth: 12, runsEach: 2, differing, watchdogs, steps, elapsedMs, msPerStep: Number((elapsedMs / steps).toFixed(4)) })
    expect(differing).toBe(0)
    expect(watchdogs).toBe(0)
  })

  it("S2 resets without resetModules, keeps the fingerprint, and replays A/B/A identically", async () => {
    const n = Number(process.env.SPIKE_S2_N ?? 1000)
    const room = new SpikeRoom(Mesh, monoNow, REJOIN_TWO_OFFERS)
    const random = rng(2)
    const base = fingerprint()
    const changed: unknown[] = []
    const badStarts: unknown[] = []
    let watchdogs = 0
    for (let k = 0; k < n; k++) {
      await sample(room, random, 12)
      if (room.harness.includes("watchdog")) watchdogs++
      if (room.startClock.date !== 0 || room.startClock.mono !== 1) badStarts.push({ k, ...room.startClock })
      const now = fingerprint()
      // log-store growth is allowed; nothing else may move
      if (now.legacySinks !== base.legacySinks) changed.push({ k, ...now })
    }
    // A/B/A: B ends at another fake time than A
    const a = await sample(room, rng(77), 12)
    const aEnd = room.records.at(-1)?.clockMs
    await sample(room, rng(78), 12)
    for (let seed = 79; room.records.at(-1)?.clockMs === aEnd; seed++) await sample(room, rng(seed), 12)
    const bStart = { ...room.startClock }
    const bEnd = room.records.at(-1)?.clockMs
    await room.replay(a.labels)
    const again = snapshot(room)
    const aStart2 = { ...room.startClock }
    // the fallback's price: a module reset and a re-import per schedule
    const resetCost = realMs()
    for (let k = 0; k < 10; k++) {
      vi.resetModules()
      await import("../webrtc/mesh")
    }
    const resetModulesMs = Number(((realMs() - resetCost) / 10).toFixed(2))
    await dispose(room)
    write("S2", {
      schedules: n, watchdogs, fingerprintAtStart: base, fingerprintAtEnd: fingerprint(), changed, badStarts,
      aba: { aLabels: a.labels.length, aEndMs: aEnd, bEndMs: bEnd, bStart, aStart2, identical: again === a.json },
      resetModulesPlusImportMs: resetModulesMs,
      residentRealTimers: liveRealTimers(),
    })
    expect(changed).toEqual([])
    expect(watchdogs).toBe(0)
    expect(badStarts).toEqual([])
    expect(bEnd).not.toBe(aEnd)
    expect(again).toBe(a.json)
    expect(bStart).toEqual({ date: 0, mono: 1 })
    expect(aStart2).toEqual({ date: 0, mono: 1 })
  })

  it("S3 drains each step, catches the negative control, accounts for unowned waits, and fires one timer per label", async () => {
    const depth = Number(process.env.SPIKE_S3_DEPTH ?? 7)
    const unownedDetail = "unowned wait: b>a send-answer (in flight after 50 fair steps)"
    const results: Record<string, unknown> = {}

    // the trap is installed: under real timers the global is the trap, and the
    // room's control (ii) captured that global at load, as code under test would
    vi.useRealTimers()
    results.trapInstalled = globalThis.setTimeout === trapFunctions.setTimeout && globalThis.setInterval === trapFunctions.setInterval
    results.controlUsesTrappedGlobal = capturedRealSetTimeout === trapFunctions.setTimeout
    expect(results.trapInstalled).toBe(true)
    expect(results.controlUsesTrappedGlobal).toBe(true)

    // (c) and (a): without the fixture, no leaf of the tree reports an unowned wait or a watchdog
    const clean = new SpikeRoom(Mesh, monoNow, REJOIN_TWO_OFFERS)
    const cleanTree = await enumerate(clean, [], depth, { checkUnowned: true })
    await dispose(clean)
    results.withoutFixture = summary(cleanTree)
    expect(cleanTree.completed).toBe(true)
    expect(cleanTree.cuts.harness).toBe(0)

    // (b): both variants of the control, every schedule that reaches it
    for (const control of ["never", "real-timer"] as const) {
      const room = new SpikeRoom(Mesh, monoNow, { ...REJOIN_TWO_OFFERS, control })
      // Every schedule that reaches the hung send-answer, before the leaf's
      // check or inside the check's own fair drain (which watches what it
      // issues), ends with exactly the expected details; one that never
      // reaches it reports nothing.
      let reached = 0
      let reachedInCheck = 0
      const wrong: unknown[] = []
      const expected = control === "never" ? [unownedDetail] : [unownedDetail, "real timer: 1"]
      const tree = await enumerate(room, [], depth, {
        checkUnowned: true,
        onLeaf: (r, labels, cut, reachedBefore) => {
          const want = r.controlReached ? expected : []
          if (reachedBefore) reached++
          else if (r.controlReached) reachedInCheck++
          if (JSON.stringify(r.harness) !== JSON.stringify(want) || (want.length > 0) !== (cut === "harness")) wrong.push({ labels, cut, harness: r.harness, reachedBefore })
        },
      })
      await dispose(room)
      results[`control-${control}`] = { ...summary(tree), reached, reachedInCheck, wrong: wrong.slice(0, 5), wrongCount: wrong.length }
      expect(tree.completed).toBe(true)
      expect(reached).toBeGreaterThan(0)
      expect(wrong).toEqual([])
    }
    expect(liveRealTimers()).toBe(0)

    // (d): one timer per label. Mesh a's watchMedia and Mesh b's supervise are
    // both due at 4000 ms (b starts 1000 ms late): two labels, one timer each.
    const room = new SpikeRoom(Mesh, monoNow, REJOIN_TWO_OFFERS)
    await room.reset()
    const at4000 = () => room.dueTimes().filter((t) => t === 4000).length
    const before = at4000()
    while (Date.now() < 4000) await room.step("clock:next")
    const afterFirst = at4000()
    await room.step("clock:next")
    const afterSecond = at4000()
    // and a microtask queued by the first timer runs before the second fires
    const order: string[] = []
    setTimeout(() => { order.push("one"); queueMicrotask(() => order.push("one's microtask")) }, 100_000)
    setTimeout(() => order.push("two"), 100_000)
    while (!order.includes("one")) await room.step("clock:next")
    const afterOne = [...order]
    while (!order.includes("two")) await room.step("clock:next")
    // (e): setImmediate is real under the room's clock
    const immediateFaked = vi.isFakeTimers() && (setImmediate as unknown as { clock?: unknown }).clock !== undefined
    const immediateReal = await new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))
    await dispose(room)
    results.oneTimer = { dueAt4000Before: before, afterFirstLabel: afterFirst, afterSecondLabel: afterSecond, afterOne, order, immediateFaked, immediateReal }
    write("S3", results)
    expect(before).toBe(2)
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(0)
    // the label's drain ran the first timer's microtask; the second timer has not fired
    expect(afterOne).toEqual(["one", "one's microtask"])
    expect(order).toEqual(["one", "one's microtask", "two"])
    expect(immediateReal).toBe(true)
  })

  it("S4 finds P1 or P1b under M1385 at depth <= 14 with the peer actor driving", async () => {
    const results: Record<string, unknown> = {}
    const mutant = await loadMutant(M1385)
    let found: TreeStats["violation"] = null
    let hits: number[] = []
    let tree: TreeStats
    try {
      const mutated = await import("../webrtc/mesh")
      const room = new SpikeRoom(mutated.Mesh, mutated.monoNow, REJOIN_TWO_OFFERS)
      tree = await enumerate(room, M1385_WARMUP, 14, { stopOnViolation: true })
      found = tree.violation
      hits = [...mutant.hits]
      // the witness replays to the same violation, with the actor's commands
      if (found) {
        await room.replay(found.labels)
        results.replay = room.violations[0]?.detail === found.detail
        results.actorCommands = room.records.reduce((sum, record) => sum + record.commands.length, 0)
      }
      await dispose(room)
    } finally {
      await mutant.undo()
    }
    // fixed clean: the witness's labels on the unmutated code
    let fixed: unknown = null
    if (found) {
      const clean = await import("../webrtc/mesh")
      const room = new SpikeRoom(clean.Mesh, clean.monoNow, REJOIN_TWO_OFFERS)
      try {
        await room.replay(found.labels)
        fixed = { violations: room.violations, harness: room.harness }
      } catch (error) {
        fixed = { diverged: (error as Error).message }
      }
      await dispose(room)
    }
    results.run = { found, hunkHits: hits, search: summary(tree!), fixedClean: fixed }
    // later tests import mesh again from the restored graph
    ;({ Mesh, monoNow } = await import("../webrtc/mesh"))
    write("S4", results)
    // every hunk ran
    for (const count of hits) expect(count).toBeGreaterThan(0)
    // fixed clean: on unmutated code the witness diverges (a label is not enabled) or replays with no P1/P1b
    const clean = (fixed ?? {}) as { diverged?: string; violations?: { property: string }[] }
    if (clean.diverged === undefined) expect((clean.violations ?? []).filter((v) => v.property === "P1" || v.property === "P1b")).toEqual([])
    else expect(clean.diverged).toMatch(/^label not enabled at step \d+:/)
    expect(found?.depth).toBeLessThanOrEqual(14)
    expect(["P1", "P1b"]).toContain(found?.property)
    expect(results.replay).toBe(true)
    expect(results.actorCommands).toBeGreaterThan(0)
  })

  it("S5 closes the rejoin-two-offers tree and reports leaves, mean enabled labels and cuts per depth", async () => {
    const budgetMin = Number(process.env.SPIKE_S5_BUDGET_MIN ?? 60)
    const deadline = realMs() + budgetMin * 60_000
    const room = new SpikeRoom(Mesh, monoNow, REJOIN_TWO_OFFERS)
    // the unowned-wait check over one closed depth: every leaf, not only quiet ones
    const checkedDepth = 8
    const checked = await enumerate(room, [], checkedDepth, { checkUnowned: true })
    expect(checked.completed).toBe(true)
    expect(checked.cuts.harness).toBe(0)
    const perDepth: ReturnType<typeof summary>[] = []
    let closedAtDepth = 0
    for (let depth = 1; realMs() < deadline; depth++) {
      const tree = await enumerate(room, [], depth, { deadline })
      perDepth.push(summary(tree))
      if (!tree.completed) break
      expect(tree.cuts.harness).toBe(0)
      closedAtDepth = depth
      process.stderr.write(`[spike] S5 d=${depth} leaves=${tree.leaves} ${tree.elapsedMs} ms heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}MB\n`)
    }
    await dispose(room)
    // projection: the last two closed depths' growth, 14 workers, the same budget
    const closed = perDepth.filter((row) => row.closed)
    const last = closed.at(-1)!
    const prev = closed.at(-2)!
    const growth = last.elapsedMs / Math.max(1, prev.elapsedMs)
    let projected = last.depth
    for (let ms = last.elapsedMs * growth; ms <= budgetMin * 60_000 * 14; ms *= growth) projected++
    write("S5", {
      scenario: { ...REJOIN_TWO_OFFERS, stats: "auto" }, budgetMin, closedAtDepth, perDepth,
      unownedCheck: { ...summary(checked), note: "every leaf of d <= 8 ran the unowned-wait check; deeper levels ran it at quiet leaves only (there were none)" },
      projection: { workers: 14, timeGrowthPerDepth: Number(growth.toFixed(3)), projectedClosedDepth: projected },
      violations: perDepth.reduce((sum, row) => sum + row.cuts.violation, 0),
      verdict: `${perDepth.some((row) => row.cuts.violation > 0) ? "violations found" : "clean"} (P1, P1b) at d = ${closedAtDepth}, F = ${REJOIN_TWO_OFFERS.faults}, H = ${REJOIN_TWO_OFFERS.horizonMs / 1000}s (closed), T0 minimal room; unowned-wait check on every leaf at d <= ${checkedDepth}, at quiet leaves only beyond`,
    })
    expect(closedAtDepth).toBeGreaterThanOrEqual(8)
  })
})
