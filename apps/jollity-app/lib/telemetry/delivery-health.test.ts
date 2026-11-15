// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const stored = vi.hoisted(() => new Map<string, string>())
const writeStoredString = vi.hoisted(() => vi.fn(async (key: string, value: string) => void stored.set(key, value)))
const tryReadStoredString = vi.hoisted(() => vi.fn())
vi.mock("../host/storage", () => ({
  tryReadStoredString,
  writeStoredString,
}))

import {
  deliveryHealthForGame,
  deliveryHealthObserver,
  closeDeliveryHealthGame,
  closeDeliveryHealthGameIfOpen,
  flushDeliveryHealthWritesForTests,
  pendingDeliveryHealth,
  markDeliveryHealthLogSent,
  markDeliveryHealthSent,
  ORPHAN_AFTER_MS,
  resetDeliveryHealthForTests,
  setDeliveryHealthGame,
} from "./delivery-health"
import { createQueue } from "./queue"

const RATE_ZERO = { unknownLanes: 0, failed429Server: 0, failed429Local: 0, limited2xx: 0, rateLimitLast: "", rateLimitReasons: "" }

beforeEach(() => {
  stored.clear()
  writeStoredString.mockClear()
  tryReadStoredString.mockReset().mockImplementation(async (key: string) => ({ ok: true as const, value: stored.get(key) ?? null }))
  resetDeliveryHealthForTests()
})

