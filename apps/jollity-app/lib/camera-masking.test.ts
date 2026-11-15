// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { isMaskSafe } from "./telemetry/testing"

describe("masking-safe camera return retry vocabulary", () => {
  it.each(["camera.trigger", "return", "open"].map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})
