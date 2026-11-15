// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A restart in a host: no IndexedDB, but host storage outlives the page. The
 * "page" dies by dropping the module state (vi.resetModules); the storage map
 * stays. The export after the restart must carry the first session's lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootTelemetry, stubPage } from "./test-boot"

const hostStore = new Map<string, string>()
const fault = { failReads: false }

vi.mock("../host/identity", () => ({ knownDisplayName: async () => null }))
vi.mock("../host/container", () => ({ hostPortParked: () => true }))
vi.mock("../host/storage", () => ({
  tryReadStoredString: async (key: string) => (fault.failReads ? { ok: false } : { ok: true, value: hostStore.get(key) ?? "" }),
  writeStoredString: async (key: string, value: string) => void hostStore.set(key, value),
}))

beforeEach(() => {
  hostStore.clear()
  fault.failReads = false
  vi.resetModules()
  stubPage({})
})

afterEach(() => vi.unstubAllGlobals())

const boot = bootTelemetry

interface Exported {
  meta: { store: string; sessionId: string; sessionCount: number }
  entries: { lineId: string; message: string; sessionId: string; ts: number }[]
}

const FLUSH = 11_000

describe("the debug log across a restart in a host", () => {
  it("exports the reopened page's original link and previous-page lineage outside the game time range", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("replay", "session.link", { sessionId: first.SESSION_ID, observation: { logSessionId: first.SESSION_ID, lineageId: "same-tab", previousLogSessionId: null } })
      const second = await boot()
      const startupAt = Date.now()
      second.devLog("replay", "session.link", {
        sessionId: second.SESSION_ID, sequence: 1, timing: { wallMs: startupAt },
        observation: { logSessionId: second.SESSION_ID, lineageId: "same-tab", previousLogSessionId: first.SESSION_ID },
      })
      const original = JSON.parse((await second.buildLogsExport()).json).entries.find((entry: { message: string }) => entry.message === "session.link")
      vi.setSystemTime(startupAt + 1)
      second.devLog("telemetry", "game 953 handover", { at: Date.now() })
      const exported = JSON.parse((await second.buildLogsExport({ since: startupAt + 1 })).json)
      expect(exported.entries.map((entry: { message: string }) => entry.message)).toEqual(["game 953 handover"])
      expect(exported.meta.sessionLinks).toEqual([original])
      expect(exported.meta.sessionLinks[0]).toMatchObject({
        sessionId: second.SESSION_ID,
        data: { timing: { wallMs: startupAt }, observation: { previousLogSessionId: first.SESSION_ID, lineageId: "same-tab" } },
      })
      expect(exported.meta.sessionLinks.some((entry: { sessionId: string }) => entry.sessionId === first.SESSION_ID)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("carries the first session's game lines into the second session's export, each under its own sessionId", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("telemetry", "game 7 handover", { at: Date.now() })
      first.devLog("rtc", "first session line", { n: 1 })
      await vi.advanceTimersByTimeAsync(FLUSH)
      const firstId = first.SESSION_ID

      const second = await boot()
      expect(second.SESSION_ID).not.toBe(firstId)
      second.devLog("rtc", "second session line")
      const parsed = JSON.parse((await second.buildLogsExport()).json) as Exported
      expect(parsed.meta.store).toBe("ring+memory")
      expect(parsed.meta.sessionCount).toBe(2)
      const byMessage = new Map(parsed.entries.map((entry) => [entry.message, entry.sessionId]))
      expect(byMessage.get("first session line")).toBe(firstId)
      expect(byMessage.get("second session line")).toBe(second.SESSION_ID)
      const lineIds = new Map(parsed.entries.map((entry) => [entry.message, entry.lineId]))
      expect(lineIds.get("first session line")).toMatch(new RegExp(`^${firstId}:\\d+$`))
      expect(lineIds.get("second session line")).toMatch(new RegExp(`^${second.SESSION_ID}:\\d+$`))
    } finally {
      vi.useRealTimers()
    }
  })

  it("persists the game window only: lines before the handover stay in memory", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("boot", "idle noise")
      first.devLog("telemetry", "game 7 handover", { at: Date.now() })
      first.devLog("rtc", "in game")
      await vi.advanceTimersByTimeAsync(FLUSH)
      const second = await boot()
      const messages = (JSON.parse((await second.buildLogsExport()).json) as Exported).entries.map((entry) => entry.message)
      expect(messages).toContain("in game")
      expect(messages).not.toContain("idle noise")
      // queued once, however the line reached memory
      expect(messages.filter((message) => message === "game 7 handover")).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("honours the window for the earlier session (a late upload's since and until)", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const first = await boot()
      first.devLog("telemetry", "game 7 handover", { at: 1_000_000 })
      vi.setSystemTime(2_000_000)
      first.devLog("t", "in window")
      vi.setSystemTime(3_000_000)
      first.devLog("t", "after")
      await vi.advanceTimersByTimeAsync(FLUSH)
      const second = await boot()
      const parsed = JSON.parse((await second.buildLogsExport({ since: 1_500_000, until: 2_500_000 })).json) as Exported
      expect(parsed.entries.map((entry) => entry.message)).toEqual(["in window"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the persisted lines after the game's log is sent, until the next game's handover releases them", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const first = await boot()
      first.devLog("telemetry", "game 7 handover", { at: 1_000_000 })
      first.devLog("rtc", "game 7 line")
      await vi.advanceTimersByTimeAsync(FLUSH)
      // the payoff send got a 2xx: queueing stops, the ring stays
      first.stopPersistingLog([7])
      first.devLog("chest", "after the game")
      await vi.advanceTimersByTimeAsync(FLUSH)

      const second = await boot()
      const kept = (JSON.parse((await second.buildLogsExport()).json) as Exported).entries.map((entry) => entry.message)
      expect(kept).toContain("game 7 line")
      expect(kept).not.toContain("after the game")

      vi.setSystemTime(2_000_000)
      second.devLog("telemetry", "game 8 handover", { at: 2_000_000 })
      second.devLog("rtc", "game 8 line")
      await second.releasePersistedLogBefore(2_000_000)
      await vi.advanceTimersByTimeAsync(FLUSH)

      const third = await boot()
      const after = (JSON.parse((await third.buildLogsExport()).json) as Exported).entries.map((entry) => entry.message)
      expect(after).not.toContain("game 7 line")
      expect(after).toEqual(expect.arrayContaining(["game 8 handover", "game 8 line"]))
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps persisting the next game when the previous game's 2xx lands after its handover", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("telemetry", "game 7 handover", { at: Date.now() })
      first.devLog("telemetry", "game 8 handover", { at: Date.now() })
      // game 7's delayed 2xx: game 8's marker write has not landed yet
      first.stopPersistingLog([7])
      first.devLog("rtc", "game 8 line")
      await vi.advanceTimersByTimeAsync(FLUSH)
      const second = await boot()
      const messages = (JSON.parse((await second.buildLogsExport()).json) as Exported).entries.map((entry) => entry.message)
      expect(messages).toContain("game 8 line")
    } finally {
      vi.useRealTimers()
    }
  })

  it("falls back to this session's memory, never to an overwrite, when host storage cannot be read", async () => {
    vi.useFakeTimers()
    try {
      const first = await boot()
      first.devLog("telemetry", "game 7 handover", { at: Date.now() })
      first.devLog("t", "kept")
      await vi.advanceTimersByTimeAsync(FLUSH)
      const stored = new Map(hostStore)
      fault.failReads = true
      const second = await boot()
      second.devLog("telemetry", "game 7 handover", { at: Date.now() })
      second.devLog("t", "second")
      await vi.advanceTimersByTimeAsync(FLUSH)
      const parsed = JSON.parse((await second.buildLogsExport()).json) as Exported
      expect(parsed.meta.store).toBe("memory")
      expect(parsed.entries.map((entry) => entry.message)).toContain("second")
      expect(hostStore).toEqual(stored)
    } finally {
      vi.useRealTimers()
    }
  })
})