describe("persistent delivery health", () => {
  it("persists an all-zero game so its summary is never silently absent", async () => {
    setDeliveryHealthGame(31)
    await flushDeliveryHealthWritesForTests()
    closeDeliveryHealthGame(31)
    await flushDeliveryHealthWritesForTests()
    expect(await pendingDeliveryHealth()).toHaveLength(1)
    expect(await deliveryHealthForGame(31)).toEqual({
      game: {
        failed: { fetch: 0, "4xx": 0, "429": 0, "5xx": 0, timeout: 0 },
        retries: 0,
        droppedEvents: 0,
        droppedMetrics: 0,
        offlineMs: 0,
        recoveredTimeouts: 0,
        longestWaitMs: 0,
        ...RATE_ZERO,
      },
      session: {
        failed: { fetch: 0, "4xx": 0, "429": 0, "5xx": 0, timeout: 0 },
        retries: 0,
        droppedEvents: 0,
        droppedMetrics: 0,
        offlineMs: 0,
        recoveredTimeouts: 0,
        longestWaitMs: 0,
        ...RATE_ZERO,
      },
    })
  })

  it("records every failure class, retry, drop and delay for the session and active game", async () => {
    setDeliveryHealthGame(32)
    deliveryHealthObserver.failed("fetch")
    deliveryHealthObserver.failed("4xx")
    deliveryHealthObserver.failed("429")
    deliveryHealthObserver.failed("5xx")
    deliveryHealthObserver.failed("timeout")
    deliveryHealthObserver.retried()
    deliveryHealthObserver.dropped("event")
    deliveryHealthObserver.dropped("metric")
    deliveryHealthObserver.offline(340)
    deliveryHealthObserver.deliveredAfter(880)
    deliveryHealthObserver.deliveredAfter(20)
    await flushDeliveryHealthWritesForTests()

    const expected = {
      failed: { fetch: 1, "4xx": 1, "429": 1, "5xx": 1, timeout: 1 },
      retries: 1,
      droppedEvents: 1,
      droppedMetrics: 1,
      offlineMs: 340,
      recoveredTimeouts: 0,
      longestWaitMs: 880,
      ...RATE_ZERO,
    }
    expect(await deliveryHealthForGame(32)).toEqual({ game: expected, session: expected })

    resetDeliveryHealthForTests()
    expect(await deliveryHealthForGame(32)).toEqual({ game: expected, session: expected })
  })

  it("stores only games and pending, then drops a fully sent record", async () => {
    setDeliveryHealthGame(33)
    deliveryHealthObserver.retried()
    await flushDeliveryHealthWritesForTests()
    closeDeliveryHealthGame(33)
    await markDeliveryHealthLogSent(33)
    await markDeliveryHealthSent(33)
    await flushDeliveryHealthWritesForTests()
    const persisted = JSON.parse([...stored.values()][0] ?? "{}")
    expect(persisted).toEqual({ games: {}, pending: [] })
  })

  it("debounces real changes and skips a shorter delivered-after sample", async () => {
    vi.useFakeTimers()
    setDeliveryHealthGame(34)
    await flushDeliveryHealthWritesForTests()
    writeStoredString.mockClear()
    deliveryHealthObserver.deliveredAfter(880)
    deliveryHealthObserver.deliveredAfter(20)
    expect(writeStoredString).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(writeStoredString).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it("keeps at most one coalesced write behind a slow host-storage write", async () => {
    vi.useFakeTimers()
    setDeliveryHealthGame(35)
    await flushDeliveryHealthWritesForTests()
    writeStoredString.mockClear()
    let release: (() => void) | undefined
    writeStoredString.mockImplementationOnce(
      async (key: string, value: string) =>
        await new Promise<undefined>((resolve) => {
          stored.set(key, value)
          release = () => resolve(undefined)
        }),
    )

    deliveryHealthObserver.deliveredAfter(10)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writeStoredString).toHaveBeenCalledTimes(1)
    deliveryHealthObserver.failed("fetch")
    await vi.advanceTimersByTimeAsync(1_000)
    deliveryHealthObserver.retried()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writeStoredString).toHaveBeenCalledTimes(1)

    release?.()
    await flushDeliveryHealthWritesForTests()
    expect(writeStoredString).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it("does not rewrite the game store for session-only changes", async () => {
    setDeliveryHealthGame(null)
    await flushDeliveryHealthWritesForTests()
    writeStoredString.mockClear()
    deliveryHealthObserver.failed("fetch")
    await Promise.resolve()
    expect(writeStoredString).not.toHaveBeenCalled()
  })

  it("bounds a delivered health record when its game log never arrives", async () => {
    setDeliveryHealthGame(1)
    closeDeliveryHealthGame(1)
    await markDeliveryHealthSent(1)
    for (let game = 2; game <= 6; game += 1) setDeliveryHealthGame(game)
    await flushDeliveryHealthWritesForTests()

    const persisted = JSON.parse([...stored.values()][0] ?? "{}")
    expect(persisted.games).not.toHaveProperty("1")
    expect(persisted.games).toHaveProperty("6")
  })

  it("does not renew a closed record's retention timestamp on later boots", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-01T12:00:00+02:00"))
    setDeliveryHealthGame(7)
    closeDeliveryHealthGame(7)
    await flushDeliveryHealthWritesForTests()
    const first = JSON.parse([...stored.values()][0] ?? "{}").games["7"].updatedAt
    writeStoredString.mockClear()

    vi.setSystemTime(new Date("2026-10-02T12:00:00+02:00"))
    closeDeliveryHealthGame(7)
    await flushDeliveryHealthWritesForTests()
    const second = JSON.parse([...stored.values()][0] ?? "{}").games["7"].updatedAt
    expect(second).toBe(first)
    expect(writeStoredString).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("closes an obsolete signup-tag record when a later game is seen, across reload", async () => {
    setDeliveryHealthGame(20)
    deliveryHealthObserver.failed("fetch")
    setDeliveryHealthGame(21)
    await flushDeliveryHealthWritesForTests()

    resetDeliveryHealthForTests()
    expect(await pendingDeliveryHealth()).toEqual([
      expect.objectContaining({ gameIndex: 20, game: expect.objectContaining({ failed: expect.objectContaining({ fetch: 1 }) }) }),
    ])
  })

  it("closes and queues a signup-only record after its bounded orphan age", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-09T00:00:00+02:00"))
    setDeliveryHealthGame(40)
    await flushDeliveryHealthWritesForTests()
    const raw = JSON.parse([...stored.values()][0] ?? "{}")
    raw.games["40"].updatedAt = Date.now() - ORPHAN_AFTER_MS - 1
    stored.set("jollity.telemetry.delivery-health.v1", JSON.stringify(raw))

    resetDeliveryHealthForTests()
    expect(await pendingDeliveryHealth()).toEqual([expect.objectContaining({ gameIndex: 40 })])
    await markDeliveryHealthLogSent(40)
    await markDeliveryHealthSent(40)
    await flushDeliveryHealthWritesForTests()
    expect(JSON.parse([...stored.values()][0] ?? "{}")).toEqual({ games: {}, pending: [] })
    vi.useRealTimers()
  })

  it("does not overwrite stored games until a failed initial read succeeds", async () => {
    setDeliveryHealthGame(50)
    deliveryHealthObserver.failed("fetch")
    await flushDeliveryHealthWritesForTests()
    const before = stored.get("jollity.telemetry.delivery-health.v1")

    resetDeliveryHealthForTests()
    writeStoredString.mockClear()
    tryReadStoredString.mockResolvedValue({ ok: false as const, error: new Error("host storage not ready") })
    setDeliveryHealthGame(51)
    await flushDeliveryHealthWritesForTests()
    expect(writeStoredString).not.toHaveBeenCalled()
    expect(stored.get("jollity.telemetry.delivery-health.v1")).toBe(before)

    tryReadStoredString.mockImplementation(async (key: string) => ({ ok: true as const, value: stored.get(key) ?? null }))
    await flushDeliveryHealthWritesForTests()
    const after = JSON.parse(stored.get("jollity.telemetry.delivery-health.v1") ?? "{}")
    expect(Object.keys(after.games)).toEqual(["50", "51"])
    expect(after.games["50"].game.failed.fetch).toBe(1)
  })

  it("blocks health reads until a failed initial store read succeeds", async () => {
    setDeliveryHealthGame(60)
    deliveryHealthObserver.failed("fetch")
    closeDeliveryHealthGame(60)
    await flushDeliveryHealthWritesForTests()

    resetDeliveryHealthForTests()
    vi.useFakeTimers()
    tryReadStoredString
      .mockResolvedValueOnce({ ok: false as const, error: new Error("host storage not ready") })
      .mockImplementation(async (key: string) => ({ ok: true as const, value: stored.get(key) ?? null }))
    let settled = false
    const health = deliveryHealthForGame(60).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(health).resolves.toMatchObject({ game: { failed: { fetch: 1 } } })
    await closeDeliveryHealthGameIfOpen(60)
    expect(await pendingDeliveryHealth()).toEqual([expect.objectContaining({ gameIndex: 60 })])
    vi.useRealTimers()
  })

  it("ignores an older signup read that resolves after the current game", async () => {
    setDeliveryHealthGame(102)
    deliveryHealthObserver.retried()
    setDeliveryHealthGame(101)
    await flushDeliveryHealthWritesForTests()

    expect(await pendingDeliveryHealth()).toEqual([])
    const persisted = JSON.parse([...stored.values()][0] ?? "{}")
    expect(Object.keys(persisted.games)).toEqual(["102"])
    expect(persisted.games["102"].game.retries).toBe(1)
  })

  it("splits rate limits by kind, keeps the latest header and distinct reasons, and survives a reload", async () => {
    setDeliveryHealthGame(34)
    const org = { kind: "server_429" as const, header: "60:error;attachment:organization:usage_exceeded", entries: [{ categories: ["error", "attachment"], scope: "organization", reason: "usage_exceeded" }] }
    deliveryHealthObserver.rateLimited?.(org)
    deliveryHealthObserver.rateLimited?.(org)
    deliveryHealthObserver.rateLimited?.({ kind: "limited_2xx", header: "5:metric_bucket:key:spike_protection", entries: [{ categories: ["metric_bucket"], scope: "key", reason: "spike_protection" }] })
    deliveryHealthObserver.rateLimited?.({ kind: "local_drop", entries: [] })
    await flushDeliveryHealthWritesForTests()
    resetDeliveryHealthForTests()
    const { game } = await deliveryHealthForGame(34)
    expect(game).toMatchObject({
      failed429Server: 2,
      failed429Local: 1,
      limited2xx: 1,
      rateLimitLast: "5:metric_bucket:key:spike_protection",
      rateLimitReasons: "organization:usage_exceeded:error;attachment|key:spike_protection:metric_bucket",
    })
  })

  it("persists one numeric delivery-health count per unknown queue lane", async () => {
    setDeliveryHealthGame(36)
    const queue = createQueue<number>({
      lanes: { names: ["event"], of: () => "log" },
      observer: deliveryHealthObserver,
    })
    queue.setSender(async () => true)
    await Promise.all([queue.push(1), queue.push(2)])
    await flushDeliveryHealthWritesForTests()
    resetDeliveryHealthForTests()

    const { game, session } = await deliveryHealthForGame(36)
    expect(game.unknownLanes).toBe(1)
    expect(session.unknownLanes).toBe(1)
    expect(typeof game.unknownLanes).toBe("number")
  })

  it("caps the reasons summary", () => {
    setDeliveryHealthGame(35)
    for (let i = 0; i < 40; i++) {
      deliveryHealthObserver.rateLimited?.({ kind: "server_429", entries: [{ categories: ["error"], scope: `scope${i}`, reason: "usage_exceeded" }] })
    }
    return deliveryHealthForGame(35).then(({ session }) => {
      expect(session.rateLimitReasons.length).toBeLessThanOrEqual(300)
      expect(session.failed429Server).toBe(40)
    })
  })
})
