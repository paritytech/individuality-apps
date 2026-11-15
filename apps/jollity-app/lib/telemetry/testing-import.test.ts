// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from "vitest"

// Several pure telemetry suites replace metrics with the shared fake through
// this async factory. Loading the fake must not circle back through the real
// delivery stack and leave module evaluation pending forever.
vi.mock("./metrics", async () => (await import("./testing")).fakeTelemetryModule())

it("loads the async telemetry fake without entering the delivery graph", async () => {
  const { recordForegroundReturn } = await import("./foreground")
  expect(recordForegroundReturn).toBeTypeOf("function")
}, 1_000)
