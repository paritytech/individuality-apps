// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The debug log's persistent store for a host: a ring of small, immutable,
 * append-only chunk keys plus a tiny index key, over any string key-value store
 * (host storage in a container, lib/host/storage.ts), so a game's log survives
 * a restart.
 *
 * WHY: every host container deletes `window.indexedDB` (the web container and
 * the iOS and Android ones alike), so lib/debug/telemetry.ts has no IndexedDB
 * store to lean on and a restart would lose the log. Host storage DOES persist
 * per product.
 *
 * LIMITS: TrUAPI's `LocalStorage` API states no size cap on a value or on the
 * total; its only failure is `Full` ("storage quota exhausted"). A value
 * crosses the wire hex-encoded, so it costs twice its bytes
 * (@parity/product-sdk-host's container), and the truapi-host CLI's WebSocket
 * bridge refuses a message past 8 MiB. The stores underneath are UserDefaults
 * on iOS and the app's Preferences on Android; both hold every value in
 * memory and rewrite on a change. So the ring is small (32 x 8 KiB = 256 KiB, 512 KiB hex-encoded: a
 * game's log is about 80 KB) and a flush never rewrites anything it wrote.
 *
 * LAYOUT: a flush writes ONE new chunk `{seq, first, last, entries}` at key
 * `<prefix>.chunk.<seq mod RING_SLOTS>` (a full ring overwrites its oldest slot,
 * oldest-first eviction, no deletes), then the index `{next, oldest}`. A chunk
 * whose `seq` is not the one its slot should hold is stale and skipped.
 *
 * NEVER-OVERWRITE: a read that FAILED is not an empty store. `load` then leaves
 * the store disabled and nothing is written until a later `load` succeeds.
 *
 * Pure of storage and time: the key-value store is injected.
 */

/** the part of a log entry the ring needs; the rest rides along untouched */
export interface ChunkEntry {
  /** ms epoch */
  ts: number
  /** approximate stored size, as the entry accounts for itself */
  size: number
}

export type ChunkRead = { ok: true; value: string | null } | { ok: false }

export interface ChunkKV {
  /** a failed read must answer `{ ok: false }`, an absent key `value: null` or "" */
  read(key: string): Promise<ChunkRead>
  write(key: string, value: string): Promise<void>
}

const CHUNK_BYTES = 8 * 1024
export const RING_SLOTS = 32
export const KEY_PREFIX = "jollity.debug-log"

interface Index {
  /** the seq the next chunk takes */
  next: number
  /** the oldest seq still live; `next` means empty */
  oldest: number
}

interface Chunk<E> {
  seq: number
  first: number
  last: number
  entries: E[]
}

interface ChunkReadResult<E> {
  entries: E[]
  /** false when a chunk the ring holds could not be read or was stale */
  complete: boolean
}

export interface ChunkStore<E extends ChunkEntry> {
  /** Reads the index. False when the read failed or the index is unusable:
   *  the store then writes nothing. */
  load(): Promise<boolean>
  readonly ready: boolean
  /** Writes the entries (oldest first) as new chunk(s), then the index. Writes
   *  are chained; never rejects. */
  append(entries: readonly E[]): Promise<void>
  /** The stored entries with `since <= ts < until`, oldest first; null when the
   *  index could not be read. */
  read(since?: number, until?: number): Promise<ChunkReadResult<E> | null>
  /** Forgets every entry (the index is emptied; chunks are overwritten in time). */
  clear(): Promise<void>
}

const indexKey = (prefix: string) => `${prefix}.index`
const chunkKey = (prefix: string, seq: number) => `${prefix}.chunk.${seq % RING_SLOTS}`

function parse(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: true, value: null }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

function asIndex(raw: unknown): Index | null {
  if (raw === null) return { next: 0, oldest: 0 }
  const value = raw as Partial<Index>
  if (typeof value.next !== "number") return null
  // `oldest` is derivable from `next`: the ring holds the last RING_SLOTS
  const floor = Math.max(0, value.next - RING_SLOTS)
  return { next: value.next, oldest: typeof value.oldest === "number" ? Math.max(value.oldest, floor) : floor }
}

export function createChunkStore<E extends ChunkEntry>(
  kv: ChunkKV,
  options: { prefix?: string; chunkBytes?: number } = {},
): ChunkStore<E> {
  const prefix = options.prefix ?? KEY_PREFIX
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES
  let index: Index | null = null
  let chain: Promise<void> = Promise.resolve()

  async function readIndex(): Promise<Index | null> {
    const read = await kv.read(indexKey(prefix))
    if (!read.ok) return null
    const parsed = parse(read.value)
    // an unparseable index is not ours to guess at: leave the store alone
    return parsed.ok ? asIndex(parsed.value) : null
  }

  async function readChunk(seq: number): Promise<Chunk<E> | null> {
    const read = await kv.read(chunkKey(prefix, seq))
    if (!read.ok) return null
    const parsed = parse(read.value)
    const value = parsed.ok ? (parsed.value as Partial<Chunk<E>> | null) : null
    return value && value.seq === seq && Array.isArray(value.entries) && typeof value.first === "number" && typeof value.last === "number"
      ? (value as Chunk<E>)
      : null
  }

  async function load(): Promise<boolean> {
    const loaded = await readIndex()
    if (!loaded) return false
    index = loaded
    return true
  }

  async function doAppend(entries: readonly E[]): Promise<void> {
    if (!index || entries.length === 0) return
    // each batch is cut into fresh chunks; none ever reopens an old one
    const groups: E[][] = []
    let bytes = 0
    for (const entry of entries) {
      if (groups.length === 0 || (bytes + entry.size > chunkBytes && groups.at(-1)!.length > 0)) {
        groups.push([])
        bytes = 0
      }
      groups.at(-1)!.push(entry)
      bytes += entry.size
    }
    let next = index.next
    for (const group of groups) {
      const chunk: Chunk<E> = { seq: next, first: group[0].ts, last: group.at(-1)!.ts, entries: group }
      await kv.write(chunkKey(prefix, next), JSON.stringify(chunk))
      next += 1
    }
    const written: Index = { next, oldest: Math.max(index.oldest, next - RING_SLOTS) }
    await kv.write(indexKey(prefix), JSON.stringify(written))
    index = written
  }

  return {
    load,
    get ready() {
      return index !== null
    },
    append(entries) {
      chain = chain.then(() => doAppend(entries)).catch(() => {})
      return chain
    },
    async read(since, until) {
      await chain
      const current = index ?? (await readIndex())
      if (!current) return null
      const entries: E[] = []
      let complete = true
      for (let seq = current.oldest; seq < current.next; seq++) {
        const chunk = await readChunk(seq)
        if (!chunk) {
          complete = false
          continue
        }
        if ((since !== undefined && chunk.last < since) || (until !== undefined && chunk.first >= until)) continue
        for (const entry of chunk.entries) {
          if ((since === undefined || entry.ts >= since) && (until === undefined || entry.ts < until)) entries.push(entry)
        }
      }
      return { entries, complete }
    },
    clear() {
      chain = chain
        .then(async () => {
          if (!index) return
          const emptied: Index = { next: index.next, oldest: index.next }
          await kv.write(indexKey(prefix), JSON.stringify(emptied))
          index = emptied
        })
        .catch(() => {})
      return chain
    },
  }
}
