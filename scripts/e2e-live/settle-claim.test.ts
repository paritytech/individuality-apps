// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { SETTLE_LIMIT, h160FromOwner, hex, labelOwnerKey, settleCalldata, settledByDryRun, settlePayer, unhex } from "./settle-claim"

describe("settlePayer", () => {
  it("previewnet pays from //Alice, paseo-next-v2 from the dev-seed root", () => {
    expect(settlePayer("previewnet")).toEqual({ derivation: "//Alice", expected: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" })
    expect(settlePayer("paseo-next-v2")).toEqual({ derivation: "", expected: "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV" })
  })
})

describe("labelOwnerKey", () => {
  it("is twox128(DotnsGateway) ++ twox128(LiteLabelOwner) ++ blake2_128_concat(compact-length label)", () => {
    expect(labelOwnerKey("jollitypv.33")).toBe(
      "0x57ca9018d648b40a8286a471e82c3808" + "fd6d83e29558d6c9f6558f7b19f9b5f1" + "80c8c5e4f433533479d374573d8a38bf" + "306a6f6c6c69747970762e3333",
    )
  })
  it("refuses a label too long for the one-byte compact prefix", () => {
    expect(() => labelOwnerKey("a".repeat(64))).toThrow(/too long/)
  })
})

describe("h160FromOwner", () => {
  it("is the last 20 bytes of keccak256 of the 32-byte account", () => {
    expect(hex(h160FromOwner("0x" + "01".repeat(32)))).toBe("0xb312bec018884c2d66667c67a90508214bd8bafc")
  })
  it("takes the account from the tail of a longer storage value", () => {
    expect(hex(h160FromOwner("0x" + "ff".repeat(4) + "01".repeat(32)))).toBe("0xb312bec018884c2d66667c67a90508214bd8bafc")
  })
})

describe("settleCalldata", () => {
  it("is selector ++ left-padded address ++ limit word", () => {
    const h160 = unhex("0xb312bec018884c2d66667c67a90508214bd8bafc")
    const data = settleCalldata(h160)
    expect(data.length).toBe(4 + 32 + 32)
    expect(hex(data.slice(0, 4))).toBe("0xb9eb52d4")
    expect(hex(data.slice(4, 36))).toBe("0x" + "00".repeat(12) + "b312bec018884c2d66667c67a90508214bd8bafc")
    expect(hex(data.slice(36))).toBe("0x" + "00".repeat(31) + SETTLE_LIMIT.toString(16).padStart(2, "0"))
  })
})

describe("settledByDryRun", () => {
  const word = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0))
  it("reads the settled count from the first return word", () => {
    expect(settledByDryRun({ success: true, value: { flags: 0, data: word(1) } })).toBe(1)
    expect(settledByDryRun({ success: true, value: { flags: 0, data: word(0) } })).toBe(0)
  })
  it("throws on a failed or reverted dry-run", () => {
    expect(() => settledByDryRun({ success: false, value: "boom" })).toThrow(/dry-run failed/)
    expect(() => settledByDryRun({ success: true, value: { flags: 1, data: word(0) } })).toThrow(/dry-run failed/)
  })
})
