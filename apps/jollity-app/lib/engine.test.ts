// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createClient } from "polkadot-api"

const localClients = vi.hoisted(() => ({
  people: vi.fn(() => ({ api: {}, client: { getBestBlocks: async () => [{ hash: "0xbest", number: 9 }] } })),
  ws: vi.fn((url: string) => ({ url })),
}))

vi.mock("@jollity/game-chain", () => ({
  createChainEngine: vi.fn(() => ({})),
  createPeopleClient: localClients.people,
  createPeopleClientFromProvider: vi.fn(),
}))
vi.mock("polkadot-api", () => ({ createClient: vi.fn() }))
vi.mock("polkadot-api/ws", () => ({ getWsProvider: localClients.ws }))
vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())

async function engineSeam(assetHubWs = "") {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
  vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "ws://people")
  vi.stubEnv("NEXT_PUBLIC_ASSET_HUB_WS", assetHubWs)
  const seam = await import("./engine")
  seam.resolveDevEngine()
  return seam
}

describe("the collectables screen chain pair", () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset()
    vi.mocked(createClient).mockImplementation(() => ({ getUnsafeApi: () => ({}) }) as never)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("asks for an Asset Hub again after none answered", async () => {
    const seam = await engineSeam()
    expect(await seam.resolveScarcityChain()).toBeNull()
    vi.stubEnv("NEXT_PUBLIC_ASSET_HUB_WS", "ws://asset-hub")
    expect(await seam.resolveScarcityChain()).not.toBeNull()
  })

  it("keeps the pair once an Asset Hub answered", async () => {
    const { resolveScarcityChain } = await engineSeam("ws://asset-hub")
    expect(await resolveScarcityChain()).toBe(await resolveScarcityChain())
  })
})

describe("the People genesis on app open", () => {
  it("measures the lookup and says whether a chain was found", async () => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "paseo")
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_WS", "")
    try {
      // the file-level mock is cached across resetModules, so its recorder is not
      // the one a fresh import of testing would give: mock again, in this registry
      vi.doMock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
      const { resolveHostEngine } = await import("./engine")
      const { resetAppOpenForTests } = await import("./journeys/app-open")
      const { journeysNamed, resetRecorded } = await import("./telemetry/testing")
      resetRecorded()
      resetAppOpenForTests()
      const sdk = {
        getHostChainInfo: async () => ({ chains: { People: "0xabc" } }),
        getHostProvider: async () => null,
        ChainNotSupportedError: class extends Error {},
      }
      await expect(resolveHostEngine(sdk as never)).resolves.toBeNull()
      const [journey] = journeysNamed("app-open")
      expect(journey.steps[0]).toMatchObject({ name: "chain.genesis", ended: true, endAttrs: { "chain.genesis": "none" } })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

it("uses local endpoints without consulting the host's public chain discovery", async () => {
  const { localEnv } = await import("../../../packages/jollity-protocol/src/local-network.fixture")
  for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
  try {
    vi.resetModules()
    const seam = await import("./engine")
    const sdk = { getHostChainInfo: vi.fn(), getHostProvider: vi.fn() }
    await seam.resolveHostEngine(sdk as never)
    expect(localClients.people).toHaveBeenCalledWith(localEnv.NEXT_PUBLIC_PEOPLE_WS)
    await seam.assetHubClient()
    expect(localClients.ws).toHaveBeenCalledWith(localEnv.NEXT_PUBLIC_ASSET_HUB_WS)
    expect(sdk.getHostChainInfo).not.toHaveBeenCalled()
    expect(sdk.getHostProvider).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})
