// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { assetHubNetwork, NETWORK_CONFIG, network, networkName, chainGenesis, localNetwork, deviceUniquenessBackendUrl, productAccount } from "./config"

describe("assetHubNetwork", () => {
  it("names the network whose Asset Hub has the genesis, in any case", () => {
    const paseo = NETWORK_CONFIG.paseo.genesis!.hubNextV2

    expect(assetHubNetwork(paseo)).toBe("paseo")
    expect(assetHubNetwork(`0x${paseo.slice(2).toUpperCase()}`)).toBe("paseo")
  })

  it("names no network for the People chain or an Asset Hub it does not know", () => {
    expect(assetHubNetwork(NETWORK_CONFIG.paseo.genesis!.people)).toBeUndefined()
    expect(assetHubNetwork(`0x${"00".repeat(32)}`)).toBeUndefined()
  })
})

const localEnv = {
  NEXT_PUBLIC_PEOPLE_WS: "ws://127.0.0.1:9944",
  NEXT_PUBLIC_PEOPLE_GENESIS: `0x${"12".repeat(32)}`,
  NEXT_PUBLIC_ASSET_HUB_WS: "wss://localhost:9945/hub",
  NEXT_PUBLIC_ASSET_HUB_GENESIS: `0x${"AB".repeat(32)}`,
  NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL: "http://localhost:8080/",
  NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS: "17, 18,17",
}
function selectLocal() {
  vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", "local")
  for (const [key, value] of Object.entries(localEnv)) vi.stubEnv(key, value)
}
afterEach(() => vi.unstubAllEnvs())

describe("local network", () => {
  it("resolves the explicit endpoints, hashes, backend and collections", () => {
    selectLocal()
    expect(networkName()).toBe("local")
    expect(localNetwork()?.endpoints).toEqual({ people: localEnv.NEXT_PUBLIC_PEOPLE_WS, assetHub: localEnv.NEXT_PUBLIC_ASSET_HUB_WS })
    expect(chainGenesis("people")).toBe(localEnv.NEXT_PUBLIC_PEOPLE_GENESIS)
    expect(chainGenesis("hubNextV2")).toBe(localEnv.NEXT_PUBLIC_ASSET_HUB_GENESIS.toLowerCase())
    expect(deviceUniquenessBackendUrl()).toBe("http://localhost:8080")
    expect(localNetwork()?.approvedCollections).toEqual([17, 18])
    expect(productAccount()).toBe("dim2.testnet")
  })

  it.each(Object.keys(localEnv))("names missing or blank %s through every runtime accessor", (name) => {
    for (const value of [undefined, "", "   "]) {
      selectLocal()
      vi.stubEnv(name, value)
      for (const read of [networkName, network, localNetwork, deviceUniquenessBackendUrl, () => chainGenesis("people"), () => chainGenesis("hubNextV2")]) {
        expect(read).toThrow(name)
      }
    }
  })

  it.each(["NEXT_PUBLIC_PEOPLE_WS", "NEXT_PUBLIC_ASSET_HUB_WS"])("names malformed %s", (name) => {
    for (const value of ["bad", "http://localhost", "ws:localhost", "ws://", "ws://localhost:bad", "ws://user:pass@localhost", "ws://local\nhost", "ws://localhost/#fragment"]) {
      selectLocal()
      vi.stubEnv(name, value)
      expect(network).toThrow(name)
    }
  })

  it.each(["NEXT_PUBLIC_PEOPLE_GENESIS", "NEXT_PUBLIC_ASSET_HUB_GENESIS"])("names malformed %s", (name) => {
    for (const value of ["12".repeat(32), `0x${"12".repeat(31)}`, `0x${"12".repeat(33)}`, `0x${"gg".repeat(32)}`]) {
      selectLocal()
      vi.stubEnv(name, value)
      expect(network).toThrow(name)
    }
  })

  it("requires an explicit HTTP identity/TURN backend without credentials", () => {
    for (const value of ["bad", "ws://localhost", "http:localhost", "https://user:pass@localhost", "https://localhost/#fragment"]) { // trufflehog:ignore (fake credential under test)
      selectLocal()
      vi.stubEnv("NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL", value)
      expect(deviceUniquenessBackendUrl).toThrow("NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL")
    }
  })

  it("rejects malformed collection ids rather than consulting the hosted registry", () => {
    for (const value of ["[]", "1,", "-1", "1.5", "NaN", "4294967296", "0x17", "1e2"]) {
      selectLocal()
      vi.stubEnv("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS", value)
      expect(network).toThrow("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS")
    }
  })

  it("normalizes both genesis hashes after validation", () => {
    selectLocal()
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_GENESIS", `0x${"Ab".repeat(32)}`)
    vi.stubEnv("NEXT_PUBLIC_ASSET_HUB_GENESIS", `0x${"CD".repeat(32)}`)
    expect(chainGenesis("people")).toBe(`0x${"ab".repeat(32)}`)
    expect(chainGenesis("hubNextV2")).toBe(`0x${"cd".repeat(32)}`)
  })

  it("trims local values and accepts a zero collection id", () => {
    selectLocal()
    for (const [key, value] of Object.entries(localEnv)) vi.stubEnv(key, ` ${value} `)
    vi.stubEnv("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS", "0,4294967295")
    expect(localNetwork()?.approvedCollections).toEqual([0, 4294967295])
    expect(chainGenesis("people")).toBe(localEnv.NEXT_PUBLIC_PEOPLE_GENESIS)
  })

  it("keeps existing networks and the unset-network refusal unchanged", () => {
    for (const name of ["paseo", "previewnet"] as const) {
      vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", name)
      vi.stubEnv("NEXT_PUBLIC_LOCAL_APPROVED_COLLECTIONS", "bad")
      expect(network()).toBe(NETWORK_CONFIG[name])
      expect(localNetwork()).toBeUndefined()
    }
    for (const name of [undefined, "", "Local", " local ", "typo", "toString"]) {
      vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", name)
      expect(network).toThrow("NEXT_PUBLIC_NETWORK_NAME")
    }
  })
})

it("preserves optional genesis and backend overrides on hosted networks", () => {
  for (const name of ["paseo", "previewnet"]) {
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", name)
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_GENESIS", "0xoverride-people")
    vi.stubEnv("NEXT_PUBLIC_ASSET_HUB_GENESIS", "0xoverride-hub")
    vi.stubEnv("NEXT_PUBLIC_DEVICE_UNIQUENESS_BACKEND_URL", "http://forwarder/")
    expect(chainGenesis("people")).toBe("0xoverride-people")
    expect(chainGenesis("hubNextV2")).toBe("0xoverride-hub")
    expect(deviceUniquenessBackendUrl()).toBe("http://forwarder")
  }
})
