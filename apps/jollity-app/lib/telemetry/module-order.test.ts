// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it, vi } from "vitest"

const FIRST_IMPORTS = [
  ["failures", () => import("./failures")],
  ["log-event", () => import("./log-event")],
  ["game-log-outbox", () => import("./game-log-outbox")],
  ["health-event", () => import("./health-event")],
] as const

it.each(FIRST_IMPORTS)("initializes when %s is the first telemetry module imported", async (_name, load) => {
  vi.resetModules()
  await expect(load()).resolves.toBeDefined()
})
