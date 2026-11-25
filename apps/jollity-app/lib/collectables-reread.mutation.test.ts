// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { collectablesRereadStep, createCollectablesRereadState } from "./collectables-reread"

describe("collectables reread mutation guards", () => {
  it("pins the exact start, recovery, failure and stop state", () => {
    const initial = createCollectablesRereadState()
    expect(initial).toEqual({ phase: "idle", failedRereads: 0, due: false, timerHeld: false })

    const started = collectablesRereadStep(initial, { kind: "start" })
    expect(started).toEqual({
      state: { phase: "waiting", failedRereads: 0, due: false, timerHeld: true },
      commands: [{ kind: "schedule", delayMs: 30_000 }],
    })
    const reading = collectablesRereadStep(started.state, { kind: "trigger", hidden: false })
    expect(reading.state).toEqual({ phase: "reading", failedRereads: 0, due: false, timerHeld: false })
    expect(collectablesRereadStep(reading.state, { kind: "read-finished", recovered: true, hidden: false }).state)
      .toEqual({ phase: "waiting", failedRereads: 0, due: false, timerHeld: false })
    expect(collectablesRereadStep(reading.state, { kind: "read-finished", recovered: false, hidden: true }).state)
      .toEqual({ phase: "waiting", failedRereads: 1, due: false, timerHeld: true })

    expect(collectablesRereadStep({ ...reading.state, due: true, timerHeld: true }, { kind: "stop" })).toEqual({
      state: { phase: "stopped", failedRereads: 0, due: false, timerHeld: false },
      commands: [{ kind: "clear-timer" }, { kind: "unsubscribe" }],
    })
  })
})
