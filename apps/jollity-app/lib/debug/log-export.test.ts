// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { gameIndexOf, logFilename, type LogExportFacts } from "./log-export"
import type { TelemetryEntry } from "./telemetry"

const HASH = "16607c84ea3f3a0961094d3bf53a176d0d8c8065105761f6ced6013b070e3e62"
const ADDRESS = "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y"

const facts = (overrides: Partial<LogExportFacts> = {}): LogExportFacts => ({
  exportedAt: new Date("2026-09-30T14:23:46.497Z"),
  gameIndex: 141,
  username: "dave",
  address: ADDRESS,
  version: HASH,
  ...overrides,
})

const status = (data: unknown): TelemetryEntry => ({
  ts: 0,
  sessionId: "s",
  version: HASH,
  level: "info",
  tag: "status",
  message: "registration → waiting",
  data,
})

describe("logFilename", () => {
  it("names the date, the game, the player and the build", () => {
    expect(logFilename(facts())).toBe("jollity-logs-2026-09-30-g141-dave-v16607c84.json")
  })

  it("falls back to the start of the address without a username", () => {
    expect(logFilename(facts({ username: null }))).toBe("jollity-logs-2026-09-30-g141-5FLSigC9-v16607c84.json")
  })

  it("says anon with neither a username nor an address", () => {
    expect(logFilename(facts({ username: null, address: null }))).toBe(
      "jollity-logs-2026-09-30-g141-anon-v16607c84.json",
    )
  })

  it("leaves the game out when the log saw none", () => {
    expect(logFilename(facts({ gameIndex: null }))).toBe("jollity-logs-2026-09-30-dave-v16607c84.json")
  })

  it("keeps a username to characters any filesystem takes", () => {
    expect(logFilename(facts({ username: " Alice Smith/x:y " }))).toBe(
      "jollity-logs-2026-09-30-g141-alice-smith-x-y-v16607c84.json",
    )
  })

  it("falls back to the address when nothing of the username survives", () => {
    expect(logFilename(facts({ username: "✨✨" }))).toBe("jollity-logs-2026-09-30-g141-5FLSigC9-v16607c84.json")
  })

  it("keeps a local build version whole", () => {
    expect(logFilename(facts({ version: "0.1.0" }))).toBe("jollity-logs-2026-09-30-g141-dave-v0.1.0.json")
  })
})

describe("gameIndexOf", () => {
  it("prefers the newest game the player was registered in", () => {
    const entries = [
      status({ game: 140, registered: true }),
      status({ game: 141, registered: true }),
      status({ game: 142, registered: false }),
    ]
    expect(gameIndexOf(entries)).toBe(141)
  })

  it("falls back to the newest game seen", () => {
    expect(gameIndexOf([status({ game: 140, registered: false }), status({ game: 141, registered: false })])).toBe(
      141,
    )
  })

  it("ignores status lines without a game and lines of other tags", () => {
    const other: TelemetryEntry = { ...status({ game: 999, registered: true }), tag: "signup" }
    expect(gameIndexOf([status({ game: 141, registered: false }), status({ now: 1 }), other])).toBe(141)
  })

  it("is null when no status line names a game", () => {
    expect(gameIndexOf([status({ now: 1 }), status(null)])).toBeNull()
  })
})
