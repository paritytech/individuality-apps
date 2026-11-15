// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { rtcPath } from "./peer-path"

describe("the path a peer connected over", () => {
  it.each([
    ["host/host", "direct"],
    ["srflx/host", "stun"],
    ["prflx/srflx", "stun"],
    ["relay/srflx", "relay"],
    ["host/relay", "relay"],
    ["?/?", "unknown"],
    [undefined, "unknown"],
  ] as const)("%s → %s", (pair, path) => {
    expect(rtcPath(pair)).toBe(path)
  })
})
