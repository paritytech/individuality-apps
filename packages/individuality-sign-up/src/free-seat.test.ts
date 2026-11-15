// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { readSequence } from "./free-seat"

describe("readSequence — the newest read wins", () => {
  it("applies reads that arrive in order", () => {
    const reads = readSequence()
    const a = reads.next()
    const b = reads.next()
    expect(reads.apply(a)).toBe(true)
    expect(reads.apply(b)).toBe(true)
  })
  it("drops a result older than the last one applied", () => {
    const reads = readSequence()
    const older = reads.next()
    const newer = reads.next()
    expect(reads.apply(newer)).toBe(true)
    expect(reads.apply(older)).toBe(false)
  })
  it("applies a result only once", () => {
    const reads = readSequence()
    const only = reads.next()
    expect(reads.apply(only)).toBe(true)
    expect(reads.apply(only)).toBe(false)
  })
})
