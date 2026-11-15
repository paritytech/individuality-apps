// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { CALL_DEADLINE_MS, MIGRATIONS_KEY, NOTIFICATIONS_KEY, type StorageHost } from "../state"
import { configureTelemetry, resetTelemetry } from "../telemetry"
import openingNoticeAgain from "./001-opening-notice-again"
import { MIGRATIONS, runMigrations, type Migration } from "."
import { decodeTelemetryEnvelope, telemetryRecords, type TelemetryRecord } from "../testing/telemetry-envelope"

function storageHost(entries: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(entries))
  const host: StorageHost = {
    storage: {
      readJSON: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)) as StorageHost["storage"]["readJSON"],
      writeJSON: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value)
      }),
      readProductJSON: vi.fn().mockResolvedValue(null) as StorageHost["storage"]["readProductJSON"],
    },
  }
  return { host, store }
}

function migration(number: number, run: Migration["run"] = vi.fn().mockResolvedValue(undefined)): Migration {
  return { number, name: `test-${number}`, run }
}

describe("running the migrations works", () => {
  it("runs the ones above the stored number in order, and stores each number before running it", async () => {
    // Given
    const { host, store } = storageHost({ [MIGRATIONS_KEY]: 1 })
    const seen: unknown[] = []
    const record = (): Promise<void> => {
      seen.push(store.get(MIGRATIONS_KEY))
      return Promise.resolve()
    }
    const first = migration(1)

    // When
    await runMigrations(host, [first, migration(2, record), migration(3, record)])

    // Then
    expect(first.run).not.toHaveBeenCalled()
    expect(seen).toEqual([2, 3])
    expect(store.get(MIGRATIONS_KEY)).toBe(3)
  })

  it("runs each one once across boots", async () => {
    // Given
    const { host } = storageHost()
    const once = migration(1)

    // When
    await runMigrations(host, [once])
    await runMigrations(host, [once])

    // Then
    expect(once.run).toHaveBeenCalledTimes(1)
  })

  it("lists the migrations in order with no number used twice", () => {
    // When
    const numbers = MIGRATIONS.map((m) => m.number)

    // Then
    expect(numbers).toEqual(MIGRATIONS.map((_, i) => i + 1))
  })

  it("counts each outcome", async () => {
    try {
      // Given
      const events: TelemetryRecord[] = []
      configureTelemetry({
        dsn: "https://k@o1.ingest.de.sentry.io/1",
        product: "dim2.paseo",
        fetchImpl: async (_url, init) => {
          events.push(...decodeTelemetryEnvelope(init.body))
        },
      })
      const { host } = storageHost()

      // When
      await runMigrations(host, [migration(1), migration(2, vi.fn().mockRejectedValue(new Error("boom")))])

      // Then
      const counted = telemetryRecords(events, "chat.migration", "metric")
      expect(counted.map((event) => event.value)).toEqual([1, 1])
      const tags = counted.map((event) => event.tags)
      expect(tags).toEqual([
        expect.objectContaining({ migration: "1 test-1", outcome: "applied" }),
        expect.objectContaining({ migration: "2 test-2", outcome: "failed" }),
      ])
    } finally {
      resetTelemetry()
    }
  })
})

