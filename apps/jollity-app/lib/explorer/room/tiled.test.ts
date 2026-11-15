// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { EventEmitter } from "node:events"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { roomBfs } from "./bfs"
import { roomAnchor } from "./checks"
import { roomKeyParts, stateIdOf } from "./key"
import { decodeRecords, emptyCounts, encodeRecord, ID_BYTES, journalLines, MeshWorkerPool, paths, runTiled, STEP_BYTES, tileOf, TileWorker, type TiledResult } from "./tiled"

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "room-tiled-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const shape = (result: TiledResult) => ({
  layers: result.layers.map((layer) => [layer.depth, layer.states, layer.added, layer.distinctPairs]),
  pairs: result.distinctPairsPerPosition,
  edges: result.counts.edges,
  faultCuts: result.counts.faultCuts,
  findings: result.counts.findingCounts,
  inclusion: [result.counts.inclusion.checked, result.counts.inclusion.mismatches, result.counts.inclusion.skipped],
  gaps: result.counts.gaps.count,
  probes: result.counts.probes,
})

const base = { run: "network-all" as const, depth: 4, tiles: 8, pairShards: 4, inclusionEvery: 10, probeEvery: 50, workers: 0 }

describe("the tiled map", () => {
  it("puts a state in the same tile every time", () => {
    const id = Uint8Array.from({ length: 16 }, (_, at) => at * 17)
    // bytes 4..7 = 0x44 0x55 0x66 0x77
    expect(tileOf(id, 256)).toBe(0x77)
    expect(tileOf(id, 1000)).toBe(0x44556677 % 1000)
    const anchor = roomAnchor(3, "reload", 1).room
    const a = stateIdOf(roomKeyParts(anchor))
    const b = stateIdOf(roomKeyParts(roomAnchor(3, "reload", 1).room))
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    expect(tileOf(a, 256)).toBe(tileOf(b, 256))
    // the id holds faultsLeft: the same rooms with another budget are another state
    expect(Buffer.from(stateIdOf(roomKeyParts({ ...anchor, faultsLeft: 0 }))).equals(Buffer.from(a))).toBe(false)
  })

  it("reads back an inbox exactly as written", () => {
    const records = [0, 1, 2].map((n) => ({ id: Uint8Array.from({ length: ID_BYTES }, (_, at) => (at + n * 31) & 0xff), path: Uint8Array.from([0, n, 1, 44, n, 0]) }))
    const buffer = Buffer.concat(records.map((record) => encodeRecord(record.id, record.path)))
    expect(buffer.length).toBe(3 * (ID_BYTES + 3 * STEP_BYTES))
    const back = [...decodeRecords(buffer, 3)]
    expect(back.map((record) => [[...record.id], [...record.path]])).toEqual(records.map((record) => [[...record.id], [...record.path]]))
    expect(() => [...decodeRecords(buffer.subarray(1), 3)]).toThrow(/whole/)
  })

  it("matches the in-memory BFS (key sampling) layer for layer, finding for finding", async () => {
    const tiled = await runTiled({ ...base, out: scratch() })
    const anchor = roomAnchor(3, "network-all", 1)
    const bfs = roomBfs(anchor.room, { depth: 4, maxStates: 1e6, inclusionEvery: 10, probeEvery: 50, sampling: "key" })
    expect(tiled.layers.map((layer) => [layer.depth, layer.states, layer.added, layer.distinctPairs])).toEqual(bfs.layers.map((layer) => [layer.depth, layer.states, layer.added, layer.distinctPairs]))
    expect(tiled.distinctPairsPerPosition).toEqual(bfs.distinctPairsPerPosition)
    expect(tiled.counts.edges).toBe(bfs.edges)
    expect(tiled.counts.faultCuts).toBe(bfs.faultCuts)
    expect(tiled.counts.findingCounts).toEqual(bfs.findingCounts)
    expect([tiled.counts.inclusion.checked, tiled.counts.inclusion.skipped, tiled.counts.inclusion.mismatches]).toEqual([bfs.inclusion.checked, bfs.inclusion.skipped, bfs.inclusion.mismatches])
    expect(tiled.counts.gaps.count).toBe(bfs.gaps.count)
    expect(tiled.counts.probes).toEqual(bfs.probes)
    expect(tiled.counts.probes.run).toBeGreaterThan(0)
    expect(tiled.counts.inclusion.checked).toBeGreaterThan(0)
  }, 120_000)

  it("answers an id already explored from the explored set, and redoing a tile changes nothing", async () => {
    const out = scratch()
    await runTiled({ ...base, depth: 3, out, keepInboxes: true })
    const files = paths(out)
    const tiles = readdirSync(files.inboxDir(3)).map((name) => Number(name.slice(1, 6)))
    const before = tiles.map((tile) => readFileSync(files.explored(tile, 3)))
    // a worker that never ran here redoes depth 3's tiles: the same explored files
    const again = new TileWorker(out, 7)
    for (const tile of tiles) await again.processTile(3, tile)
    expect(tiles.map((tile) => readFileSync(files.explored(tile, 3)))).toEqual(before)
    // an inbox record for a state explored at depth 2 is answered, not explored again
    const tile = tiles.find((t) => existsSync(files.explored(t, 2)) && readFileSync(files.explored(t, 2)).length > 0)!
    const known = readFileSync(files.explored(tile, 2)).subarray(0, ID_BYTES)
    const record = encodeRecord(known, new Uint8Array(3 * STEP_BYTES))
    appendFileSync(files.inbox(3, tile, "test"), record)
    const { counts } = await again.processTile(3, tile)
    expect(counts.answered).toBeGreaterThan(0)
    expect(readFileSync(files.explored(tile, 3))).toEqual(before[tiles.indexOf(tile)])
  }, 120_000)

  it("resumes a stopped run and a tile that died before its commit, to the same counts", async () => {
    const whole = shape(await runTiled({ ...base, out: scratch() }))

    // stopped between tiles (as a kill between commits), then resumed
    const stopped = scratch()
    const first = await runTiled({ ...base, out: stopped, stopAfterTiles: 12 })
    expect(first.stopped).toBe(true)
    const resumed = await runTiled({ ...base, out: stopped })
    expect(resumed.layers.some((layer) => layer.resumed)).toBe(true)
    expect(shape(resumed)).toEqual(whole)

    // a tile writes its children and dies before its journal line: the next run cuts them back and redoes it
    const torn = scratch()
    await expect(runTiled({ ...base, out: torn, failTileAt: 14 })).rejects.toThrow(/failBeforeCommit/)
    // a torn journal line from a kill mid-write is ignored too
    appendFileSync(join(torn, "journal", readdirSync(join(torn, "journal")).sort().at(-1)!), '{"tile":')
    expect(shape(await runTiled({ ...base, out: torn }))).toEqual(whole)
  }, 240_000)

  it("counts a tile once when its worker commits and dies before the done message", async () => {
    const whole = shape(await runTiled({ ...base, out: scratch() }))
    const marker = join(scratch(), "died-once")
    process.env.TILED_TEST_EXIT_AFTER_COMMIT = marker
    try {
      const pooled = await runTiled({ ...base, workers: 1, workerEntry: join(__dirname, "tiled-main.ts"), out: scratch() })
      expect(existsSync(marker)).toBe(true)
      expect(shape(pooled)).toEqual(whole)
    } finally {
      delete process.env.TILED_TEST_EXIT_AFTER_COMMIT
    }
  }, 240_000)

  it("extends a finished run deeper without recomputing a depth, to a fresh run's counts", async () => {
    const fresh = await runTiled({ ...base, out: scratch() })
    const out = scratch()
    const shallow = await runTiled({ ...base, depth: 3, out })
    expect(shallow.depthCompleted).toBe(3)
    const files = paths(out)
    // a tile only has an explored file at the depths it received states at, so take one that has depth 2's
    const tile = readdirSync(join(out, "tiles")).map((name) => Number(name.slice(1))).find((t) => existsSync(files.explored(t, 2)))!
    const before = readFileSync(files.explored(tile, 2))
    const deeper = await runTiled({ ...base, depth: 4, out })
    expect(shape(deeper)).toEqual(shape(fresh))
    expect(deeper.meta.extended).toEqual([3])
    // depths 1..3 come from the markers: the extension ran only the d003x stage and depth 4
    const stages = readdirSync(join(out, "journal")).map((name) => name.split(".")[0]).filter((name, at, all) => all.indexOf(name) === at).sort()
    expect(stages).toEqual(["d000", "d001", "d002", "d003", "d003x", "d004"])
    expect(readFileSync(files.explored(tile, 2))).toEqual(before)
    const progress = readFileSync(files.progress, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { depth: number; extension?: boolean; spreadToNext: { sameTileShare: number } | null })
    expect(progress.map((line) => `${line.depth}${line.extension ? "x" : ""}`)).toEqual(["1", "2", "3", "3x", "4"])
    expect(progress.find((line) => line.extension)!.spreadToNext).not.toBeNull()
  }, 240_000)

  it("reads a depth's journal lines in tile order, whichever worker committed each", () => {
    const out = scratch()
    mkdirSync(join(out, "journal"))
    const line = (tile: number, property: string, complete?: boolean) => {
      const counts = emptyCounts()
      counts.findings.push({ property, detail: `tile ${tile}`, labels: [] })
      return `${JSON.stringify({ tile, lengths: {}, counts, ...(complete === undefined ? {} : { complete }) })}\n`
    }
    // a queue let w000 take tile 5 and w001 tiles 2 and 7; tile 2 also has an earlier partial line on w000
    writeFileSync(paths(out).journal(3, 0), line(2, "p", false) + line(5, "p"))
    writeFileSync(paths(out).journal(3, 1), line(7, "p") + line(2, "p"))
    expect(journalLines(out, 3).map((entry) => entry.tile)).toEqual([2, 5, 7])
  })

  it("refuses to resume or extend with other bounds or another key format", async () => {
    const out = scratch()
    await runTiled({ ...base, depth: 2, out })
    await expect(runTiled({ ...base, depth: 3, faults: 2, out })).rejects.toThrow(/started with faults=1, not 2/)
    await expect(runTiled({ ...base, depth: 3, tiles: 16, out })).rejects.toThrow(/started with tiles=8, not 16/)
    // another engine assignment (model.ts Phone.rtxUnsafe) is another run
    process.env.ROOM_RTX_UNSAFE = "0"
    try {
      await expect(runTiled({ ...base, depth: 3, out })).rejects.toThrow(/started with rtxUnsafe=undefined, not 0/)
    } finally {
      delete process.env.ROOM_RTX_UNSAFE
    }
    const meta = JSON.parse(readFileSync(paths(out).meta, "utf8")) as Record<string, unknown>
    writeFileSync(paths(out).meta, JSON.stringify({ ...meta, keyFormat: undefined }))
    await expect(runTiled({ ...base, depth: 3, out })).rejects.toThrow(/key format 1 .*cannot be resumed or extended/)
    writeFileSync(paths(out).meta, JSON.stringify({ ...meta, anchorId: "00" }))
    await expect(runTiled({ ...base, depth: 3, out })).rejects.toThrow(/anchor 00/)
  }, 120_000)
})

