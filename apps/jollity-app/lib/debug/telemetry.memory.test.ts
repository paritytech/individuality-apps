// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A host whose storage cannot be read: every host container deletes `window.indexedDB`
 * (host-rust-core js/container: freezeAndDelete(window, "indexedDB"); the iOS
 * and Android product containers do the same), so on a real phone and on a
 * live E2E bot the debug log lives in memory alone. A whole game must fit in
 * it, and the export (debug sheet, end-of-game log, the bots' recorder) must
 * read it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootTelemetry, stubPage } from "./test-boot"

const fault = vi.hoisted(() => ({ hangReads: false }))

vi.mock("../host/storage", () => ({
  tryReadStoredString: async () => (fault.hangReads ? new Promise(() => {}) : { ok: false }),
  writeStoredString: async () => {},
}))
vi.mock("../host/identity", () => ({ knownDisplayName: async () => null }))
vi.mock("../host/container", () => ({ hostPortParked: () => true, insideContainer: async () => true }))

beforeEach(() => {
  vi.resetModules()
  fault.hangReads = false
  // the host's lockdown: the property reads undefined
  stubPage({})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const boot = bootTelemetry

describe("the debug log without IndexedDB", () => {
  it("keeps only startup linkage in metadata when the full export excludes pre-game entries", async () => {
    vi.useFakeTimers()
    try {
      const { devLog, buildLogsExport, SESSION_ID } = await boot()
      const startup = Date.now()
      devLog("replay", "session.link", {
        schemaVersion: 1, sessionId: SESSION_ID, sequence: 1,
        buildCommit: "jollity-build-commit:cached", timing: { wallMs: startup },
        observation: { previousLogSessionId: "prior-page", lineageId: "same-tab" },
      })
      devLog("startup", "unrelated pre-game")
      const original = JSON.parse((await buildLogsExport()).json).entries.find((entry: { message: string }) => entry.message === "session.link")
      const gameAt = Date.now() + 1
      vi.setSystemTime(gameAt)
      devLog("game", "in-game line")
      const exported = JSON.parse((await buildLogsExport({ since: gameAt })).json)
      expect(exported.entries.map((entry: { message: string }) => entry.message)).toEqual(["in-game line"])
      expect(exported.meta.sessionLinks).toEqual([original])
      expect(exported.meta.sessionLinks[0]).toMatchObject({
        sessionId: SESSION_ID,
        data: { sequence: 1, timing: { wallMs: startup }, observation: { previousLogSessionId: "prior-page", lineageId: "same-tab" } },
      })
      expect(JSON.parse((await buildLogsExport()).json).meta.sessionLinks).toHaveLength(1)
      // An older game's bounded export must not gain a later page's startup.
      expect(JSON.parse((await buildLogsExport({ until: startup })).json).meta.sessionLinks).toEqual([])
      // Losing startup from the ordinary buffer cannot lose identity metadata.
      for (let index = 0; index < 6_000; index += 1) devLog("game", `line ${index}`)
      const capped = JSON.parse((await buildLogsExport({ since: gameAt })).json)
      expect(capped.entries.some((entry: { message: string }) => entry.message === "session.link")).toBe(false)
      expect(capped.meta.sessionLinks).toEqual([original])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a whole game's lines (more than the old 1000) and exports them from memory", async () => {
    const { devLog, buildLogsExport } = await boot()
    for (let i = 0; i < 2500; i++) devLog("rtc", `line ${i}`, { i })
    const { json, count } = await buildLogsExport()
    const parsed = JSON.parse(json) as { meta: { store: string }; entries: { message: string; data?: unknown }[] }
    expect(parsed.meta.store).toBe("memory")
    // + the session-start line initTelemetry writes
    expect(count).toBe(2501)
    expect(parsed.entries.at(-1)).toMatchObject({ message: "line 2499", data: { i: 2499 } })
  })

  it("drops the oldest lines past the byte cap, never the newest", async () => {
    const { devLog, buildLogsExport, MEMORY_CAP_BYTES } = await boot()
    const big = "x".repeat(4000)
    const lines = Math.ceil((MEMORY_CAP_BYTES * 2) / 4000)
    for (let i = 0; i < lines; i++) devLog("big", `line ${i}`, big)
    const parsed = JSON.parse((await buildLogsExport()).json) as { entries: { message: string }[] }
    expect(parsed.entries.length).toBeLessThan(lines)
    expect(parsed.entries.at(-1)?.message).toBe(`line ${lines - 1}`)
  })

  it("reports the in-memory count and bytes in the stats", async () => {
    const { devLog, getTelemetryStats } = await boot()
    devLog("t", "one")
    const stats = getTelemetryStats()
    expect(stats.count).toBe(2)
    expect(stats.approxBytes).toBeGreaterThan(0)
  })

  it("finishes an export when worker evidence storage never answers", async () => {
    vi.useFakeTimers()
    try {
      const { buildLogsExport } = await boot()
      fault.hangReads = true

      const exported = buildLogsExport()
      await vi.advanceTimersByTimeAsync(3_000)

      expect(JSON.parse((await exported).json)).toMatchObject({ worker: null })
    } finally {
      vi.useRealTimers()
    }
  })
})