describe("running the migrations fails", () => {
  it("runs none when the stored number cannot be read", async () => {
    // Given
    const { host } = storageHost()
    vi.mocked(host.storage.readJSON).mockRejectedValue(new Error("no storage"))
    const first = migration(1)

    // When
    await runMigrations(host, [first])

    // Then
    expect(first.run).not.toHaveBeenCalled()
  })

  it("stops when the number cannot be stored, so the next boot runs it", async () => {
    // Given
    const { host, store } = storageHost()
    vi.mocked(host.storage.writeJSON).mockRejectedValueOnce(new Error("full"))
    const first = migration(1)
    const second = migration(2)

    // When
    await runMigrations(host, [first, second])

    // Then
    expect(first.run).not.toHaveBeenCalled()
    expect(second.run).not.toHaveBeenCalled()
    expect(store.has(MIGRATIONS_KEY)).toBe(false)
  })

  it("carries on past a migration that throws, and never runs it again", async () => {
    // Given
    const { host, store } = storageHost()
    const broken = migration(1, vi.fn().mockRejectedValue(new Error("boom")))
    const next = migration(2)

    // When
    await runMigrations(host, [broken, next])
    await runMigrations(host, [broken, next])

    // Then
    expect(broken.run).toHaveBeenCalledTimes(1)
    expect(next.run).toHaveBeenCalledTimes(1)
    expect(store.get(MIGRATIONS_KEY)).toBe(2)
  })

  it("gives up on a migration that never finishes, and carries on", async () => {
    vi.useFakeTimers()
    try {
      // Given
      const { host, store } = storageHost()
      const stuck = migration(1, () => new Promise<void>(() => {}))
      const next = migration(2)
      let finished = false

      // When
      void runMigrations(host, [stuck, next]).then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS)

      // Then
      expect(finished).toBe(true)
      expect(next.run).toHaveBeenCalledTimes(1)
      const log = (store.get("jollity.wg.workerLog") as { text: string }[]).map((entry) => entry.text)
      expect(log).toContainEqual(expect.stringContaining("Migration 1 test-1 failed:"))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("migration 1 sends the opening notice again", () => {
  const game = 1_800_000_000

  it("drops the spent opening notice and keeps every other moment", async () => {
    // Given
    const { host, store } = storageHost({
      [NOTIFICATIONS_KEY]: {
        gamePlayTime: game,
        registered: false,
        hostReminds: false,
        ids: [9, 10],
        moments: { [`opens:${game}`]: { id: 9, at: Date.now() - 60_000 }, [`close-1h:${game}`]: { id: 10, at: Date.now() + 3_600_000 } },
        stale: [],
        complete: true,
      },
    })

    // When
    await openingNoticeAgain.run(host)

    // Then
    expect(store.get(NOTIFICATIONS_KEY)).toMatchObject({
      ids: [10],
      moments: { [`close-1h:${game}`]: { id: 10 } },
      stale: [],
      complete: true,
    })
    expect(Object.keys((store.get(NOTIFICATIONS_KEY) as { moments: object }).moments)).toEqual([`close-1h:${game}`])
  })

  it("hands an opening notice still to come to the stale ids, so the next booking cancels it", async () => {
    // Given
    const at = Date.now() + 7_200_000
    const { host, store } = storageHost({
      [NOTIFICATIONS_KEY]: { gamePlayTime: game, registered: false, ids: [9], moments: { [`opens:${game}`]: { id: 9, at } }, stale: [{ id: 3, at }] },
    })

    // When
    await openingNoticeAgain.run(host)

    // Then
    expect(store.get(NOTIFICATIONS_KEY)).toMatchObject({ ids: [], moments: {}, stale: [{ id: 3, at }, { id: 9, at }] })
  })

  it("leaves an empty key and a record without moments alone", async () => {
    // Given
    const idsOnly = { gamePlayTime: game, registered: false, ids: [9, 10], complete: true }
    const empty = storageHost()
    const older = storageHost({ [NOTIFICATIONS_KEY]: idsOnly })

    // When
    await openingNoticeAgain.run(empty.host)
    await openingNoticeAgain.run(older.host)

    // Then
    expect(empty.store.has(NOTIFICATIONS_KEY)).toBe(false)
    expect(older.store.get(NOTIFICATIONS_KEY)).toEqual(idsOnly)
  })

  it("fails when the record cannot be read, rather than pass for done", async () => {
    // Given
    const { host } = storageHost()
    vi.mocked(host.storage.readJSON).mockRejectedValue(new Error("no storage"))

    // When
    const run = openingNoticeAgain.run(host)

    // Then
    await expect(run).rejects.toThrow("could not be read")
  })

  it("fails when the record cannot be written, rather than pass for done", async () => {
    // Given
    const { host } = storageHost({
      [NOTIFICATIONS_KEY]: {
        gamePlayTime: game,
        registered: false,
        ids: [9],
        moments: { [`opens:${game}`]: { id: 9, at: Date.now() - 60_000 } },
        stale: [],
      },
    })
    vi.mocked(host.storage.writeJSON).mockRejectedValue(new Error("quota"))

    // When
    const run = openingNoticeAgain.run(host)

    // Then
    await expect(run).rejects.toThrow("could not be written")
  })

  it("drops an opening notice whose push never answered, without a stale id", async () => {
    // Given
    const { host, store } = storageHost({
      [NOTIFICATIONS_KEY]: {
        gamePlayTime: game,
        registered: false,
        ids: [10],
        moments: {
          [`opens:${game}`]: { id: null, at: Date.now() + 5_000, pushing: true },
          [`close-1h:${game}`]: { id: 10, at: Date.now() + 3_600_000 },
        },
        stale: [],
      },
    })

    // When
    await openingNoticeAgain.run(host)

    // Then
    const record = store.get(NOTIFICATIONS_KEY) as { moments: object; stale: unknown[] }
    expect(Object.keys(record.moments)).toEqual([`close-1h:${game}`])
    expect(record.stale).toEqual([])
  })
})
