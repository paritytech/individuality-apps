// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { safeStringify, scrubMnemonic } from "./scrub"

const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident"

describe("the mnemonic guard", () => {
  it("redacts twelve lowercase words in a row", () => {
    expect(scrubMnemonic(`seed: ${PHRASE}, end`)).toBe("seed: [redacted: mnemonic-like string], end")
  })

  it("leaves eleven words alone", () => {
    const eleven = PHRASE.split(" ").slice(0, 11).join(" ")
    expect(scrubMnemonic(eleven)).toBe(eleven)
  })

  it("redacts a phrase buried in stringified data", () => {
    const text = safeStringify({ nested: { words: PHRASE } })
    expect(scrubMnemonic(text)).not.toContain("abandon")
  })
})

describe("the safe stringify", () => {
  it("writes bigints, bytes and cycles without throwing", () => {
    const cycle: Record<string, unknown> = { amount: 5n, bytes: new Uint8Array([1, 255]) }
    cycle.self = cycle
    expect(safeStringify(cycle)).toBe('{"amount":"5n","bytes":"0x01ff","self":"[circular]"}')
  })
})

describe("errors in log data", () => {
  it("writes an Error as its described text, not {}", () => {
    const error = new Error("send failed", { cause: new Error("socket closed") })
    expect(safeStringify(error)).toBe('"send failed <- socket closed"')
    expect(safeStringify({ detail: "x", error })).toBe('{"detail":"x","error":"send failed <- socket closed"}')
  })
})
