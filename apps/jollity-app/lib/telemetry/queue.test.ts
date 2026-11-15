// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MAX_IN_FLIGHT,
  QUEUE_CAP,
  SEND_UNCERTAIN_FOLLOW_MS,
  SEND_TIMEOUT_MS,
  createQueue,
  type QueueItemKind,
  type SendFailureReason,
} from "./queue"

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

describe("the delivery queue", () => {
  it("holds until a sender exists, then starts every small burst at once", async () => {
    const started: number[] = []
    const queue = createQueue<number>()
    const sent = [queue.push(1), queue.push(2), queue.push(3)]
    expect(started).toEqual([])
    queue.setSender(async (item) => (started.push(item), await Promise.resolve(), true))
    expect(started).toEqual([1, 2, 3])
    await expect(Promise.all(sent)).resolves.toEqual([true, true, true])
  })

  it(`never exceeds the browser transport's ${MAX_IN_FLIGHT} sends`, async () => {
    let inFlight = 0
    let most = 0
    const answers: Array<() => void> = []
    const queue = createQueue<number>()
    queue.setSender(
      (item) =>
        new Promise((resolve) => {
          void item
          inFlight += 1
          most = Math.max(most, inFlight)
          answers.push(() => {
            inFlight -= 1
            resolve(true)
          })
        }),
    )
    const sent = Array.from({ length: MAX_IN_FLIGHT + 7 }, (_, item) => queue.push(item))
    await flush()
    expect(most).toBe(MAX_IN_FLIGHT)
    for (const answer of answers.splice(0)) answer()
    await flush()
    for (const answer of answers.splice(0)) answer()
    await expect(Promise.all(sent)).resolves.toEqual(Array(MAX_IN_FLIGHT + 7).fill(true))
  })

  it("drops metrics before events at the queue cap", async () => {
    const dropped: QueueItemKind[] = []
    const queue = createQueue<number>({ cap: 3, now: Date.now, observer: {
      failed: () => {},
      retried: () => {},
      dropped: (kind) => dropped.push(kind),
      offline: () => {},
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    const metric = queue.push(1, true)
    const events = [queue.push(2), queue.push(3), queue.push(4)]
    await expect(metric).resolves.toBe(false)
    expect(dropped).toEqual(["metric"])
    queue.setSender(async () => true)
    await expect(Promise.all(events)).resolves.toEqual([true, true, true])
  })

  it(`keeps only ${QUEUE_CAP} events and reports event displacement`, async () => {
    const dropped: QueueItemKind[] = []
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: () => {},
      retried: () => {},
      dropped: (kind) => dropped.push(kind),
      offline: () => {},
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    const sent = Array.from({ length: QUEUE_CAP + 1 }, (_, item) => queue.push(item))
    await expect(sent[0]).resolves.toBe(false)
    expect(dropped).toEqual(["event"])
  })

  it("includes the incoming event when choosing the oldest displacement", async () => {
    let at = 10
    const queue = createQueue<number>({ cap: 2, now: () => at })
    const first = queue.push(1)
    at = 20
    const second = queue.push(2)
    at = 5
    await expect(queue.push(3)).resolves.toBe(false)

    at = 20
    queue.setSender(async () => true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })
})

describe("failures and slow networks", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("delivers every event and metric when every answer takes five seconds", async () => {
    const started: string[] = []
    const queue = createQueue<string>()
    queue.setSender(
      (item) =>
        new Promise((resolve) => {
          started.push(item)
          setTimeout(() => resolve(true), 5_000)
        }),
    )
    const sent = [queue.push("event-1"), queue.push("metric", true), queue.push("event-2")]
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(Promise.all(sent)).resolves.toEqual([true, true, true])
    expect(started).toEqual(["event-1", "metric", "event-2"])
  })

  it("retries a thrown fetch and keeps sending the session", async () => {
    const failures: SendFailureReason[] = []
    let retries = 0
    const sent: number[] = []
    let calls = 0
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: (reason) => failures.push(reason),
      retried: () => (retries += 1),
      dropped: () => {},
      offline: () => {},
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    queue.setSender(async (item) => {
      calls += 1
      if (calls === 1) throw new TypeError("Failed to fetch")
      sent.push(item)
      return true
    })
    const first = queue.push(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(first).resolves.toBe(true)
    await expect(queue.push(2)).resolves.toBe(true)
    expect(failures).toEqual(["fetch"])
    expect(retries).toBe(1)
    expect(sent).toEqual([1, 2])
  })

  it("waits through Sentry's sixty-second local limiter after a 429", async () => {
    let calls = 0
    const queue = createQueue<number>()
    queue.setSender(async () => {
      calls += 1
      return calls === 1 ? { failed: "429", retryAfterMs: 60_000 } : true
    })
    const sent = queue.push(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(sent).resolves.toBe(true)
    expect(calls).toBe(2)
  })

  it("does not charge the retry budget or failure counters for local transport drops", async () => {
    let calls = 0
    const failures: SendFailureReason[] = []
    let retries = 0
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: (reason) => failures.push(reason),
      retried: () => (retries += 1),
      dropped: () => {},
      offline: () => {},
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    queue.setSender(async () => {
      calls += 1
      return calls <= 7
        ? { failed: "429", retryAfterMs: 60_000, locallyRateLimited: true }
        : true
    })

    const sent = queue.push(1)
    for (let attempt = 0; attempt < 7; attempt += 1) await vi.advanceTimersByTimeAsync(60_000)
    await expect(sent).resolves.toBe(true)
    expect(calls).toBe(8)
    expect(failures).toEqual([])
    expect(retries).toBe(0)
  })

  it("settles a final answer undelivered without a resend, and still holds its barrier", async () => {
    let calls = 0
    const queue = createQueue<number>()
    queue.setSender(async () => {
      calls += 1
      return calls === 1 ? { failed: "429", retryAfterMs: 30_000, statusCode: 200, final: true } : true
    })
    await expect(queue.push(1)).resolves.toBe(false)
    const next = queue.push(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(next).resolves.toBe(true)
    expect(calls).toBe(2)
  })

  it("holds the whole queue behind a Retry-After that came with a 5xx", async () => {
    let calls = 0
    const queue = createQueue<number>()
    queue.setSender(async () => {
      calls += 1
      return calls === 1 ? { failed: "5xx", retryAfterMs: 30_000, statusCode: 503 } : true
    })
    const first = queue.push(1)
    await flush()
    const second = queue.push(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it("restores the shared deadline after a page reload", async () => {
    let saved = 0
    const store = { load: () => saved, save: (until: number) => (saved = until) }
    const first = createQueue<number>({ now: Date.now, rateLimitStore: store })
    let firstCalls = 0
    first.setSender(async () => {
      firstCalls += 1
      return firstCalls === 1 ? { failed: "429", retryAfterMs: 3_600_000, statusCode: 429 } : true
    })
    void first.push(1)
    await flush()

    const reloaded = createQueue<number>({ now: Date.now, rateLimitStore: store })
    let reloadCalls = 0
    reloaded.setSender(async () => (reloadCalls += 1, true))
    const sent = reloaded.push(2)
    await vi.advanceTimersByTimeAsync(3_599_999)
    expect(reloadCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(sent).resolves.toBe(true)
    expect(reloadCalls).toBe(1)
  })

  it("holds queued, newly captured and outbox envelopes behind one global Retry-After barrier", async () => {
    type Item = { id: string; source: "normal" | "outbox" }
    const started: Array<Item & { at: number }> = []
    const beganAt = Date.now()
    const answers = new Map<string, (answer: true | { failed: "429"; retryAfterMs: number; statusCode: number }) => void>()
    const queue = createQueue<Item>()
    queue.setSender(
      (item) =>
        new Promise((resolve) => {
          started.push({ ...item, at: Date.now() })
          if (started.length <= MAX_IN_FLIGHT) answers.set(item.id, resolve)
          else resolve(true)
        }),
    )

    const initial = Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, index) =>
      queue.push({ id: `initial-${index}`, source: "normal" }),
    )
    expect(started).toHaveLength(MAX_IN_FLIGHT)
    answers.get("initial-0")?.({ failed: "429", retryAfterMs: 60_000, statusCode: 429 })
    await flush()
    for (let index = 1; index < MAX_IN_FLIGHT; index += 1) answers.get(`initial-${index}`)?.(true)
    await flush()

    const duringBackoff = queue.push({ id: "new-event", source: "normal" })
    const outbox = queue.push({ id: "outbox-drain", source: "outbox" })
    queue.flushNow()
    expect(started).toHaveLength(MAX_IN_FLIGHT)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(started).toHaveLength(MAX_IN_FLIGHT)
    await vi.advanceTimersByTimeAsync(1)

    const resumed = started.slice(MAX_IN_FLIGHT)
    expect(resumed.map(({ id }) => id)).toEqual(["initial-40", "initial-0", "new-event", "outbox-drain"])
    expect(resumed.every(({ at }) => at === beganAt + 60_000)).toBe(true)
    await expect(Promise.all([...initial, duringBackoff, outbox])).resolves.toEqual(
      Array(MAX_IN_FLIGHT + 3).fill(true),
    )
  })

  it("allows requests already in flight when the first 429 arrives and extends the barrier from a later 429", async () => {
    const started: Array<{ item: number; at: number }> = []
    const beganAt = Date.now()
    const answers = new Map<number, (answer: true | { failed: "429"; retryAfterMs: number; statusCode: number }) => void>()
    const queue = createQueue<number>()
    queue.setSender(
      (item) =>
        new Promise((resolve) => {
          started.push({ item, at: Date.now() })
          if (started.filter((attempt) => attempt.item === item).length === 1) answers.set(item, resolve)
          else resolve(true)
        }),
    )

    const sent = [queue.push(1), queue.push(2)]
    expect(started).toEqual([{ item: 1, at: beganAt }, { item: 2, at: beganAt }])
    answers.get(1)?.({ failed: "429", retryAfterMs: 60_000, statusCode: 429 })
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    answers.get(2)?.({ failed: "429", retryAfterMs: 60_000, statusCode: 429 })
    await flush()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(started).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(started.slice(2)).toEqual([
      { item: 1, at: beganAt + 70_000 },
      { item: 2, at: beganAt + 70_000 },
    ])
    await expect(Promise.all(sent)).resolves.toEqual([true, true])
  })

  it("honors a Retry-After response even after its uncertain queue claim was abandoned", async () => {
    const beganAt = Date.now()
    const started: Array<{ item: number; at: number }> = []
    let lateAnswer: ((answer: { failed: "429"; retryAfterMs: number; statusCode: number }) => void) | undefined
    const queue = createQueue<number>()
    queue.setSender(
      (item) =>
        new Promise((resolve) => {
          started.push({ item, at: Date.now() })
          if (item === 1) lateAnswer = resolve
          else resolve(true)
        }),
    )

    const abandoned = queue.push(1)
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + SEND_UNCERTAIN_FOLLOW_MS)
    await expect(abandoned).resolves.toBe(false)
    lateAnswer?.({ failed: "429", retryAfterMs: 60_000, statusCode: 429 })
    await flush()
    const later = queue.push(2)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(started).toEqual([{ item: 1, at: beganAt }])
    await vi.advanceTimersByTimeAsync(1)
    expect(started[1]).toEqual({ item: 2, at: beganAt + SEND_TIMEOUT_MS + SEND_UNCERTAIN_FOLLOW_MS + 60_000 })
    await expect(later).resolves.toBe(true)
  })

  it("keeps a timed-out sender claimed and accepts its late completion without a retry", async () => {
    let failures = 0
    let retries = 0
    let recovered = 0
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: () => (failures += 1),
      retried: () => (retries += 1),
      dropped: () => {},
      offline: () => {},
      recoveredTimeout: () => (recovered += 1),
      deliveredAfter: () => {},
    } })
    let finish: ((answer: true) => void) | undefined
    queue.setSender(() => new Promise((resolve) => (finish = resolve)))
    const sent = queue.push(1)
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS)
    let settled = false
    void sent.then(() => (settled = true))
    let idle = false
    void queue.whenIdle().then(() => (idle = true))
    await flush()
    expect(settled).toBe(false)
    expect(idle).toBe(false)
    expect(failures).toBe(1)
    expect(retries).toBe(0)
    expect(queue.size()).toBe(1)
    finish?.(true)
    await expect(sent).resolves.toBe(true)
    await expect(queue.whenIdle()).resolves.toBeUndefined()
    expect(recovered).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(SEND_TIMEOUT_MS).toBe(15_000)
  })

  it("lets later work start after forty ambiguous sends time out", async () => {
    let calls = 0
    const queue = createQueue<number>()
    queue.setSender(async () => {
      calls += 1
      return calls <= MAX_IN_FLIGHT ? await new Promise<true>(() => {}) : true
    })
    const sent = Array.from({ length: MAX_IN_FLIGHT + 1 }, (_, item) => queue.push(item))
    expect(calls).toBe(MAX_IN_FLIGHT)
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS)
    await expect(sent[MAX_IN_FLIGHT]).resolves.toBe(true)
    expect(calls).toBe(MAX_IN_FLIGHT + 1)
    expect(queue.size()).toBe(MAX_IN_FLIGHT)
  })

  it("retries a definite failure that arrives after the request timeout", async () => {
    const failures: SendFailureReason[] = []
    let retries = 0
    let calls = 0
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: (reason) => failures.push(reason),
      retried: () => (retries += 1),
      dropped: () => {},
      offline: () => {},
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    queue.setSender(async () => {
      calls += 1
      if (calls === 1) {
        return await new Promise<{ failed: "5xx"; statusCode: number }>((resolve) =>
          setTimeout(() => resolve({ failed: "5xx", statusCode: 503 }), SEND_TIMEOUT_MS + 5_000),
        )
      }
      return true
    })

    const sent = queue.push(1)
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 5_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(sent).resolves.toBe(true)
    expect(calls).toBe(2)
    expect(failures).toEqual(["timeout"])
    expect(retries).toBe(1)
  })

  it("does not retry an ambiguous network failure that arrives after timeout", async () => {
    const failures: SendFailureReason[] = []
    let retries = 0
    let calls = 0
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: (reason) => failures.push(reason),
      retried: () => (retries += 1),
      dropped: () => {},
      offline: () => {},
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    queue.setSender(async () => {
      calls += 1
      return await new Promise<{ failed: "fetch" }>((resolve) =>
        setTimeout(() => resolve({ failed: "fetch" }), SEND_TIMEOUT_MS + 5_000),
      )
    })

    const sent = queue.push(1)
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 5_000)
    await expect(sent).resolves.toBe(false)
    expect(calls).toBe(1)
    expect(failures).toEqual(["timeout"])
    expect(retries).toBe(0)
  })

  it("keeps never-settling ambiguous claims inside the queue cap", async () => {
    const queue = createQueue<number>({ cap: 5 })
    queue.setSender(async () => await new Promise<true>(() => {}))
    const sent = Array.from({ length: 12 }, (_, item) => queue.push(item, item % 2 === 0))
    await expect(Promise.all(sent.slice(5))).resolves.toEqual(Array(7).fill(false))
    expect(queue.size()).toBe(5)
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS)
    expect(queue.size()).toBe(5)
    await vi.advanceTimersByTimeAsync(SEND_UNCERTAIN_FOLLOW_MS)
    await expect(Promise.all(sent)).resolves.toEqual(Array(12).fill(false))
    await expect(queue.whenIdle()).resolves.toBeUndefined()
    expect(queue.size()).toBe(0)
  })

  it("displaces the oldest event when an out-of-order retry reaches the cap", async () => {
    const cap = MAX_IN_FLIGHT + 2
    const beganAt = Date.now()
    const answers = new Map<number, (answer: true | { failed: "5xx" }) => void>()
    const results = new Map<number, boolean>()
    const queue = createQueue<number>({ cap, now: Date.now })
    queue.setSender((item) =>
      new Promise((resolve) => {
        answers.set(item, (answer) => {
          answers.delete(item)
          resolve(answer)
        })
      }))

    const sent = Array.from({ length: cap }, (_, item) => {
      vi.setSystemTime(beganAt + item)
      const promise = queue.push(item)
      void promise.then((result) => results.set(item, result))
      return promise
    })
    expect([...answers.keys()]).toEqual(Array.from({ length: MAX_IN_FLIGHT }, (_, item) => item))

    answers.get(0)?.({ failed: "5xx" })
    await flush()
    expect(answers.has(MAX_IN_FLIGHT)).toBe(true)

    vi.setSystemTime(beganAt + cap)
    const newest = queue.push(cap)
    void newest.then((result) => results.set(cap, result))
    await flush()
    const resultsAtCap = new Map(results)

    for (let pass = 0; pass < 4; pass += 1) {
      for (const answer of [...answers.values()]) answer(true)
      await flush()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await Promise.all([...sent, newest])

    expect(resultsAtCap.get(0)).toBe(false)
    expect(resultsAtCap.has(MAX_IN_FLIGHT + 1)).toBe(false)
    expect(resultsAtCap.has(cap)).toBe(false)
  })

  it("starts offline and backed-off work immediately on pagehide", async () => {
    let online = false
    const started: number[] = []
    const queue = createQueue<number>()
    queue.setSender(async (item) => {
      started.push(item)
      return online ? true : "offline"
    })
    const sent = queue.push(1)
    await flush()
    online = true
    queue.flushNow()
    await expect(sent).resolves.toBe(true)
    expect(started).toEqual([1, 1])
  })

  it("holds offline, counts the interval, and resumes in order", async () => {
    const offline: number[] = []
    let online = false
    const delivered: number[] = []
    const queue = createQueue<number>({ now: Date.now, observer: {
      failed: () => {},
      retried: () => {},
      dropped: () => {},
      offline: (ms) => offline.push(ms),
      recoveredTimeout: () => {},
      deliveredAfter: () => {},
    } })
    queue.setSender(async (item) => {
      if (!online) return "offline"
      delivered.push(item)
      return true
    })
    const sent = [queue.push(1), queue.push(2)]
    await flush()
    await vi.advanceTimersByTimeAsync(3_000)
    online = true
    queue.resume()
    await expect(Promise.all(sent)).resolves.toEqual([true, true])
    expect(delivered).toEqual([1, 2])
    expect(offline).toEqual([3_000])
  })
})

describe("the per-lane barrier", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  type Item = { lane: "event" | "log"; id: number }
  const LANES = { names: ["event", "log"], of: (item: Item) => item.lane }

  it("rejects an empty lane list at construction", () => {
    expect(() => createQueue<Item>({ lanes: { names: [], of: (item) => item.lane } })).toThrow(
      "at least one lane",
    )
  })

  // Which lane a limit holds. The answer names the lanes; "none" holds all.
  it.each([
    ["names the event lane only", ["event"] as const, "event" as const, "log" as const, true],
    ["names the log lane only", ["log"] as const, "log" as const, "event" as const, true],
    ["names no lane", undefined, "log" as const, "event" as const, false],
    ["names no lane", undefined, "event" as const, "log" as const, false],
  ])("holds the %s (limited lane %s)", async (_name, lanes, limitedLane, freeLane, freeRuns) => {
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length === 1
        ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, ...(lanes ? { lanes } : {}) }
        : true
    })
    const limited = queue.push({ lane: limitedLane, id: 1 })
    await flush()
    const free = queue.push({ lane: freeLane, id: 2 })
    const alsoLimited = queue.push({ lane: limitedLane, id: 3 })
    await flush()
    // a named lane leaves the other free; no lanes holds everything
    if (freeRuns) await expect(free).resolves.toBe(true)
    expect(calls).toEqual(freeRuns ? [1, 2] : [1])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual(freeRuns ? [1, 2] : [1])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([limited, free, alsoLimited])).resolves.toEqual([true, true, true])
    expect(calls).toEqual(freeRuns ? [1, 2, 1, 3] : [1, 1, 2, 3])
  })

  it("wakes at the earliest deadline across lanes", async () => {
    const calls: number[] = []
    const attempts = new Map<number, number>()
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      const attempt = (attempts.get(item.id) ?? 0) + 1
      attempts.set(item.id, attempt)
      if (attempt > 1) return true
      return item.id === 1
        ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, lanes: ["event"] }
        : { failed: "429", retryAfterMs: 20_000, statusCode: 429, lanes: ["log"] }
    })
    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    const log = queue.push({ lane: "log", id: 2 })
    await flush()
    expect(calls).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(19_999)
    expect(calls).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(1)
    await expect(log).resolves.toBe(true)
    expect(calls).toEqual([1, 2, 2])
    await vi.advanceTimersByTimeAsync(40_000)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([1, 2, 2, 1])
  })

  it("applies and persists each laneDelays duration independently", async () => {
    const calls: Array<{ id: number; at: number }> = []
    const saved = new Map<string, number>()
    const beganAt = Date.now()
    const queue = createQueue<Item>({
      now: Date.now,
      lanes: LANES,
      rateLimitStore: {
        load: () => 0,
        save: (until, lane) => saved.set(lane, until),
      },
    })
    queue.setSender(async (item) => {
      calls.push({ id: item.id, at: Date.now() })
      return item.id === 1
        ? {
            failed: "429",
            retryAfterMs: 3_600_000,
            statusCode: 200,
            final: true,
            lanes: ["log"],
            laneDelays: { event: 60_000, log: 3_600_000 },
          }
        : true
    })

    await expect(queue.push({ lane: "log", id: 1 })).resolves.toBe(false)
    const event = queue.push({ lane: "event", id: 2 })
    const log = queue.push({ lane: "log", id: 3 })
    expect(saved).toEqual(new Map([
      ["event", beganAt + 60_000],
      ["log", beganAt + 3_600_000],
    ]))
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([{ id: 1, at: beganAt }, { id: 2, at: beganAt + 60_000 }])
    await vi.advanceTimersByTimeAsync(3_539_999)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(log).resolves.toBe(true)
    expect(calls[2]).toEqual({ id: 3, at: beganAt + 3_600_000 })
  })

  it("makes an unknown laneDelays name hold every known lane", async () => {
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return item.id === 1
        ? {
            failed: "429",
            retryAfterMs: 60_000,
            statusCode: 200,
            final: true,
            lanes: ["log"],
            laneDelays: { typo: 60_000 },
          }
        : true
    })

    await expect(queue.push({ lane: "log", id: 1 })).resolves.toBe(false)
    const event = queue.push({ lane: "event", id: 2 })
    const log = queue.push({ lane: "log", id: 3 })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([event, log])).resolves.toEqual([true, true])
    expect(calls).toEqual([1, 2, 3])
  })

  // M1: a rate-limited item must wait at least its own answer's delay, even
  // when that answer named another lane (whose barrier leaves this lane due).
  it("waits the answer's own delay when the limit names another lane", async () => {
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length === 1
        ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, lanes: ["log"] }
        : true
    })
    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([1, 1])
  })

  it("keeps an item's own Retry-After when pagehide flushes another lane", async () => {
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length === 1
        ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, lanes: ["log"] }
        : true
    })
    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    expect(calls).toEqual([1])
    queue.flushNow()
    await flush()
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([1, 1])
  })

  it("waits a locally rate-limited item's delay when the limit names another lane", async () => {
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length <= 2
        ? { failed: "429", retryAfterMs: 60_000, locallyRateLimited: true, lanes: ["log"] }
        : true
    })
    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    // the local drop consumed no retry budget: without the floor this loops
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual([1, 1])
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([1, 1, 1])
  })

  // M2: a caller that returns a lane missing from names must fail closed. The
  // unknown lane is observable once, and a lane-specific limit still holds
  // both retries and newly queued items instead of silently routing to event.
  it("holds and records an unknown lane without throwing from push", async () => {
    const calls: number[] = []
    const unknown: string[] = []
    const stray = { names: ["event"], of: () => "log" }
    const queue = createQueue<Item>({
      now: Date.now,
      lanes: stray,
      observer: {
        failed: () => {},
        retried: () => {},
        dropped: () => {},
        offline: () => {},
        recoveredTimeout: () => {},
        deliveredAfter: () => {},
        unknownLane: (lane) => {
          unknown.push(lane)
          throw new Error("observer failed")
        },
      },
    })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length === 1
        ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, lanes: ["log"] }
        : true
    })
    let first: Promise<boolean> | undefined
    expect(() => {
      first = queue.push({ lane: "event", id: 1 })
    }).not.toThrow()
    await flush()
    const second = queue.push({ lane: "event", id: 2 })
    await flush()
    expect(calls).toEqual([1])
    expect(unknown).toEqual(["log"])
    expect(queue.deadlineOf("log")).toBe(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([first!, second])).resolves.toEqual([true, true])
    expect(calls).toEqual([1, 1, 2])
    expect(unknown).toEqual(["log"])
  })

  it("treats an empty response lane list as a limit on every lane", async () => {
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length === 1
        ? { failed: "429", retryAfterMs: 30_000, statusCode: 429, lanes: [] }
        : true
    })

    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    const log = queue.push({ lane: "log", id: 2 })
    await flush()
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([event, log])).resolves.toEqual([true, true])
    expect(calls).toEqual([1, 1, 2])
  })

  it("keeps the no-Retry-After 429 schedule at 0, 1, 3 and 7 seconds", async () => {
    const beganAt = Date.now()
    const at: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async () => {
      at.push(Date.now())
      return { failed: "429", statusCode: 429, lanes: ["event"] }
    })

    void queue.push({ lane: "event", id: 1 })
    await flush()
    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(at).toEqual([beganAt, beganAt + 1_000, beganAt + 3_000, beganAt + 7_000])
  })

  it("exposes a lane's deadline for a caller that mirrors it", async () => {
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => (item.id === 1
      ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, lanes: ["log"] }
      : true))
    expect(queue.deadlineOf("log")).toBe(0)
    void queue.push({ lane: "log", id: 1 })
    await flush()
    expect(queue.deadlineOf("log")).toBe(Date.now() + 60_000)
    expect(queue.deadlineOf("event")).toBe(0)
    expect(queue.deadlineOf("unknown")).toBe(Date.now() + 60_000)
  })

  it("saves each lane's deadline under its own key and restores it", async () => {
    const saved = new Map<string, number>()
    const store = { load: (lane: string) => saved.get(lane) ?? 0, save: (until: number, lane: string) => void saved.set(lane, until) }
    const first = createQueue<Item>({ now: Date.now, rateLimitStore: store, lanes: LANES })
    first.setSender(async (item) => (item.id === 1
      ? { failed: "429", retryAfterMs: 60_000, statusCode: 429, lanes: ["event"] }
      : { delivered: true, retryAfterMs: 120_000, lanes: ["log"] }))
    void first.push({ lane: "event", id: 1 })
    await flush()
    void first.push({ lane: "log", id: 2 })
    await flush()
    expect([...saved.keys()].sort()).toEqual(["event", "log"])
    expect(saved.get("event")).toBe(Date.now() + 60_000)
    expect(saved.get("log")).toBe(Date.now() + 120_000)

    // a reload: module memory dies, the store survives
    const reloaded = createQueue<Item>({ now: Date.now, rateLimitStore: store, lanes: LANES })
    const calls: number[] = []
    reloaded.setSender(async (item) => (calls.push(item.id), true))
    const log = reloaded.push({ lane: "log", id: 3 })
    const event = reloaded.push({ lane: "event", id: 4 })
    await flush()
    // the event lane's 60 s deadline is due; the log lane's 120 s is not
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([4])
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(log).resolves.toBe(true)
    expect(calls).toEqual([4, 3])
  })

  it("waits out a persisted deadline the store returned for one lane", async () => {
    // the cap belongs to the store (init.ts): what it hands back, the queue honors
    const store = { load: (lane: string) => (lane === "event" ? Date.now() + 3_600_000 : 0), save: () => {} }
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, rateLimitStore: store, lanes: LANES })
    queue.setSender(async (item) => (calls.push(item.id), true))
    const event = queue.push({ lane: "event", id: 1 })
    const log = queue.push({ lane: "log", id: 2 })
    await flush()
    expect(calls).toEqual([2])
    await vi.advanceTimersByTimeAsync(3_599_999)
    expect(calls).toEqual([2])
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([event, log])).resolves.toEqual([true, true])
    expect(calls).toEqual([2, 1])
  })

  it("does not spin when a deadline is longer than a 32-bit timer", async () => {
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof realSetTimeout>) => {
      delays.push(Number(args[1]))
      return realSetTimeout(...args)
    }) as typeof globalThis.setTimeout)
    const calls: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async (item) => {
      calls.push(item.id)
      return calls.length === 1 ? { failed: "429", retryAfterMs: 2 ** 31, statusCode: 429 } : true
    })
    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    expect(calls).toEqual([1])
    // a delay past 2^31-1 wraps to a tiny or negative value and spins
    expect(delays).toContain(2_147_483_647)
    expect(delays.every((delay) => delay >= 0 && delay <= 2_147_483_647)).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toEqual([1])
    await vi.advanceTimersByTimeAsync(2 ** 31)
    await expect(event).resolves.toBe(true)
    expect(calls).toEqual([1, 1])
    spy.mockRestore()
  })

  it("spends a mismatched-lane retry budget one delay at a time, never in microtasks", async () => {
    const beganAt = Date.now()
    const at: number[] = []
    const queue = createQueue<Item>({ now: Date.now, lanes: LANES })
    queue.setSender(async () => {
      at.push(Date.now())
      return { failed: "429", retryAfterMs: 30_000, statusCode: 429, lanes: ["log"] }
    })
    const event = queue.push({ lane: "event", id: 1 })
    await flush()
    // a hot retry would already be at six attempts here
    expect(at).toEqual([beganAt])
    for (let attempt = 0; attempt < 6; attempt += 1) await vi.advanceTimersByTimeAsync(30_000)
    await expect(event).resolves.toBe(false)
    // five retries, each exactly one delay apart
    expect(at).toEqual([beganAt, beganAt + 30_000, beganAt + 60_000, beganAt + 90_000, beganAt + 120_000, beganAt + 150_000])
  })
})
