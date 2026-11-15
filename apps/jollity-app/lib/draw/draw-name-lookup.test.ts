// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())
vi.mock("../engine", () => ({ assetHubClient: async () => ({}), peopleChainClient: () => ({}) }))
vi.mock("./chain-endpoints", () => ({ chainEndpoints: () => ({ assetHub: null, people: null }) }))
vi.mock("@jollity/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jollity/protocol")>()),
  network: () => ({ dotnsTLD: "paseo" }),
  productAccount: () => "dim2.paseo",
}))
const lookup = vi.fn()
vi.mock("@individuality/name-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@individuality/name-link")>()),
  dotnsNames: () => ({ lookup }),
  peopleNames: () => async () => null,
  reviveCall: () => async () => new Uint8Array(),
}))

import { recorded, resetRecorded } from "../telemetry/testing"
import { readDrawName } from "./draw-name-lookup"
import type { DrawWheel } from "./prize-draw"
import { winnersByRule } from "./wheel/rule"

const slot = (n: number) => n.toString(16).padStart(64, "0")
const HOLDER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"

/** three tickets, one winner, every ticket held by HOLDER */
function wheel(overrides: Partial<DrawWheel> = {}): DrawWheel {
  const tickets = [slot(1), slot(2), slot(3)]
  return { tickets, target: slot(2), winners: 1, holders: Object.fromEntries(tickets.map((t) => [t, HOLDER])), ...overrides }
}

beforeEach(() => {
  resetRecorded()
  lookup.mockReset()
})

describe("a name read for the wheel, in Sentry (#456)", () => {
  it("counts a named winner, with the read's time", async () => {
    lookup.mockResolvedValue({ name: "alice.05", why: "signed by the holder's root", reason: "named" })
    const draw = wheel()
    const [winner] = winnersByRule(draw.tickets, draw.target, draw.winners)

    expect(await readDrawName(draw, winner!)).toBe("alice.05")

    expect(recorded.metrics).toEqual([
      { type: "count", name: "draw.name_lookup", value: 1, attrs: { "name.outcome": "named", "name.ticket": "winner" } },
      { type: "distribution", name: "draw.name_lookup_ms", value: expect.any(Number), unit: "millisecond", attrs: { "name.outcome": "named", "name.ticket": "winner" } },
    ])
  })

  it("counts a nameless ticket by the lookup's reason", async () => {
    lookup.mockResolvedValue({ name: null, why: "the holder has no store", reason: "no-store" })

    expect(await readDrawName(wheel(), slot(3))).toBeNull()

    expect(recorded.metrics[0]).toMatchObject({ name: "draw.name_lookup", attrs: { "name.outcome": "no-store", "name.ticket": "other" } })
  })

  it("counts a ticket the chain lists no holder for, without a read", async () => {
    expect(await readDrawName(wheel({ holders: {} }), slot(1))).toBeNull()

    expect(lookup).not.toHaveBeenCalled()
    expect(recorded.metrics[0]?.attrs["name.outcome"]).toBe("no-holder")
  })

  it("counts a read that failed, with why as one word", async () => {
    lookup.mockRejectedValue(new Error("ReviveApi.call timed out"))

    expect(await readDrawName(wheel(), slot(1))).toBeNull()

    expect(recorded.metrics[0]?.attrs).toMatchObject({ "name.outcome": "read-failed", "name.error": "timeout" })
  })

  it("puts no error on a read that worked", async () => {
    lookup.mockResolvedValue({ name: "alice.05", why: "signed by the holder's root", reason: "named" })

    await readDrawName(wheel(), slot(1))

    expect(recorded.metrics[0]?.attrs["name.error"]).toBeUndefined()
  })

})