describe("the mesh pool's close", () => {
  /** A ChildProcess stand-in: close() only reads pid/exitCode/signalCode, listens for "exit", and calls kill(). */
  const fakeChild = (pid: number) => {
    const child = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(),
    })
    return child
  }
  const poolWith = (children: ReturnType<typeof fakeChild>[]) => {
    const pool = new MeshWorkerPool(scratch(), 1, 1_000)
    // close() only ever reads this set; the pool spawns through runDepth, which a fake child stands in for
    for (const child of children) (pool as unknown as { children: Set<typeof child> }).children.add(child)
    return pool
  }
  const signals = () => (process.kill as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => [call[0], call[1]])

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("sends no SIGKILL once the child exits after SIGTERM", async () => {
    vi.useFakeTimers()
    vi.spyOn(process, "kill").mockImplementation(() => true)
    const child = fakeChild(4242)
    const pool = poolWith([child])
    const closed = pool.close()
    // the child takes the SIGTERM and goes
    child.emit("exit", 0, null)
    await closed
    expect(signals()).toEqual([[-4242, "SIGTERM"]])
    await vi.advanceTimersByTimeAsync(10_000)
    // the process group may hold a reused pid by now: nothing is signalled a second time
    expect(signals()).toEqual([[-4242, "SIGTERM"]])
  })

  it("sends SIGKILL at 10 s to a child that does not exit", async () => {
    vi.useFakeTimers()
    vi.spyOn(process, "kill").mockImplementation(() => true)
    const child = fakeChild(4343)
    const pool = poolWith([child])
    const closed = pool.close()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signals()).toEqual([[-4343, "SIGTERM"]])
    await vi.advanceTimersByTimeAsync(1)
    expect(signals()).toEqual([[-4343, "SIGTERM"], [-4343, "SIGKILL"]])
    child.emit("exit", null, "SIGKILL")
    await closed
  })
})

