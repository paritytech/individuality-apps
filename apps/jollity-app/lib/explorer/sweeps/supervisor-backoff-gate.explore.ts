// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { decideFromTick, type SupervisorTickFacts } from "../../state-machines/peer-actor.test-helper"
import { tickFacts } from "../../state-machines/peer.definition"

const actor = (failCount: number, lastAttemptAt: number | null, noVideoRebuilds = 0) =>
  ({ initiator: true, lastAttemptAt, budgets: { failCount, noVideoRebuilds } })
/** the actor's clock decision with the tick's times as its own (the actor decides from its own times, through its deadlines) */
const decide = (facts: SupervisorTickFacts, view: ReturnType<typeof actor>) => decideFromTick(facts, view)
/** backoff by failCount 0..5, written out: 3 s doubling, capped at 20 s */
const BACKOFF = [3000, 6000, 12000, 20000, 20000, 20000]
const steps = (count: number, every: number) => Array.from({ length: count }, (_, i) => i * every)

describe("C2-1 supervisor backoff gate and disconnect grace", () => {
  it("rebuilds a failed link exactly when the backoff since the last attempt has passed (C2a)", () => {
    for (let n = 0; n <= 5; n++) {
      for (const d of [...steps(101, 250), BACKOFF[n] - 1, BACKOFF[n]]) {
        const expected = d >= BACKOFF[n] ? { markAway: false, act: "rebuild", cause: "failed" } : { markAway: false, act: "none" }
        expect(decide(tickFacts({ browserConnectionState: "failed" }), actor(n, 100_000 - d)), `n=${n} d=${d}`).toEqual(expected)
      }
    }
  })
  it("rebuilds a failed link at once when no attempt was ever made (C2a)", () => {
    for (let n = 0; n <= 5; n++)
      expect(decide(tickFacts({ browserConnectionState: "failed" }), actor(n, null)), `n=${n}`).toEqual({ markAway: false, act: "rebuild", cause: "failed" })
  })
  it("waits out the 4 s disconnect grace, then restarts ICE once and rebuilds after (C2b)", () => {
    for (let n = 0; n <= 3; n++) {
      for (const g of [...steps(101, 100), 3999, 4000, 4001]) {
        const expected = g <= 4000 ? { markAway: false, act: "none" }
          : n <= 0 ? { markAway: false, act: "restart-ice" }
          : { markAway: false, act: "rebuild", cause: "soft-disconnect" }
        expect(decide(tickFacts({ disconnectedAt: 100_000 - g }), actor(n, null)), `n=${n} g=${g}`).toEqual(expected)
      }
    }
  })
})
