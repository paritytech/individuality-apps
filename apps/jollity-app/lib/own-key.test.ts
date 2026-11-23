// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("./telemetry/health-event", () => ({ sendTelemetryHealth: async () => true }))
vi.mock("./debug/log-store", () => ({ devLog: () => {}, getDevLogEntries: () => [] }))

const host = vi.hoisted(() => ({
  /** what the next key lookup answers */
  lookup: null as unknown,
  /** the sign-up surface read: never answers unless a test resolves it */
  surface: null as null | Promise<{ surface: string; humanityRead: string }>,
}))
vi.mock("./host/communication-key", () => ({
  lookUpSignallingSecret: async (_player: string, engine: { communicationIdentifier: (player: string) => Promise<unknown> }) => {
    await engine.communicationIdentifier("alice")
    return host.lookup
  },
}))
vi.mock("./host/game-registration", () => ({
  humanityProduct: () => "peopl.paseo",
  readSignUpSurface: vi.fn(() => host.surface),
}))

import { recorded, resetRecorded } from "./telemetry/testing"
import * as trace from "./journeys/game-trace"
import { readSignUpSurface } from "./host/game-registration"
import { ownKeySecret } from "./own-key"

const SECRET = new Uint8Array(32).fill(7)
const engine = () => ({
  communicationIdentifier: vi.fn(async () => new Uint8Array(65)),
  game: vi.fn(async () => ({ index: 9 }) as never),
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetRecorded()
  trace.resetGameTraceForTests()
  vi.mocked(readSignUpSurface).mockClear()
  host.surface = new Promise(() => {})
})

describe("the transport's own-key lookup", () => {
  it("answers the secret at once while the sign-up surface read never answers", async () => {
    host.lookup = { secret: SECRET, cause: "found", source: "humanity" }
    expect(await ownKeySecret("alice", engine())()).toBe(SECRET)
  })

  it("answers a definite miss as null, and sends the failure only once the sign-up surface read is back", async () => {
    trace.beginJoin({ cameraWarm: false })
    let answer: (facts: { surface: string; humanityRead: string }) => void = () => {}
    host.surface = new Promise((resolve) => (answer = resolve))
    host.lookup = { secret: null, cause: "read-refused", reads: { own: "answered", humanity: "refused" }, refusal: "AccessNotGranted" }

    expect(await ownKeySecret("alice", engine())()).toBeNull()
    await flush()
    expect(recorded.failures).toHaveLength(0)

    answer({ surface: "unreadable", humanityRead: "refused" })
    await flush()
    expect(recorded.failures).toEqual([
      expect.objectContaining({
        kind: "own-key-missing",
        details: expect.objectContaining({
          reason: "read-refused",
          context: expect.objectContaining({ refusal: "AccessNotGranted", "signup.surface": "unreadable", humanity_product: "peopl.paseo" }),
        }),
      }),
    ])
  })

  it("answers a lookup whose reads gave no answer as no-answer, and sends nothing", async () => {
    trace.beginJoin({ cameraWarm: false })
    host.surface = Promise.resolve({ surface: "humanity", humanityRead: "ok" })
    host.lookup = { secret: null, cause: "no-answer", reads: { own: "no-answer", humanity: "answered" } }

    expect(await ownKeySecret("alice", engine())()).toBe("no-answer")
    await flush()
    expect(recorded.failures).toHaveLength(0)
  })

  it("reads the game once, and the sign-up surface once per game, over many tries", async () => {
    host.lookup = { secret: null, cause: "no-match", reads: { own: "answered", humanity: "answered" } }
    host.surface = Promise.resolve({ surface: "none", humanityRead: "ok" })
    const chain = engine()
    const secret = ownKeySecret("alice", chain)
    for (let i = 0; i < 4; i++) await secret()
    await flush()
    expect(chain.game).toHaveBeenCalledTimes(1)
    expect(readSignUpSurface).toHaveBeenCalledTimes(1)
    expect(readSignUpSurface).toHaveBeenCalledWith(9)
  })

  it("takes the game from the session once it has said, with no chain read", async () => {
    host.lookup = { secret: SECRET, cause: "found", source: "jollity" }
    trace.beginJoin({ cameraWarm: false })
    trace.noteGame(12, 0)
    const chain = engine()
    await ownKeySecret("alice", chain)()
    await flush()
    expect(chain.game).not.toHaveBeenCalled()
    expect(readSignUpSurface).toHaveBeenCalledWith(12)
  })
})
