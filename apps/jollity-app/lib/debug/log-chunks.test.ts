// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { createChunkStore, RING_SLOTS, type ChunkKV, type ChunkRead } from "./log-chunks"

interface Row {
  ts: number
  size: number
}

/** a string store that outlives every "page", with switchable faults */
function fakeKV() {
  const values = new Map<string, string>()
  const faults = { failReads: false, failWrites: false, failKey: null as string | null }
  const writes: { key: string; value: string }[] = []
  const kv: ChunkKV = {
    async read(key): Promise<ChunkRead> {
      if (faults.failReads || faults.failKey === key) return { ok: false }
      return { ok: true, value: values.get(key) ?? null }
    },
    async write(key, value) {
      if (faults.failWrites) throw new Error("quota")
      writes.push({ key, value })
      values.set(key, value)
    },
  }
  return { kv, values, faults, writes }
}

const rows = (from: number, count: number, size = 100): Row[] => Array.from({ length: count }, (_, i) => ({ ts: from + i, size }))
const chunkKeys = (values: Map<string, string>) => [...values.keys()].filter((key) => key.includes(".chunk."))

describe("the chunk store", () => {
  it("round-trips entries across a restart (a new store over the same keys)", async () => {
    const { kv } = fakeKV()
    const first = createChunkStore<Row>(kv)
    expect(await first.load()).toBe(true)
    await first.append(rows(1000, 30))
    const second = createChunkStore<Row>(kv)
    expect(await second.load()).toBe(true)
    const read = await second.read()
    expect(read?.complete).toBe(true)
    expect(read?.entries.map((entry) => entry.ts)).toEqual(rows(1000, 30).map((entry) => entry.ts))
  })

  it("is append-only: a flush writes one new chunk key plus the index, and never rewrites an old chunk", async () => {
    const { kv, writes } = fakeKV()
    const store = createChunkStore<Row>(kv)
    await store.load()
    await store.append(rows(1, 5))
    await store.append(rows(10, 5))
    await createChunkStore<Row>(kv).load()
    const chunkWrites = writes.filter((write) => write.key.includes(".chunk.")).map((write) => write.key)
    expect(chunkWrites).toEqual(["jollity.debug-log.chunk.0", "jollity.debug-log.chunk.1"])
    expect(writes.filter((write) => write.key.endsWith(".index"))).toHaveLength(2)
    // the index is tiny: it does not grow with the log
    expect(writes.at(-1)!.value.length).toBeLessThan(60)
  })

  it("starts a fresh chunk on every load, never reopening the last one", async () => {
    const { kv, values } = fakeKV()
    for (let page = 0; page < 3; page++) {
      const store = createChunkStore<Row>(kv)
      await store.load()
      await store.append(rows(page * 10, 2))
    }
    expect(chunkKeys(values)).toHaveLength(3)
  })

  it("cuts a big batch into chunks of the target size", async () => {
    const { kv, values } = fakeKV()
    const store = createChunkStore<Row>(kv, { chunkBytes: 1000 })
    await store.load()
    await store.append(rows(1, 100, 100))
    expect(chunkKeys(values).length).toBeGreaterThan(5)
    for (const key of chunkKeys(values)) {
      const chunk = JSON.parse(values.get(key)!) as { entries: Row[] }
      expect(chunk.entries.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThanOrEqual(1000)
    }
    expect((await store.read())?.entries).toHaveLength(100)
  })

  it("overwrites the oldest slot once the ring is full, oldest first", async () => {
    const { kv, values } = fakeKV()
    const store = createChunkStore<Row>(kv)
    await store.load()
    const total = RING_SLOTS + 10
    for (let i = 0; i < total; i++) await store.append([{ ts: i, size: 100 }])
    expect(chunkKeys(values)).toHaveLength(RING_SLOTS)
    const read = await store.read()
    expect(read?.complete).toBe(true)
    expect(read?.entries).toHaveLength(RING_SLOTS)
    expect(read?.entries[0].ts).toBe(10)
    expect(read?.entries.at(-1)?.ts).toBe(total - 1)
  })

  it("reads a time window", async () => {
    const { kv } = fakeKV()
    const store = createChunkStore<Row>(kv, { chunkBytes: 1000 })
    await store.load()
    await store.append(rows(0, 100, 100))
    const read = await store.read(20, 30)
    expect(read?.entries.map((entry) => entry.ts)).toEqual(rows(20, 10).map((entry) => entry.ts))
  })

  it("never writes after a failed index read, and read() says so", async () => {
    const { kv, faults, writes } = fakeKV()
    const seed = createChunkStore<Row>(kv)
    await seed.load()
    await seed.append(rows(1, 5))
    writes.length = 0
    faults.failReads = true
    const store = createChunkStore<Row>(kv)
    expect(await store.load()).toBe(false)
    await store.append(rows(100, 5))
    expect(writes).toHaveLength(0)
    expect(await store.read()).toBeNull()
    faults.failReads = false
    expect((await createChunkStore<Row>(kv).read())?.entries).toHaveLength(5)
  })

  it("leaves an unparseable index alone", async () => {
    const { kv, values, writes } = fakeKV()
    values.set("jollity.debug-log.index", "not json")
    const store = createChunkStore<Row>(kv)
    expect(await store.load()).toBe(false)
    await store.append(rows(1, 3))
    expect(writes).toHaveLength(0)
  })

  it("treats an absent index as an empty store (the host answers \"\" for a missing key)", async () => {
    const { kv, values } = fakeKV()
    values.set("jollity.debug-log.index", "")
    const store = createChunkStore<Row>(kv)
    expect(await store.load()).toBe(true)
    expect((await store.read())?.entries).toEqual([])
  })

  it("derives the oldest live seq when the index does not say", async () => {
    const { kv, values } = fakeKV()
    values.set("jollity.debug-log.index", JSON.stringify({ next: RING_SLOTS + 5 }))
    const store = createChunkStore<Row>(kv)
    expect(await store.load()).toBe(true)
    // every slot is absent: all RING_SLOTS reads are tried, none is stale-trusted
    expect((await store.read())?.complete).toBe(false)
  })

  it("skips a stale or unreadable chunk and reports the read incomplete", async () => {
    const { kv, values, faults } = fakeKV()
    const store = createChunkStore<Row>(kv, { chunkBytes: 300 })
    await store.load()
    await store.append(rows(0, 9, 100))
    values.set("jollity.debug-log.chunk.1", JSON.stringify({ seq: 99, first: 500, last: 502, entries: rows(500, 3) }))
    const stale = await store.read()
    expect(stale?.complete).toBe(false)
    expect(stale?.entries.map((entry) => entry.ts)).toEqual([0, 1, 2, 6, 7, 8])
    faults.failKey = "jollity.debug-log.chunk.0"
    expect((await store.read())?.complete).toBe(false)
  })

  it("swallows a failing write and keeps going on the next batch", async () => {
    const { kv, faults } = fakeKV()
    const store = createChunkStore<Row>(kv)
    await store.load()
    faults.failWrites = true
    await expect(store.append(rows(1, 3))).resolves.toBeUndefined()
    faults.failWrites = false
    await store.append(rows(10, 3))
    expect((await store.read())?.entries.map((entry) => entry.ts)).toEqual([10, 11, 12])
  })

  it("clear forgets every entry and keeps counting seqs forward", async () => {
    const { kv } = fakeKV()
    const store = createChunkStore<Row>(kv)
    await store.load()
    await store.append(rows(1, 5))
    await store.clear()
    expect((await store.read())?.entries).toEqual([])
    await store.append(rows(50, 2))
    expect((await createChunkStore<Row>(kv).read())?.entries.map((entry) => entry.ts)).toEqual([50, 51])
  })

  describe("advanceOldest", () => {
    it("drops whole chunks older than the cut with a single index write", async () => {
      const { kv, writes } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      for (let i = 1; i <= 5; i++) await store.append([{ ts: i, size: 100 }])
      writes.length = 0
      expect(await store.advanceOldest(4)).toBe(true)
      expect(writes).toHaveLength(1)
      expect(writes[0].key).toBe("jollity.debug-log.index")
      expect((await store.read())?.entries.map((entry) => entry.ts)).toEqual([4, 5])
      // the advanced pointer survives a restart
      const reloaded = createChunkStore<Row>(kv)
      await reloaded.load()
      expect((await reloaded.read())?.entries.map((entry) => entry.ts)).toEqual([4, 5])
    })

    it("keeps a chunk that straddles the cut whole", async () => {
      const { kv, writes } = fakeKV()
      const store = createChunkStore<Row>(kv, { chunkBytes: 1000 })
      await store.load()
      await store.append(rows(1, 10, 100))
      writes.length = 0
      expect(await store.advanceOldest(5)).toBe(false)
      expect(writes).toHaveLength(0)
      expect((await store.read())?.entries).toHaveLength(10)
    })

    it("keeps a chunk with any line at or past the cut, even after a backward clock step", async () => {
      const { kv, writes } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      await store.append([1000, 1005, 900, 950].map((ts) => ({ ts, size: 100 })))
      writes.length = 0
      expect(await store.advanceOldest(1001)).toBe(false)
      expect(writes).toHaveLength(0)
      expect((await store.read())?.entries.map((entry) => entry.ts)).toEqual([1000, 1005, 900, 950])
    })

    it("empties the ring when the cut is past every chunk", async () => {
      const { kv } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      await store.append(rows(1, 3, 100))
      await store.append(rows(10, 3, 100))
      expect(await store.advanceOldest(1000)).toBe(true)
      expect((await store.read())?.entries).toEqual([])
    })

    it("refuses to advance across a chunk that cannot be read", async () => {
      const { kv, values, writes } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      await store.append(rows(1, 3, 100))
      await store.append(rows(10, 3, 100))
      values.set("jollity.debug-log.chunk.0", "{not json")
      writes.length = 0
      expect(await store.advanceOldest(10)).toBe(false)
      expect(writes).toHaveLength(0)
    })

    it("never moves the pointer below what the ring itself evicted", async () => {
      const { kv } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      for (let i = 0; i < RING_SLOTS + 10; i++) await store.append([{ ts: i, size: 100 }])
      const oldest = (await store.read())!.entries[0].ts
      expect(await store.advanceOldest(0)).toBe(false)
      expect((await store.read())!.entries[0].ts).toBe(oldest)
    })

    it("an append after an advance never rewinds the pointer", async () => {
      const { kv } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      for (let i = 1; i <= 4; i++) await store.append([{ ts: i, size: 100 }])
      await store.advanceOldest(4)
      await store.append([{ ts: 100, size: 100 }])
      const reloaded = createChunkStore<Row>(kv)
      await reloaded.load()
      expect((await reloaded.read())?.entries.map((entry) => entry.ts)).toEqual([4, 100])
    })

    it("a clear still wins over a later advance", async () => {
      const { kv } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      await store.append(rows(1, 3, 100))
      await store.clear()
      expect(await store.advanceOldest(2)).toBe(false)
      expect((await store.read())?.entries).toEqual([])
    })

    it("a commit guard can cancel the index write after the scan", async () => {
      const { kv, writes } = fakeKV()
      const store = createChunkStore<Row>(kv)
      await store.load()
      await store.append(rows(1, 3, 100))
      writes.length = 0
      expect(await store.advanceOldest(10, () => false)).toBe(false)
      expect(writes).toHaveLength(0)
      expect((await store.read())?.entries).toHaveLength(3)
    })
  })
})
