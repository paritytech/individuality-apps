// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Test fixtures for the chain-lost card: the probe results the tests share,
 * and an in-memory host storage to stand in for lib/host/storage. Used by
 * the chain-health, chain-restart and chain-lost-streak tests only.
 */
import type { ChainHealthResult } from "./chain-health"

/** a probe on a host whose chain subscription is gone */
export const LOST: ChainHealthResult = {
  outcome: "host-chain-lost",
  latencyMs: 4,
  errorClass: "cannot-get-current-block",
  error: "cannot get the current block: subscription dropped",
}
export const HEALTHY: ChainHealthResult = { outcome: "healthy", latencyMs: 9 }
export const TIMED_OUT: ChainHealthResult = {
  outcome: "unknown",
  latencyMs: 5000,
  errorClass: "timeout",
  error: "chain health probe timed out",
}

/** lib/host/storage over a Map: what vi.mock("./host/storage") returns */
export function memoryHostStorage(stored: Map<string, unknown>) {
  return {
    readStoredJSON: async (key: string) => stored.get(key) ?? null,
    writeStoredJSON: async (key: string, value: unknown) => {
      stored.set(key, value)
    },
    writeStoredString: async (key: string, value: string) => {
      if (value === "") stored.delete(key)
      else stored.set(key, value)
    },
  }
}
