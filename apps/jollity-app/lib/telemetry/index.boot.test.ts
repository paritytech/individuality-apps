// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ starts: 0 }))
vi.mock("./init", () => ({
  configFromEnvironment: () => ({ dsn: "https://key@o1.ingest.de.sentry.io/42" }),
  startTelemetryWith: () => ((state.starts += 1), true),
  telemetryStarted: () => state.starts > 0,
  setHostKind: () => {},
}))

beforeEach(() => {
  vi.resetModules()
  state.starts = 0
})

describe("booting telemetry", () => {

  it("starts once", async () => {
    const { startTelemetry } = await import("./index")
    startTelemetry()
    startTelemetry()
    expect(state.starts).toBe(1)
  })
})
