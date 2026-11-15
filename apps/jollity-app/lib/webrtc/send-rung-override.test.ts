// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { parseSendRung, resolveSendRungPin } from "./send-rung-override"

describe("parseSendRung", () => {
  it("maps rung names to indexes and rejects everything else", () => {
    expect(parseSendRung("full")).toBe(0)
    expect(parseSendRung("survival")).toBe(4)
    for (const bad of ["", "Survival", "off", "4", "nope", null, undefined]) expect(parseSendRung(bad)).toBeUndefined()
  })
})

describe("resolveSendRungPin", () => {
  it("is inert without the param", () => {
    expect(resolveSendRungPin("")).toBeUndefined()
    expect(resolveSendRungPin("?lowpower=1")).toBeUndefined()
  })
  it("reads ?sendRung=<name> among other params", () => {
    expect(resolveSendRungPin("?x=1&sendRung=survival")).toBe(4)
    expect(resolveSendRungPin("?sendRung=minimum")).toBe(3)
  })
  it("ignores an invalid name", () => expect(resolveSendRungPin("?sendRung=bogus")).toBeUndefined())
})
