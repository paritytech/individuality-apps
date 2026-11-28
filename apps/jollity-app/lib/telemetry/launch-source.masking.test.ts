// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { LAUNCH_SOURCE_LITERALS } from "./launch-source"
import { isMaskSafe } from "./testing"

describe("masking-safe launch source vocabulary", () => {
  // the session.link attributes the launch source is recorded under
  // (session-record.ts), plus every value this lane can send
  const words = ["app.launch_source", "app.launch_detail", "app.concurrent_page", "true", "false", ...LAUNCH_SOURCE_LITERALS]
  it.each(words.map((word) => [word]))("%s", (word) => {
    expect(isMaskSafe(word)).toBe(true)
  })
})
