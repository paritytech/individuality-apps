// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Async work done once per key and shared: the app's one cache for things it
 * builds or fetches. Concurrent callers share a promise; a failure (or a value
 * `keep` refuses) is forgotten so the next ask retries; `max` evicts the least
 * recently asked key. `peek`/`subscribe` fit `useSyncExternalStore`.
 */
export class AsyncCache<V, K = string> {
  private readonly pending = new Map<K, Promise<V>>()
  private readonly ready = new Map<K, V>()
  private readonly listeners = new Set<() => void>()
  private readonly max: number
  private readonly keep: (value: V) => boolean

  constructor({ max = Infinity, keep = () => true }: { max?: number; keep?: (value: V) => boolean } = {}) {
    this.max = max
    this.keep = keep
  }

  /** the value for `key`, built by `build` the first time it is asked for */
  ensure(key: K, build: () => Promise<V>): Promise<V> {
    const hit = this.pending.get(key)
    if (hit) {
      // touched: the least recently asked-for key is the one evicted
      this.pending.delete(key)
      this.pending.set(key, hit)
      return hit
    }
    const made = build()
    this.pending.set(key, made)
    made.then(
      (value) => {
        if (this.pending.get(key) !== made) return
        if (!this.keep(value)) return this.forget(key)
        this.ready.set(key, value)
        this.listeners.forEach((listener) => listener())
      },
      () => {
        // only this promise: a retry may already have replaced it
        if (this.pending.get(key) === made) this.forget(key)
      },
    )
    while (this.pending.size > this.max) {
      const oldest = this.pending.keys().next()
      if (oldest.done) break
      this.forget(oldest.value)
    }
    return made
  }

  /** the value, once it is built; undefined while it builds, or after it failed */
  peek(key: K): V | undefined {
    return this.ready.get(key)
  }

  /** told each time a value is ready */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  forget(key: K) {
    this.pending.delete(key)
    this.ready.delete(key)
  }

  /** forget every key: builds in flight still settle for their callers, unkept */
  clear() {
    this.pending.clear()
    this.ready.clear()
  }
}

/** `build`, run once and shared; a run that fails is forgotten, so the next call runs it again */
export function once<T>(build: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | null = null
  return () =>
    (made ??= build().catch((err) => {
      made = null
      throw err
    }))
}
