// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { localEnv } from "../../../../packages/jollity-protocol/src/local-network.fixture"

type ProductAccount = Parameters<typeof import("./name-link").linkPlayerName>[0]

const wallet = vi.hoisted(() => ({
  sign: vi.fn<(request: unknown) => Promise<{ accountId: string; signature: Uint8Array }>>(async () => ({ accountId: `0x${"11".repeat(32)}`, signature: new Uint8Array(64) })),
}))
vi.mock("@parity/product-sdk", () => ({
  createApp: async () => ({ wallet: { signMessageWithDotNsIdentity: wallet.sign } }),
}))
vi.mock("@parity/product-sdk-host", () => ({
  getAccountsProvider: async () => ({ getProductAccountSigner: () => ({}) }),
}))
vi.mock("@individuality/name-link", () => ({
  linkName: async (options: { signAsRoot: (username: string, message: Uint8Array) => Promise<unknown> }) => {
    await options.signAsRoot("alice.testnet", Uint8Array.of(1, 2, 3))
    return "linked"
  },
}))
vi.mock("../engine", () => ({ assetHubClient: async () => ({}), peopleChainClient: () => ({}) }))
vi.mock("../host/identity", () => ({ knownDisplayName: async () => "alice.testnet" }))
vi.mock("../debug/log-store", () => ({ devLog: vi.fn() }))
vi.mock("../journeys/name-link-trace", () => ({
  traceNameLink: () => ({ skipped: vi.fn(), threw: vi.fn(), end: vi.fn(), stage: vi.fn(), facts: vi.fn(), warned: vi.fn() }),
}))

beforeEach(() => {
  vi.resetModules()
  wallet.sign.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe("name-link root signature chain", () => {
  it("uses the normalized local People genesis in the SDK descriptor", async () => {
    for (const [name, value] of Object.entries(localEnv)) vi.stubEnv(name, value)
    vi.stubEnv("NEXT_PUBLIC_PEOPLE_GENESIS", `0x${"Ab".repeat(32)}`)
    const { linkPlayerName } = await import("./name-link")
    expect(await linkPlayerName({ publicKey: new Uint8Array(32) } as ProductAccount, "register")).toBe("linked")
    const { previewnet_individuality: base } = await import("@parity/product-sdk-descriptors/previewnet-individuality")
    expect(wallet.sign).toHaveBeenCalledWith({
      peopleChain: { ...base, genesis: `0x${"ab".repeat(32)}` },
      username: "alice.testnet",
      message: Uint8Array.of(1, 2, 3),
    })
    expect(base.genesis).not.toBe(`0x${"ab".repeat(32)}`)
  })

  it.each(["paseo", "previewnet"])("preserves the %s descriptor", async (network) => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK_NAME", network)
    const { linkPlayerName } = await import("./name-link")
    expect(await linkPlayerName({ publicKey: new Uint8Array(32) } as ProductAccount, "register")).toBe("linked")
    const base = network === "paseo"
      ? (await import("@parity/product-sdk-descriptors/paseo-individuality")).paseo_individuality
      : (await import("@parity/product-sdk-descriptors/previewnet-individuality")).previewnet_individuality
    expect(wallet.sign.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ peopleChain: base }))
  })
})
