// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { runStateMachineSuite } from "./framework"
import {
  messageExpiryMachineDefinition,
  messageExpiryRegressions,
  messageExpiryTransitionTable,
  messageExpiryWitnesses,
} from "./message-expiry-clock.definition"

describe("message-expiry clock state-machine model", () => {
  it("matches the independent model and covers every state/event cell", async () => {
    const { coverage } = await runStateMachineSuite(messageExpiryMachineDefinition)
    expect(coverage.missing).toEqual([])
    expect(coverage.impossibleObserved).toEqual([])
    expect(coverage.hit).toBe(coverage.declared)
    expect(coverage.generatedSequenceLengths).toMatchObject({ count: 300, min: 0 })
  })

  it("keeps deterministic witnesses exhaustive", () => {
    const declared = Object.values(messageExpiryTransitionTable).flatMap(Object.values).length
    expect(messageExpiryWitnesses).toHaveLength(declared)
  })

  it("keeps the named #1060 expiry regressions", () => {
    expect(messageExpiryRegressions.map((entry) => entry.name)).toEqual([
      "fresh refusal retries once at the minimum margin",
      "stale refusal restamps without learning",
      "two rejected learning stamps double the next retry push",
      "a sibling acceptance keeps the smaller accepted margin",
      "device and chain margins stay independent",
    ])
  })
})
