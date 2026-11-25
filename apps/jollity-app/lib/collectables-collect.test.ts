// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { collectablesShouldOpen, type CollectState } from "./collectables-collect"

const at = (state: Partial<CollectState>): CollectState => ({ landed: true, waited: false, collected: 0, shown: 0, allIn: false, ...state })

describe("when the collecting vessel opens", () => {
  it("never before it lands, or with nothing in it", () => {
    expect(collectablesShouldOpen(at({ landed: false, collected: 3, shown: 3, allIn: true }))).toBe(false)
    expect(collectablesShouldOpen(at({ waited: true, collected: 0 }))).toBe(false)
  })

  it("at once when everything is in and has flown in", () => {
    expect(collectablesShouldOpen(at({ collected: 8, shown: 8, allIn: true }))).toBe(true)
    // still flying in
    expect(collectablesShouldOpen(at({ collected: 5, shown: 8, allIn: true }))).toBe(false)
  })

  it("with what came, once it has collected for the whole wait", () => {
    expect(collectablesShouldOpen(at({ collected: 4, shown: 5 }))).toBe(false)
    expect(collectablesShouldOpen(at({ waited: true, collected: 4, shown: 5 }))).toBe(true)
  })

  it("on the first claim, when nothing came in the wait", () => {
    expect(collectablesShouldOpen(at({ waited: true, collected: 0 }))).toBe(false)
    expect(collectablesShouldOpen(at({ waited: true, collected: 1, shown: 1 }))).toBe(true)
  })
})
