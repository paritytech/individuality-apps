// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { bindTx, withExtrinsicLogging, type SubmittableTx } from "./tx"

function fakeSigner(hex: string): CommonSignerTxCreator {
  return Object.assign(vi.fn().mockResolvedValue(hex), {
    publicKey: new Uint8Array(32).fill(1),
    signBytes: vi.fn().mockResolvedValue(new Uint8Array(64)),
  }) as unknown as CommonSignerTxCreator
}

const payload = {} as Parameters<CommonSignerTxCreator>[0]
const bindings = {} as Parameters<CommonSignerTxCreator>[2]

describe("withExtrinsicLogging", () => {
  it("reports the built extrinsic as hex with its byte length and passes it through untouched", async () => {
    const log = vi.fn()
    const built = await withExtrinsicLogging(fakeSigner("0x0400abff"), log)(payload, {}, bindings, false)

    expect(built).toBe("0x0400abff")
    expect(log).toHaveBeenCalledWith("0x0400abff", 4)
  })

  it("passes a build with a mocked signature through without reporting it", async () => {
    const log = vi.fn()
    const built = await withExtrinsicLogging(fakeSigner("0x0400abff"), log)(payload, {}, bindings, true)

    expect(built).toBe("0x0400abff")
    expect(log).not.toHaveBeenCalled()
  })

  it("keeps the rest of the signer surface (publicKey, signBytes)", async () => {
    const inner = fakeSigner("0x01")
    const wrapped = withExtrinsicLogging(inner, () => {})

    expect(wrapped.publicKey).toBe(inner.publicKey)
    await wrapped.signBytes(new Uint8Array([9]))
    expect(inner.signBytes).toHaveBeenCalled()
  })
})
describe("bindTx", () => {
  const disabled = { VerifyMultiSignature: { value: { type: "Disabled", value: undefined } } }
  const fakeTx = () => ({ createAndSubmit: vi.fn(), createSubmitAndWatch: vi.fn() }) satisfies SubmittableTx

  it("submits with its signer and sends VerifyMultiSignature as Disabled beside the options of the caller", () => {
    const signer = fakeSigner("0x01")
    const tx = fakeTx()

    bindTx(tx, signer).createAndSubmit({ at: "best" })

    expect(tx.createAndSubmit).toHaveBeenCalledWith(signer, { at: "best", customSignedExtensions: disabled })
  })

  it("watches with its signer and sends VerifyMultiSignature as Disabled beside the options of the caller", () => {
    const signer = fakeSigner("0x01")
    const tx = fakeTx()

    bindTx(tx, signer).createSubmitAndWatch({ at: "best" })

    expect(tx.createSubmitAndWatch).toHaveBeenCalledWith(signer, { at: "best", customSignedExtensions: disabled })
  })
})
