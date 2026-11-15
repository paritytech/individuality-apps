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

describe("metrics and the boot", () => {
  it("a metric starts telemetry when nobody has, like every doorway function", async () => {
    const { recordCount } = await import("./metrics")
    recordCount("ui.long_tasks", 1, {})
    expect(state.starts).toBe(1)
  })
})
