// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { localEnv } from "../../../../packages/jollity-protocol/src/local-network.fixture"
import { chainEndpoints } from "./chain-endpoints"

afterEach(() => vi.unstubAllEnvs())
describe("draw chain endpoints", () => {
  it("uses explicit local endpoints even with a hosted or unknown suffix", () => {
    for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
    for (const suffix of ["testnet", "paseo", "unknown"]) {
      expect(chainEndpoints(suffix)).toEqual({ people: localEnv.NEXT_PUBLIC_PEOPLE_WS, assetHub: localEnv.NEXT_PUBLIC_ASSET_HUB_WS })
    }
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "")
    expect(() => chainEndpoints("testnet")).toThrow("NEXT_PUBLIC_PEOPLE_WS")
  })
  it("preserves suffix tables and optional overrides for existing networks", () => {
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "")
    vi.stubEnv("NEXT_PUBLIC_ASSET_HUB_WS", "")
    expect(chainEndpoints("testnet").people).toBe("wss://previewnet.substrate.dev/people")
    expect(chainEndpoints("paseo").assetHub).toBe("wss://paseo-asset-hub-next-rpc.polkadot.io")
    expect(chainEndpoints("unknown")).toEqual({ people: null, assetHub: null })
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "ws://override")
    expect(chainEndpoints("testnet").people).toBe("ws://override")
  })
})
