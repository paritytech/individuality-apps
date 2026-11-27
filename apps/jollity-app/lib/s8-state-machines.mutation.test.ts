// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { startCameraRecovery } from "./camera"
import { startLaunchStall } from "./launch-stall"
import { startReadRetry } from "./read-retry"

describe("S8 machine initial states", () => {
  it("pins every production initializer", () => {
    expect(startCameraRecovery()).toEqual({ retries: 0, deferred: false, scheduledAttempt: null, mutedStreak: 0, mutedChecks: 0, tap: "none" })
    expect(startLaunchStall()).toEqual({ phase: "armed" })
    expect(startReadRetry([10, 20])).toEqual({ phase: "idle", attempt: 0, delaysMs: [10, 20] })
  })
})
