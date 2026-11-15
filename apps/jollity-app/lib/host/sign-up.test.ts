// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sign-up door, over a fake of the SDK's host capabilities: it asks for the
 * game account at the index it is given, keeps what the SDK built, signs with
 * the signer it was handed, and rejects when the host names no account.
 */
import { describe, expect, it, vi } from "vitest"
import type { AccountsProvider } from "@parity/product-sdk-host"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { signUpCapabilities } from "./sign-up"

const sdk = vi.hoisted(() => ({ hostGameRegistrationCapabilities: vi.fn() }))
vi.mock("@parity/product-sdk-individuality/host", () => sdk)

const ACCOUNTS = {} as AccountsProvider
const BUILT = {
  account: { address: "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw", publicKey: new Uint8Array(32).fill(7) },
  signer: { stock: true },
  submit: vi.fn(),
  signVrf: vi.fn(),
  personhood: { holds: vi.fn(), prove: vi.fn() },
}

describe("signUpCapabilities", () => {
  it("takes the SDK's capabilities for the game account at the index, signed by the signer it was handed", async () => {
    sdk.hostGameRegistrationCapabilities.mockResolvedValue({ ok: true, value: BUILT })
    const signer = { logged: true } as unknown as CommonSignerTxCreator

    const capabilities = await signUpCapabilities(ACCOUNTS, signer, { tld: "paseo", accountIndex: 1 })

    expect(sdk.hostGameRegistrationCapabilities).toHaveBeenCalledWith({ accounts: ACCOUNTS, tld: "paseo", accountIndex: 1 })
    expect(capabilities).toEqual({ ...BUILT, signer })
  })

  it("rejects with the SDK's error when the host names no account", async () => {
    const refused = new Error("the host would not name dim2.paseo/1")
    sdk.hostGameRegistrationCapabilities.mockResolvedValue({ ok: false, error: refused })

    await expect(signUpCapabilities(ACCOUNTS, {} as CommonSignerTxCreator, { tld: "paseo", accountIndex: 1 })).rejects.toBe(refused)
  })
})
