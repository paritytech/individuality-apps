// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"

vi.mock("./engine", () => ({ assetHubClient: async () => ({}), peopleChainClient: () => ({}) }))
vi.mock("./draw/chain-endpoints", () => ({ chainEndpoints: () => ({ assetHub: null, people: null }) }))
vi.mock("@jollity/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@jollity/protocol")>()),
  network: () => ({ dotnsTLD: "paseo" }),
  productAccount: () => "dim2.paseo",
}))
vi.mock("@individuality/name-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@individuality/name-link")>()),
  dotnsNames: () => ({}),
  peopleNames: () => async () => null,
  reviveCall: () => async () => new Uint8Array(),
}))

import { nameReadError } from "./player-names"

describe("nameReadError", () => {
  it("names the kinds of failed read", () => {
    expect(nameReadError(new Error("ReadTimeoutError: no answer after 15 seconds"))).toBe("timeout")
    expect(nameReadError("turn/proof: no answer in 5000ms")).toBe("timeout")
    expect(nameReadError(Object.assign(new Error("p:17"), { name: "RequestTimeoutError" }))).toBe("timeout")
    expect(nameReadError(new Error("unknown follow subscription id FollowId(3)"))).toBe("chain-lost")
    expect(nameReadError(new Error("cannot get the current block"))).toBe("chain-lost")
    expect(nameReadError(new Error("Block 0x12 is not pinned (stop-storage)"))).toBe("not-pinned")
    expect(nameReadError(new Error("RPC error: subscription dropped"))).toBe("chain-lost")
    expect(nameReadError(new Error("WebSocket connection closed"))).toBe("disconnected")
    expect(nameReadError(new Error("TrUAPI host connection interrupted"))).toBe("disconnected")
    expect(nameReadError(new Error("Unexpected end of input while decoding"))).toBe("decode")
    expect(nameReadError(new Error("something else"))).toBe("other")
  })
})
