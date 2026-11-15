// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chat-icon regression guard. TrUAPI's host rejects registerBot/registerRoom
 * with "icon carries a scheme that cannot be rendered" for anything that isn't
 * empty, an https:// URL, or a data:image/{png,jpeg,gif,webp,avif} URL under
 * 64 KiB (host-rust-core's validate_chat_icon) — the old @novasamatech host
 * rendered a bare monogram string ("WG"/"J") as text, which is exactly what
 * shipped and broke on the ported stack. These tests assert the RULE, mirrored
 * in state.ts's isAcceptableChatIcon, not just today's BOT_ICON/ROOM_ICON value
 * — so a future edit that reverts to a placeholder string, swaps in an
 * unsupported media type, or lets the asset grow past the cap fails here
 * instead of only in a real sandbox deploy.
 */
import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import {
  BOT_ICON,
  CHAT_ICON_MAX_BYTES,
  ROOM_ICON,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_WRITE_DEADLINE_MS,
  isAcceptableChatIcon,
  isGameProduct,
  startWorkerHeartbeat,
  writeWorkerHeartbeat,
} from "./state"
import { decodeTelemetryEnvelope, telemetryRecords, type TelemetryRecord } from "./testing/telemetry-envelope"

describe("isAcceptableChatIcon — mirrors host-rust-core's validate_chat_icon", () => {
  it("accepts empty and whitespace-only icons", () => {
    expect(isAcceptableChatIcon("")).toBe(true)
    expect(isAcceptableChatIcon("   ")).toBe(true)
  })

  it("accepts an https:// URL", () => {
    expect(isAcceptableChatIcon("https://example.com/icon.png")).toBe(true)
  })

  it("accepts a data: URL for each of the five allowed image media types", () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(isAcceptableChatIcon(`data:${mediaType};base64,AAAA`)).toBe(true)
    }
  })

  it("rejects a bare string with no scheme — the exact bug this test guards against", () => {
    expect(isAcceptableChatIcon("WG")).toBe(false)
    expect(isAcceptableChatIcon("J")).toBe(false)
  })

  it("rejects an unsupported scheme (e.g. http://, not https://)", () => {
    expect(isAcceptableChatIcon("http://example.com/icon.png")).toBe(false)
  })

  it("rejects a data: URL whose media type is not one of the five allowed", () => {
    expect(isAcceptableChatIcon("data:image/svg+xml;base64,AAAA")).toBe(false)
    expect(isAcceptableChatIcon("data:text/plain;base64,AAAA")).toBe(false)
  })

  it("rejects anything at or over the 64 KiB cap, https:// or data: alike", () => {
    const overCapDataUrl = `data:image/png;base64,${"A".repeat(CHAT_ICON_MAX_BYTES)}`
    expect(isAcceptableChatIcon(overCapDataUrl)).toBe(false)

    const overCapHttps = `https://example.com/${"a".repeat(CHAT_ICON_MAX_BYTES)}.png`
    expect(isAcceptableChatIcon(overCapHttps)).toBe(false)
  })

  it("rejects a URL exactly AT the cap — the boundary itself, not just past it", () => {
    const prefix = "data:image/png;base64,"
    const exactlyAtCap = prefix + "A".repeat(CHAT_ICON_MAX_BYTES - prefix.length)
    expect(exactlyAtCap.length).toBe(CHAT_ICON_MAX_BYTES)
    expect(isAcceptableChatIcon(exactlyAtCap)).toBe(false)
  })

  it("accepts a URL one byte under the cap", () => {
    const prefix = "data:image/png;base64,"
    const oneUnderCap = prefix + "A".repeat(CHAT_ICON_MAX_BYTES - prefix.length - 1)
    expect(oneUnderCap.length).toBe(CHAT_ICON_MAX_BYTES - 1)
    expect(isAcceptableChatIcon(oneUnderCap)).toBe(true)
  })

  it("accepts a data: URL comfortably under the cap", () => {
    const underCapDataUrl = `data:image/png;base64,${"A".repeat(1000)}`
    expect(isAcceptableChatIcon(underCapDataUrl)).toBe(true)
  })
})

