// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Persistence of one game's debug log through host storage.
 *
 * The chunk ring itself is lib/debug/log-chunks.ts; this decides WHAT and WHEN.
 *
 * WHAT: only the game window. Nothing is queued until `activate()` (the
 * handover marker, lib/debug/telemetry.ts), so boot and idle noise stay in
 * memory and Sentry; `deactivate()` stops queueing once every remembered
 * game's log went out, and KEEPS what is stored: a transport 2xx is not proof
 * Sentry stored the event, so the lines stay for a rejoin, a
 * human-triggered export and a late upload. They are let go only by
 * `release(before)` at the next game's handover (lib/telemetry/game-log.ts)
 * or by the ring overwriting its oldest chunk. The need is the rejoin and the
 * late game log, not an archive.
 *
 * WHEN: lines are queued synchronously (devLog must never wait) and written as
 * one new chunk by a flush at most FLUSH_INTERVAL_MS after the first queued
 * line, and at once when the page is hidden (`flushNow`). A flush that finds
 * the store unloaded tries the load again, so the interval bounds the retries;
 * nothing is written while the store is unread, so a failed read can never
 * overwrite what the earlier sessions left. Errors are swallowed; the in-memory
 * log stays the source for this session and this store only carries earlier ones.
 */
import { withTimeout } from "../with-timeout"
import { createChunkStore, type ChunkEntry, type ChunkKV } from "./log-chunks"

export const FLUSH_INTERVAL_MS = 10_000
/** a release that cannot read the store within this gives up untouched, so a
 *  host read that never answers cannot hold back the flushes queued behind it */
export const RELEASE_READ_MS = 5_000
/** lines held while the store is unreadable: the memory log caps the same */
const HOLD_MAX = 5_000

export interface HostPersist<E extends ChunkEntry & { sessionId: string }> {
  /** Loads the store; false when host storage could not be read. */
  start(): Promise<boolean>
  /** Starts queueing lines (the game began). */
  activate(): void
  /** Stops queueing; what is stored stays. */
  deactivate(): void
  readonly active: boolean
  enqueue(entry: E): void
  /** Writes what is queued now. Never rejects. */
  flushNow(): Promise<void>
  /** The persisted entries of sessions other than `session` in the window; null
   *  when the store is unreadable. */
  readEarlier(since: number | undefined, until: number | undefined, session: string): Promise<E[] | null>
  /** Empties the store and the queue and switches queueing off. */
  clear(): Promise<void>
  /** Drops the stored lines older than `before` and keeps the rest, the queue
   *  and queueing. Leaves the store untouched when it, or any chunk of it,
   *  cannot be read: a rewrite would make a passing read failure permanent.
   *  Never rejects. */
  release(before: number): Promise<void>
}

export function createHostPersist<E extends ChunkEntry & { sessionId: string }>(kv: ChunkKV): HostPersist<E> {
  const store = createChunkStore<E>(kv)
  let queue: E[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading: Promise<boolean> | null = null
  let active = false
  /** flushes and releases run one at a time: a batch written in the middle
   *  of a release's read and rewrite would be lost */
  let serial: Promise<void> = Promise.resolve()
  /** bumped by every clear: a release that read before it must not rewrite */
  let generation = 0
  const serially = (run: () => Promise<void>): Promise<void> => {
    const next = serial.then(run)
    serial = next.catch(() => {})
    return next
  }

  function load(): Promise<boolean> {
    if (store.ready) return Promise.resolve(true)
    loading ??= store
      .load()
      .catch(() => false)
      .finally(() => {
        loading = null
      })
    return loading
  }

  function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    return serially(flushQueued)
  }

  async function flushQueued(): Promise<void> {
    if (!(await load())) {
      if (queue.length > HOLD_MAX) queue = queue.slice(-HOLD_MAX)
      if (queue.length > 0) arm()
      return
    }
    const batch = queue
    queue = []
    await store.append(batch)
  }

  function arm(): void {
    timer ??= setTimeout(() => void flush().catch(() => {}), FLUSH_INTERVAL_MS)
  }

  return {
    start: load,
    activate() {
      active = true
    },
    deactivate() {
      active = false
    },
    get active() {
      return active
    },
    enqueue(entry) {
      if (!active) return
      queue.push(entry)
      arm()
    },
    flushNow() {
      return flush().catch(() => {})
    },
    async readEarlier(since, until, session) {
      if (!(await load())) return null
      const read = await store.read(since, until)
      return read ? read.entries.filter((entry) => entry.sessionId !== session) : null
    },
    clear() {
      active = false
      queue = []
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      generation += 1
      // on the same serial lane as flush and release: a release in flight
      // sees the bumped generation and gives up, then this clear runs
      return serially(async () => {
        if (await load()) await store.clear()
      }).catch(() => {})
    },
    release(before) {
      const started = generation
      return serially(async () => {
        if (generation !== started) return
        // only the read is bounded: a late answer is dropped here, so it can
        // never start a rewrite after the flushes behind it went ahead
        const read = await withTimeout((async () => ((await load()) ? store.read() : null))(), RELEASE_READ_MS)
        if (!read?.complete || generation !== started) return
        const kept = read.entries.filter((entry) => entry.ts >= before)
        if (kept.length === read.entries.length) return
        // both on the store's own chain with no await between, so a reader
        // (which waits for that chain) never sees the emptied ring
        void store.clear()
        await store.append(kept)
      }).catch(() => {})
    },
  }
}
