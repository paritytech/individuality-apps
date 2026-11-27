// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KEY_PREFIX, RING_SLOTS, type ChunkKV, type ChunkRead } from "./log-chunks"
import { createHostPersist, FLUSH_INTERVAL_MS, RELEASE_READ_MS } from "./host-persist"

interface Row {
  ts: number
  size: number
  sessionId: string
}

function fakeKV() {
  const values = new Map<string, string>()
  const state = { failReads: false, hangChunkReads: false, chunkGate: null as Promise<void> | null, writes: 0 }
  const kv: ChunkKV = {
    async read(key): Promise<ChunkRead> {
      if (state.hangChunkReads && key.includes(".chunk.")) return new Promise(() => {})
      if (state.chunkGate && key.includes(".chunk.")) await state.chunkGate
      return state.failReads ? { ok: false } : { ok: true, value: values.get(key) ?? null }
    },
    async write(key, value) {
      state.writes += 1
      values.set(key, value)
    },
  }
  return { kv, state, values }
}

const row = (ts: number, sessionId = "a"): Row => ({ ts, size: 100, sessionId })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the host persister", () => {
  it("takes nothing before the game window opens", async () => {
    const { kv, state } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.enqueue(row(1))
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 2)
    expect(state.writes).toBe(0)
    persist.activate()
    persist.enqueue(row(2))
    await persist.flushNow()
    expect((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([2])
  })

  it("writes a flush interval's lines as one chunk, not per line", async () => {
    const { kv, state } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    for (let i = 0; i < 20; i++) persist.enqueue(row(i))
    expect(state.writes).toBe(0)
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS + 10)
    expect(state.writes).toBe(2)
  })

  it("flushes at an interval from the first queued line, even under steady logging", async () => {
    const { kv, state } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    for (let t = 0; t < FLUSH_INTERVAL_MS + 1000; t += 500) {
      persist.enqueue(row(t))
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(state.writes).toBeGreaterThanOrEqual(2)
  })

  it("holds lines logged before the load finished and writes them after", async () => {
    const { kv } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    persist.activate()
    const started = persist.start()
    persist.enqueue(row(1))
    await started
    await persist.flushNow()
    expect((await persist.readEarlier(undefined, undefined, "other"))?.map((entry) => entry.ts)).toEqual([1])
  })

  it("reads the earlier sessions only", async () => {
    const { kv } = fakeKV()
    const first = createHostPersist<Row>(kv)
    await first.start()
    first.activate()
    first.enqueue(row(1, "dead"))
    first.enqueue(row(2, "live"))
    await first.flushNow()
    const second = createHostPersist<Row>(kv)
    expect((await second.readEarlier(undefined, undefined, "live"))?.map((entry) => entry.ts)).toEqual([1])
  })

  it("retries the load on every flush, writes nothing while unread, then writes what it held", async () => {
    const { kv, state } = fakeKV()
    state.failReads = true
    const persist = createHostPersist<Row>(kv)
    expect(await persist.start()).toBe(false)
    persist.activate()
    persist.enqueue(row(1))
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 2)
    expect(state.writes).toBe(0)
    expect(await persist.readEarlier(undefined, undefined, "x")).toBeNull()
    state.failReads = false
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS)
    expect(state.writes).toBe(2)
  })

  it("clear empties the store and switches queueing off until the next activate", async () => {
    const { kv } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    await persist.flushNow()
    await persist.clear()
    expect(persist.active).toBe(false)
    persist.enqueue(row(2))
    await persist.flushNow()
    expect(await persist.readEarlier(undefined, undefined, "x")).toEqual([])
  })

  it("deactivate stops queueing and keeps what is stored", async () => {
    const { kv } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    await persist.flushNow()
    persist.deactivate()
    expect(persist.active).toBe(false)
    persist.enqueue(row(2))
    await persist.flushNow()
    expect((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([1])
  })

  it("release drops the lines before the cut and keeps the rest, the queue and queueing", async () => {
    const { kv } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    persist.enqueue(row(2))
    await persist.flushNow()
    persist.enqueue(row(3))
    await persist.flushNow()
    persist.enqueue(row(4))
    await persist.release(3)
    expect(persist.active).toBe(true)
    await persist.flushNow()
    expect((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([3, 4])
  })

  it("loses no batch flushed while a release runs", async () => {
    const { kv } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    await persist.flushNow()
    const releasing = persist.release(2)
    persist.enqueue(row(5))
    const flushing = persist.flushNow()
    await Promise.all([releasing, flushing])
    expect((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([5])
  })

  it("leaves the store untouched when a stored chunk cannot be read", async () => {
    const { kv, values } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    await persist.flushNow()
    persist.enqueue(row(2))
    await persist.flushNow()
    values.set(`${KEY_PREFIX}.chunk.0`, "{not json")
    const before = new Map(values)
    await persist.release(2)
    expect(values).toEqual(before)
  })

  it("keeps a ring that is never released inside its fixed slots across several games", async () => {
    const { kv, values } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    for (let flush = 0; flush < RING_SLOTS * 3; flush++) {
      for (let line = 0; line < 50; line++) persist.enqueue({ ts: flush * 100 + line, size: 1_000, sessionId: "a" })
      await persist.flushNow()
    }
    expect(values.size).toBeLessThanOrEqual(RING_SLOTS + 1)
    const kept = (await persist.readEarlier(undefined, undefined, "x"))!
    expect(kept.length).toBeLessThan(RING_SLOTS * 3 * 50)
    expect(kept.at(-1)?.ts).toBe((RING_SLOTS * 3 - 1) * 100 + 49)
  })

  it("keeps writing new lines while a release's read never answers, and never writes late", async () => {
    const { kv, state } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    await persist.flushNow()
    state.hangChunkReads = true
    // the release promise resolves once its RELEASE_READ_MS budget expires,
    // whether or not the hung scan ever answered — flushes queued behind it
    // must not wait on it forever
    const releasing = persist.release(2)
    persist.enqueue(row(5))
    const flushing = persist.flushNow()
    await vi.advanceTimersByTimeAsync(RELEASE_READ_MS + 10)
    await Promise.all([releasing, flushing])
    // the timed-out release wrote no index at all: ts 1 is still there
    state.hangChunkReads = false
    expect((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([1, 5])
  })

  it("never shows a reader a torn ring while a release advances the pointer", async () => {
    const { kv } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    persist.enqueue(row(3))
    await persist.flushNow()
    const releasing = persist.release(2)
    const reads: Array<number[] | undefined> = []
    for (let tick = 0; tick < 20; tick++) {
      reads.push((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts))
    }
    await releasing
    // every read sees a whole ring: either the pre-release one or the advanced
    // one, never a mix — the index write is atomic
    expect(reads.every((ts) => ts !== undefined && ts.includes(3))).toBe(true)
  })

  it("release advances the ring's oldest pointer: one index write, no chunk rewrite", async () => {
    const { kv, state, values } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    // five flushed batches = five chunks, so a clear+rewrite release would
    // rewrite every kept chunk
    for (let batch = 1; batch <= 5; batch++) {
      persist.enqueue(row(batch * 10))
      await persist.flushNow()
    }
    const writesBefore = state.writes
    await persist.release(35)
    // exactly one write: the advanced index
    expect(state.writes - writesBefore).toBe(1)
    const index = JSON.parse(values.get(`${KEY_PREFIX}.index`)!) as { next: number; oldest: number }
    expect(index.oldest).toBe(3)
    // the old lines read as gone, the kept ones intact, across a restart too
    expect((await persist.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([40, 50])
    const reloaded = createHostPersist<Row>(kv)
    await reloaded.start()
    expect((await reloaded.readEarlier(undefined, undefined, "x"))?.map((entry) => entry.ts)).toEqual([40, 50])
  })

  it("release still drops nothing when a stored chunk cannot be read (no rewrite either)", async () => {
    const { kv, values, state } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    await persist.flushNow()
    persist.enqueue(row(2))
    await persist.flushNow()
    values.set(`${KEY_PREFIX}.chunk.0`, "{not json")
    const before = new Map(values)
    const writesBefore = state.writes
    await persist.release(2)
    expect(state.writes).toBe(writesBefore)
    expect(values).toEqual(before)
  })

  it("lets a clear win permanently over a release whose read is still in flight", async () => {
    const { kv, state } = fakeKV()
    const persist = createHostPersist<Row>(kv)
    await persist.start()
    persist.activate()
    persist.enqueue(row(1))
    persist.enqueue(row(3))
    await persist.flushNow()
    let open: () => void = () => {}
    state.chunkGate = new Promise<void>((resolve) => (open = resolve))
    const releasing = persist.release(2)
    await vi.advanceTimersByTimeAsync(0)
    const clearing = persist.clear()
    state.chunkGate = null
    open()
    await Promise.all([releasing, clearing])
    expect(await persist.readEarlier(undefined, undefined, "x")).toEqual([])
  })
})
