// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The drain: one explorer-chosen task, then real turns until two
 * consecutive turns change no work counter, watchdogged at MAX_TURNS. And the
 * one fake clock: setTimeout, setInterval, Date and performance are faked,
 * setImmediate, queueMicrotask and nextTick stay real, and each `clock:next`
 * fires exactly one timer through the vendored clock's `next()`.
 *
 * At import, before any fake timers are installed, the real setTimeout and
 * setInterval are wrapped with a live-handle counter (real timer scheduling is
 * trapped): code that captured the real functions shows
 * up in `liveRealTimers()`. Import this module before anything installs fake
 * timers.
 */
import { vi } from "vitest"

/** captured at module load: never faked */
export const realSetImmediate: typeof setImmediate = globalThis.setImmediate.bind(globalThis)

/** Real elapsed milliseconds, for throughput measurements (performance is faked). */
export const realMs = (): number => Number(process.hrtime.bigint()) / 1e6

/** One real turn: every ready promise job runs before it resolves. */
export const turn = (): Promise<void> => new Promise((resolve) => realSetImmediate(() => resolve()))

/** The drain's watchdog: at most this many real turns per drain. */
export const MAX_TURNS = 50

/** Real turns until two consecutive turns change no counter. Returns the turns
 *  taken; MAX_TURNS + 1 means the watchdog fired (the work never settled). */
export async function drain(room: { workCounters(): string }): Promise<number> {
  let last = room.workCounters()
  let quiet = 0
  for (let turns = 1; turns <= MAX_TURNS; turns++) {
    await turn()
    const now = room.workCounters()
    quiet = now === last ? quiet + 1 : 0
    last = now
    if (quiet >= 2) return turns
  }
  return MAX_TURNS + 1
}

/** The fake-timer set: setImmediate and queueMicrotask stay real (vitest 4 fakes setImmediate by default). */
const FAKED = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] as const

export interface FakeClock {
  /** fire the single earliest timer, moving now to its due time; returns now */
  next(): number
  /** the pending timers' due times, earliest first */
  dueTimes(): number[]
  /** Pending timers in firing order. Handles are for replacing references in Mesh state. */
  timers(): FakeTimer[]
  /** Move every pending timer of one owner by `ms` (the frozen page clock, room.ts pageClock): a frozen side's timers wait, then run on its own clock. */
  shift(owner: "a" | "b", ms: number): void
}

interface FakeTimer {
  handle: number | string
  /** Stable creation identity within this fake-clock installation. */
  identity: number
  due: number
  /** zero-based position among the pending timers in firing order */
  rank: number
  isInterval: boolean
  periodMs: number | null
  owner: "a" | "b" | null
}

export interface FakeClockOwnership {
  owner(): "a" | "b" | null
  /** Called immediately before a timer callback enters product code. */
  fire(timer: FakeTimer, run: () => void): void
}

interface VendoredClock {
  next(): number
  timers?: Record<string, { callAt: number; interval?: number }>
}

/** The pending timers' due times, earliest first, read from the clock itself. */
export const dueTimesOf = (timers: Record<string, { callAt: number }> | undefined): number[] =>
  Object.values(timers ?? {}).map((timer) => timer.callAt).sort((x, y) => x - y)

/** Reinstall fake timers at now 0, which resets Date.now() and
 *  performance.now() together (vi.setSystemTime alone would leave
 *  performance compensated), and return the vendored clock. */
