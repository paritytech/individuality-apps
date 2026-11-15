// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { chestRereadStep, createChestRereadState } from "./chest-reread"

describe("chest reread mutation guards", () => {
  it("pins the exact start, recovery, failure and stop state", () => {
    const initial = createChestRereadState()
    expect(initial).toEqual({ phase: "idle", failedRereads: 0, due: false, timerHeld: false })

    const started = chestRereadStep(initial, { kind: "start" })
    expect(started).toEqual({
      state: { phase: "waiting", failedRereads: 0, due: false, timerHeld: true },
      commands: [{ kind: "schedule", delayMs: 30_000 }],
    })
    const reading = chestRereadStep(started.state, { kind: "trigger", hidden: false })
    expect(reading.state).toEqual({ phase: "reading", failedRereads: 0, due: false, timerHeld: false })
    expect(chestRereadStep(reading.state, { kind: "read-finished", recovered: true, hidden: false }).state)
      .toEqual({ phase: "waiting", failedRereads: 0, due: false, timerHeld: false })
    expect(chestRereadStep(reading.state, { kind: "read-finished", recovered: false, hidden: true }).state)
      .toEqual({ phase: "waiting", failedRereads: 1, due: false, timerHeld: true })

    expect(chestRereadStep({ ...reading.state, due: true, timerHeld: true }, { kind: "stop" })).toEqual({
      state: { phase: "stopped", failedRereads: 0, due: false, timerHeld: false },
      commands: [{ kind: "clear-timer" }, { kind: "unsubscribe" }],
    })
  })
})