describe("the worker's actual bot/room icons", () => {
  it("BOT_ICON and ROOM_ICON both pass the host's rule", () => {
    expect(isAcceptableChatIcon(BOT_ICON)).toBe(true)
    expect(isAcceptableChatIcon(ROOM_ICON)).toBe(true)
  })

  it("carry the built PNG data URL, not a monogram placeholder", () => {
    expect(BOT_ICON.startsWith("data:image/png;base64,")).toBe(true)
    expect(ROOM_ICON.startsWith("data:image/png;base64,")).toBe(true)
  })

  it("the room keeps an icon of its own, apart from the bot's", () => {
    expect(ROOM_ICON).not.toBe(BOT_ICON)
  })

  it.each(["bot-icon.png", "room-icon.png"])(
    "the checked-in %s itself produces a data URL under the cap (build.mjs's own guard, exercised without running the build)",
    (file) => {
      const assetUrl = new URL(`../assets/${file}`, import.meta.url)
      const dataUrl = `data:image/png;base64,${readFileSync(assetUrl).toString("base64")}`
      expect(dataUrl.length).toBeLessThan(CHAT_ICON_MAX_BYTES)
      expect(isAcceptableChatIcon(dataUrl)).toBe(true)
    },
  )
})

describe("the game product works", () => {
  it("takes the dim2 label on any TLD for the game product, as truapi does, and no other name", () => {
    // Given
    const names = ["dim2.dot", "dim2.paseo", "dim2next.paseo", "app.dim2.dot", "dim2-pr83-sandbox00.paseo", "jollity.paseo", "dim2", ""]

    // When
    const game = names.filter(isGameProduct)

    // Then
    expect(game).toEqual(["dim2.dot", "dim2.paseo"])
  })
})

describe("worker log works", () => {
  it("keeps every entry when appends overlap", async () => {
    // Given
    const { workerLog } = await import("./state")
    const values = new Map<string, unknown>()
    const host = {
      storage: {
        readJSON: async (key: string) => {
          const value = values.get(key) ?? null
          await new Promise((resolve) => setTimeout(resolve, 1))
          return value
        },
        writeJSON: async (key: string, value: unknown) => {
          values.set(key, value)
        },
      },
    } as never

    // When
    await Promise.all([workerLog.append(host, "info", "one"), workerLog.append(host, "info", "two")])

    // Then
    expect((values.get("jollity.wg.workerLog") as { text: string }[]).map((entry) => entry.text)).toEqual(["one", "two"])
  })
})

describe("worker heartbeat", () => {
  it("stores this worker release and the current device time for the app", async () => {
    const writeJSON = vi.fn(async () => undefined)
    const host = { storage: { writeJSON } } as never

    await writeWorkerHeartbeat(host, 12_345, "jollity@abc123")

    expect(writeJSON).toHaveBeenCalledWith(WORKER_HEARTBEAT_KEY, {
      at: 12_345,
      release: "jollity@abc123",
    })
  })

  it("does not throw when the heartbeat cannot be stored", async () => {
    const host = { storage: { writeJSON: vi.fn(async () => Promise.reject(new Error("no storage"))) } } as never

    await expect(writeWorkerHeartbeat(host, 12_345, "jollity@abc123")).resolves.toBe(false)
  })

  it("refreshes independently and releases a permanently stuck write before the next pulse", async () => {
    vi.useFakeTimers()
    try {
      const writeJSON = vi.fn(() => new Promise<void>(() => {}))
      const stop = startWorkerHeartbeat({ storage: { writeJSON } } as never, 30_000)
      expect(writeJSON).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_WRITE_DEADLINE_MS - 1)
      expect(writeJSON).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_000 - WORKER_HEARTBEAT_WRITE_DEADLINE_MS + 1)
      expect(writeJSON).toHaveBeenCalledTimes(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("storage health", () => {
  it("reports a failed read once per key class, with the error text and not the game in the key", async () => {
    const { readJSON, writeJSON } = await import("./state")
    const { configureTelemetry, resetTelemetry } = await import("./telemetry")
    const sent: TelemetryRecord[] = []
    configureTelemetry({
      dsn: "https://k@o1.ingest.de.sentry.io/1",
      fetchImpl: async (_url, init) => {
        sent.push(...decodeTelemetryEnvelope(init.body))
      },
    })
    const host = {
      storage: { readJSON: async () => Promise.reject(new Error("no store")), writeJSON: async () => Promise.reject(new Error("no store")) },
    } as never
    await readJSON(host, "jollity.wg.recap:1800")
    await readJSON(host, "jollity.wg.recap:1900")
    await writeJSON(host, "jollity.wg.recap:1900", {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    resetTelemetry()
    expect(sent.filter((record) => record.kind === "metric").map((e) => [e.name, e.value, e.tags.key_class])).toEqual([
      ["chat.storage.read_failed", 1, "jollity.wg.recap"],
      ["chat.storage.write_failed", 1, "jollity.wg.recap"],
    ])
    expect(telemetryRecords(sent, "chat.storage.read_failed", "log")).toHaveLength(1)
    expect(telemetryRecords(sent, "chat.storage.write_failed", "log")).toHaveLength(1)
  })
})