describe("the pair shards and tiles defaults", () => {
  it("gives a new run 64 pair shards and 1024 tiles and lets a resume keep the ones it was started with", async () => {
    const fresh = scratch()
    await runTiled({ ...base, pairShards: undefined, tiles: undefined, depth: 1, out: fresh })
    expect(JSON.parse(readFileSync(paths(fresh).meta, "utf8")).pairShards).toBe(64)
    expect(JSON.parse(readFileSync(paths(fresh).meta, "utf8")).tiles).toBe(1024)
    await runTiled({ ...base, pairShards: undefined, tiles: undefined, depth: 2, out: fresh })

    // a store started with 16 shards (the old default) resumes and extends with no flag
    const old = scratch()
    await runTiled({ ...base, pairShards: 16, depth: 1, out: old })
    await runTiled({ ...base, pairShards: undefined, tiles: undefined, depth: 2, out: old })
    expect(JSON.parse(readFileSync(paths(old).meta, "utf8")).pairShards).toBe(16)
    expect(JSON.parse(readFileSync(paths(old).meta, "utf8")).tiles).toBe(8)
    // an explicit other value is still refused
    await expect(runTiled({ ...base, pairShards: 64, depth: 3, out: old })).rejects.toThrow(/started with pairShards=16, not 64/)
  }, 120_000)
})

describe("the mesh tile worker", () => {
  // A vi.spyOn(console, "log") keeps every call in its mock history: one worker grew by tens of MB per
  // 1,000 states until it was killed or recycled (#1631). The worker silences with silenceConsoleLog.
  it("silences console.log without a call-recording spy", () => {
    const source = readFileSync(join(import.meta.dirname, "tiled-worker.explore.ts"), "utf8")
    expect(source).not.toMatch(/spyOn\(\s*console/)
    expect(source).toContain("silenceConsoleLog()")
  })
})
