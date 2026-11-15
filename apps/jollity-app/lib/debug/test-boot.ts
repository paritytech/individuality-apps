// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Shared by the telemetry tests: one page load, and the browser globals it needs. */
import { vi } from "vitest"

export function stubPage(options: { indexedDB?: unknown; maxTouchPoints?: number; protocol?: string } = {}): void {
  vi.stubGlobal("indexedDB", options.indexedDB)
  vi.stubGlobal("window", { addEventListener: () => {}, innerWidth: 390, innerHeight: 844 })
  vi.stubGlobal("navigator", { userAgent: "test", language: "en", maxTouchPoints: options.maxTouchPoints ?? 5 })
  vi.stubGlobal("location", { hostname: "localhost", protocol: options.protocol ?? "http:" })
}

/** one page load: fresh module state, so a fresh SESSION_ID and an empty memory */
export async function bootTelemetry() {
  vi.resetModules()
  const log = await import("./log-store")
  const telemetry = await import("./telemetry")
  telemetry.initTelemetry()
  return { ...log, ...telemetry }
}
