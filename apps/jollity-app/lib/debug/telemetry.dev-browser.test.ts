// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A plain development browser: no host, so lib/host/storage.ts falls back to
 * localStorage and the SAME chunk ring holds the game window there. IndexedDB
 * is never touched (it is deleted in every host, so it is not a store).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootTelemetry, stubPage } from "./test-boot"

const local = new Map<string, string>()
const indexedDBOpen = vi.fn()

vi.mock("../host/identity", () => ({ knownDisplayName: async () => null }))
vi.mock("../host/container", () => ({ hostPortParked: () => false, insideContainer: async () => false }))

beforeEach(() => {
  local.clear()
  indexedDBOpen.mockClear()
  vi.resetModules()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
  })
  stubPage({ indexedDB: { open: indexedDBOpen }, maxTouchPoints: 0 })
})

afterEach(() => vi.unstubAllGlobals())

const boot = bootTelemetry

interface Exported {
  meta: { store: string; sessionCount: number }
  entries: { message: string; sessionId: string }[]
  worker: {
    log: { time: number; kind: string; text: string }[]
    notifications: { gamePlayTime: number; registered: boolean; idCount: number; complete: boolean; retryAt: number | null } | null
  } | null
}

describe("the debug log in a development browser", () => {
  it("never opens IndexedDB, and exports this session from memory plus an empty ring", async () => {
    const { devLog, buildLogsExport } = await boot()
    devLog("rtc", "a line", { n: 1 })
    const parsed = JSON.parse((await buildLogsExport()).json) as Exported
    expect(indexedDBOpen).not.toHaveBeenCalled()
    // the ring (localStorage here) was readable and held no earlier session
    expect(parsed.meta.store).toBe("ring+memory")
    expect(parsed.meta.sessionCount).toBe(1)
    expect(parsed.entries.map((entry) => entry.message)).toContain("a line")
  })

  it("includes pre-handover worker evidence without exporting opaque notification ids", async () => {
    local.set(
      "jollity.wg.workerLog",
      JSON.stringify([{ time: 100, kind: "success", text: "Notification permission granted." }]),
    )
    local.set(
      "jollity.wg.notifs",
      JSON.stringify({ gamePlayTime: 300, registered: true, ids: [987_654], complete: true }),
    )
    const { buildLogsExport } = await boot()

    const json = (await buildLogsExport({ since: 200 })).json
    const parsed = JSON.parse(json) as Exported

    expect(parsed.worker).toEqual({
      log: [{ time: 100, kind: "success", text: "Notification permission granted." }],
      notifications: { gamePlayTime: 300, registered: true, idCount: 1, complete: true, retryAt: null },
    })
    expect(json).not.toContain("987654")
    expect(json).not.toContain('"ids"')
  })

  it("carries the game window across a reload through localStorage", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("telemetry", "game 7 handover", { at: Date.now() })
      first.devLog("rtc", "first session line")
      await vi.advanceTimersByTimeAsync(11_000)
      expect([...local.keys()].some((key) => key.startsWith("jollity.debug-log"))).toBe(true)

      const second = await boot()
      const parsed = JSON.parse((await second.buildLogsExport()).json) as Exported
      expect(parsed.meta.store).toBe("ring+memory")
      expect(parsed.entries.map((entry) => entry.message)).toContain("first session line")
      expect(parsed.meta.sessionCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reads no ring on a boot that never exports", async () => {
    const reads = vi.spyOn(localStorage, "getItem")
    const { devLog } = await boot()
    devLog("boot", "idle noise")
    expect(reads).not.toHaveBeenCalled()
  })

  it("writes nothing outside a game window", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("boot", "idle noise")
      await vi.advanceTimersByTimeAsync(11_000)
      expect(local.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
