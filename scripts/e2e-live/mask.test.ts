// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { addMasks } from "./mask"

const ACTIONS = { GITHUB_ACTIONS: "true" }
const collect = () => {
  const lines: string[] = []
  return { lines, write: (line: string) => void lines.push(line) }
}

describe("addMasks", () => {
  it("registers each value as a whole-line mask in GitHub Actions", () => {
    const { lines, write } = collect()
    expect(addMasks(["alpha beta gamma", " delta "], ACTIONS, write)).toBe(2)
    expect(lines).toEqual(["::add-mask::alpha beta gamma\n", "::add-mask::delta\n"])
  })
  it("masks each line of a multi-line value and skips empties", () => {
    const { lines, write } = collect()
    addMasks(["one\ntwo\r\n", "", undefined, "   "], ACTIONS, write)
    expect(lines).toEqual(["::add-mask::one\n", "::add-mask::two\n"])
  })
  it("prints nothing outside GitHub Actions", () => {
    const { lines, write } = collect()
    expect(addMasks(["alpha"], {}, write)).toBe(0)
    expect(lines).toEqual([])
  })
})
