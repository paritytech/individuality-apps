// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { backoffMs, SUPERVISOR_TIMING } from "../../webrtc/supervisor-timing"

const FAIL_COUNTS = Array.from({ length: 65 }, (_, n) => n) // 0..64

describe("C1 backoffMs sweep", () => {
  it("matches the exact table for failCount 0 to 3", () => {
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([3000, 6000, 12000, 20000])
  })
  it("is 20000 for every failCount from 3 to 64 and for 1024", () => {
    for (const n of [...FAIL_COUNTS.slice(3), 1024]) expect(backoffMs(n), `failCount ${n}`).toBe(20000)
  })
  it("never decreases as failCount grows from 0 to 64", () => {
    for (const n of FAIL_COUNTS.slice(1)) expect(backoffMs(n), `failCount ${n}`).toBeGreaterThanOrEqual(backoffMs(n - 1))
  })
  it("stays between 3000 and 20000 for every failCount from 0 to 64", () => {
    for (const n of FAIL_COUNTS) {
      expect(backoffMs(n), `failCount ${n}`).toBeGreaterThanOrEqual(3000)
      expect(backoffMs(n), `failCount ${n}`).toBeLessThanOrEqual(20000)
    }
  })
  it("takes its base and cap from SUPERVISOR_TIMING", () => {
    expect(SUPERVISOR_TIMING.backoffBaseMs).toBe(3000)
    expect(SUPERVISOR_TIMING.backoffMaxMs).toBe(20000)
  })
})
