// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { isMaskSafe } from "../telemetry/testing"
import { maskSafe, maskSafeValues } from "./mask-text"

describe("maskSafe", () => {
  it.each(["Unauthorized", "no credentials", "Bad PASSWORD here", "client secret missing", "AUTH failed"])("clears %s", (text) => {
    expect(isMaskSafe(text)).toBe(false)
    const safe = maskSafe(text)
    expect(isMaskSafe(safe)).toBe(true)
    expect(safe).toHaveLength(text.length)
  })
  it("keeps the rest readable and leaves clean text alone", () => {
    expect(maskSafe("Unauthorized")).toBe("Unau*horized")
    expect(maskSafe("no credentials")).toBe("no cr*dentials")
    expect(maskSafe("Invalid.Payment")).toBe("Invalid.Payment")
  })
  it("maps a record", () => {
    expect(maskSafeValues({ error: "Unauthorized", route: "free" })).toEqual({ error: "Unau*horized", route: "free" })
  })
})
