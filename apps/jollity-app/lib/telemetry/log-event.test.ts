// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  activeTraceId: "",
  live: true,
  scopeTags: { "game.index": "41", "net.type": "wifi" } as Record<string, string>,
  user: { id: "player-7", username: "alice" } as { id?: string; username?: string },
}))

const sendLogEnvelope = vi.hoisted(() => vi.fn())

vi.mock("@sentry/react", () => ({
  getActiveSpan: () => state.activeTraceId
    ? { spanContext: () => ({ traceId: state.activeTraceId }) }
    : undefined,
  getIsolationScope: () => ({ getUser: () => state.user }),
}))
vi.mock("./boot", () => ({ telemetryLive: () => state.live }))
vi.mock("./scope-tags", () => ({ scopeTagAttrs: () => state.scopeTags }))
vi.mock("./init", () => ({ sendLogEnvelope }))
vi.mock("../debug/session-id", () => ({ newId: () => "e".repeat(32) }))

import { stableHexId } from "./log-envelope"
import { logEvent } from "./log-event"

describe("logEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    state.activeTraceId = "a".repeat(32)
    state.live = true
    state.scopeTags = { "game.index": "41", "net.type": "wifi" }
    state.user = { id: "player-7", username: "alice" }
    sendLogEnvelope.mockReset().mockResolvedValue(true)
  })

  it("sends one record with typed attributes, scope identity and the active trace", () => {
    const now = new Date("2026-10-17T01:00:00.000Z").getTime()
    vi.spyOn(Date, "now").mockReturnValue(now)

    logEvent("chain.health", "warn", {
      "chain.name": "paseo",
      "chain.blocks": 12,
      degraded: true,
      absent: undefined,
    })

    expect(sendLogEnvelope).toHaveBeenCalledTimes(1)
    expect(sendLogEnvelope).toHaveBeenCalledWith("e".repeat(32), [{
      timestamp: now / 1000,
      level: "warn",
      body: "chain.health",
      trace_id: "a".repeat(32),
      severity_number: 13,
      attributes: {
        "game.index": { value: "41", type: "string" },
        "net.type": { value: "wifi", type: "string" },
        "user.id": { value: "player-7", type: "string" },
        "user.name": { value: "alice", type: "string" },
        "chain.name": { value: "paseo", type: "string" },
        "chain.blocks": { value: 12, type: "integer" },
        degraded: { value: true, type: "boolean" },
      },
    }])
  })

  it("masks detail and derives a stable fallback trace from the name and current time", () => {
    const now = new Date("2026-10-17T01:02:03.456Z").getTime()
    vi.spyOn(Date, "now").mockReturnValue(now)
    state.activeTraceId = ""

    logEvent("storage-slow", "error", {}, "Unauthorized password")

    const [, [record]] = sendLogEnvelope.mock.calls[0]!
    expect(record.body).toBe("storage-slow\tUnau*horized pa*sword")
    expect(record.trace_id).toBe(stableHexId(`storage-slow${now}`))
  })

  it("never throws when the sender throws", () => {
    sendLogEnvelope.mockImplementation(() => { throw new Error("transport exploded") })

    expect(() => logEvent("previous-session-end", "info", {})).not.toThrow()
  })
})
