// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { FOREGROUND_LITERALS } from "./foreground"
import { isMaskSafe } from "./testing"

describe("masking-safe foreground return vocabulary", () => {
  it.each(FOREGROUND_LITERALS.map((literal) => [literal]))("%s", (literal) => {
    expect(isMaskSafe(literal)).toBe(true)
  })
})