export function installFakeClock(ownership?: FakeClockOwnership): FakeClock {
  vi.useRealTimers()
  vi.useFakeTimers({ toFake: [...FAKED], now: 0 })
  const clock = (Date as unknown as { clock?: VendoredClock }).clock
  if (!clock || typeof clock.next !== "function") throw new Error("explorer: the vendored fake clock (Date.clock) is not reachable")
  const owners = new Map<number | string, "a" | "b" | null>()
  const identities = new Map<number | string, number>()
  let nextIdentity = 0
  const fakeSetTimeout = globalThis.setTimeout
  const fakeClearTimeout = globalThis.clearTimeout
  const fakeSetInterval = globalThis.setInterval
  const fakeClearInterval = globalThis.clearInterval
  let firing: FakeTimer | undefined
  // dueTimes is read several times per drain turn: cache it, and drop the
  // cache whenever the timer set can change. Every add and clear goes through
  // the wrappers below, and every fire (next, tick, advanceTimersByTime)
  // through `run`, which the clock calls after it has removed or rescheduled
  // the timer and before the callback can add or clear others.
  let generation = 0
  let dueGeneration = -1
  let due: readonly number[] = []
  const numericHandle = (handle: string): number | string => /^\d+$/.test(handle) ? Number(handle) : handle
  const normalizedHandle = (handle: unknown): number | string => {
    const text = String(handle)
    return /^\d+$/.test(text) ? Number(text) : text
  }
  const timers = (): FakeTimer[] => Object.entries(clock.timers ?? {})
    .map(([rawHandle, timer]) => ({
      handle: numericHandle(rawHandle),
      identity: identities.get(numericHandle(rawHandle)) ?? -1,
      due: timer.callAt,
      isInterval: timer.interval !== undefined,
      periodMs: timer.interval ?? null,
      owner: owners.get(numericHandle(rawHandle)) ?? null,
    }))
    .sort((left, right) => left.due - right.due || Number(left.handle) - Number(right.handle))
    .map((timer, rank) => ({ ...timer, rank }))
  const ownedCallback = (
    interval: boolean,
    handler: TimerHandler,
    delay: number | undefined,
    args: unknown[],
  ): ReturnType<typeof setTimeout> => {
    if (args.length > 0) throw new Error("explorer: fake timers with callback arguments are not fingerprinted")
    const owner = ownership?.owner() ?? null
    const handle = { current: undefined as ReturnType<typeof setTimeout> | undefined }
    const run = () => {
      generation++
      if (handle.current === undefined) throw new Error("explorer: fake timer fired before its handle was assigned")
      const key = normalizedHandle(handle.current)
      const timer = (firing?.handle === key ? firing : timers().find((candidate) => candidate.handle === key)) ?? {
        handle: key,
        identity: identities.get(key) ?? -1,
        due: Date.now(),
        rank: 0,
        isInterval: interval,
        periodMs: interval ? (delay ?? 0) : null,
        owner,
      }
      if (!interval) {
        owners.delete(normalizedHandle(handle.current))
        identities.delete(normalizedHandle(handle.current))
      }
      const invoke = () => typeof handler === "function" ? handler() : Function(handler)()
      try {
        if (ownership) ownership.fire(timer, invoke)
        else invoke()
      } finally {
        generation++
      }
    }
    handle.current = (interval ? fakeSetInterval : fakeSetTimeout)(run, delay) as ReturnType<typeof setTimeout>
    generation++
    owners.set(normalizedHandle(handle.current), owner)
    identities.set(normalizedHandle(handle.current), nextIdentity++)
    return handle.current
  }
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    ownedCallback(false, handler, delay, args)) as unknown as typeof setTimeout
  globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    ownedCallback(true, handler, delay, args)) as unknown as typeof setInterval
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    owners.delete(normalizedHandle(handle))
    identities.delete(normalizedHandle(handle))
    fakeClearTimeout(handle)
    generation++
  }) as typeof clearTimeout
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    owners.delete(normalizedHandle(handle))
    identities.delete(normalizedHandle(handle))
    fakeClearInterval(handle)
    generation++
  }) as typeof clearInterval
  for (const method of [globalThis.setTimeout, globalThis.clearTimeout, globalThis.setInterval, globalThis.clearInterval]) {
    Object.assign(method, { clock, hadOwnProperty: true })
  }
  return {
    next: () => {
      firing = timers()[0]
      try {
        return clock.next()
      } finally {
        firing = undefined
      }
    },
    shift: (owner, ms) => {
      for (const [handle, timer] of Object.entries(clock.timers ?? {})) if (owners.get(numericHandle(handle)) === owner) timer.callAt += ms
      generation++
    },
    dueTimes: () => {
      if (dueGeneration !== generation) {
        due = Object.freeze(dueTimesOf(clock.timers))
        dueGeneration = generation
      }
      return due as number[]
    },
    timers,
  }
}

// ── the real-timer trap ───────────────────────────────────────────────────────

const liveHandles = new Set<unknown>()
const nativeSetTimeout = globalThis.setTimeout
const nativeClearTimeout = globalThis.clearTimeout
const nativeSetInterval = globalThis.setInterval
const nativeClearInterval = globalThis.clearInterval

function trappedSetTimeout(handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const handle = nativeSetTimeout((...inner: unknown[]) => {
    liveHandles.delete(handle)
    handler(...inner)
  }, ms, ...args)
  liveHandles.add(handle)
  return handle
}
function trappedClearTimeout(handle: unknown) {
  liveHandles.delete(handle)
  nativeClearTimeout(handle as Parameters<typeof clearTimeout>[0])
}
function trappedSetInterval(handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) {
  const handle = nativeSetInterval(handler, ms, ...args)
  liveHandles.add(handle)
  return handle
}
function trappedClearInterval(handle: unknown) {
  liveHandles.delete(handle)
  nativeClearInterval(handle as Parameters<typeof clearInterval>[0])
}

const trapped = globalThis as unknown as { __explorerRealTimerTrap?: boolean }
if (!trapped.__explorerRealTimerTrap) {
  // installed under fake timers it would wrap the fakes, and the real timers would go untrapped
  if (vi.isFakeTimers()) throw new Error("explorer: quiescence.ts must load before fake timers are installed (the real-timer trap)")
  trapped.__explorerRealTimerTrap = true
  globalThis.setTimeout = trappedSetTimeout as unknown as typeof setTimeout
  globalThis.clearTimeout = trappedClearTimeout as typeof clearTimeout
  globalThis.setInterval = trappedSetInterval as unknown as typeof setInterval
  globalThis.clearInterval = trappedClearInterval as typeof clearInterval
}

/** Real (unfaked) timer handles still live, made by anyone after this module loaded. */
export const liveRealTimers = (): number => liveHandles.size
/** the trap's own setTimeout and setInterval, to check that the global under real timers is the trap */
export const trapFunctions = { setTimeout: trappedSetTimeout, setInterval: trappedSetInterval }
