// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { decideFromTick, type SupervisorTickFacts } from "../../state-machines/peer-actor.test-helper"
import { tickFacts } from "../../state-machines/peer.definition"
import { SUPERVISOR_TIMING } from "../../webrtc/supervisor-timing"

const actor = (failCount: number, lastAttemptAt: number | null, noVideoRebuilds = 0) =>
  ({ initiator: true, lastAttemptAt, budgets: { failCount, noVideoRebuilds } })
/** the actor's clock decision with the tick's times as its own (the actor decides from its own times, through its deadlines) */
const decide = (facts: SupervisorTickFacts, view: ReturnType<typeof actor>) => decideFromTick(facts, view)
const steps = (count: number, every: number) => Array.from({ length: count }, (_, i) => i * every)

describe("C2-2 supervisor away, yield and channel gates", () => {
  it("pins the thresholds this sweep is written against", () => {
    expect(SUPERVISOR_TIMING).toMatchObject({ awayAfterMs: 8000, answerWaitMs: 30000, connectedWithoutChannelMs: 23000 })
  })
  it("marks a link down longer than 8 s away, and does nothing else (C2c)", () => {
    for (const t of [...steps(81, 250), 7999, 8000, 8001])
      expect(decide(tickFacts({ downAt: 100_000 - t }), actor(0, null)), `t=${t}`).toEqual({ markAway: t > 8000, act: "none" })
  })
  it("yields once our statement offer has gone 30 s unanswered (C2d)", () => {
    for (const w of [...steps(81, 500), 29999, 30000])
      expect(decide(tickFacts({ laneOpen: false, haveLocalOffer: true, offerSentAt: 100_000 - w }), actor(0, null)), `w=${w}`)
        .toEqual(w >= 30000 ? { markAway: false, act: "yield" } : { markAway: false, act: "none" })
  })
  it("rebuilds a link connected 23 s with no channel, once a round (C2e)", () => {
    for (const r of [0, 1]) for (const u of [...steps(81, 500), 22999, 23000])
      expect(decide(tickFacts({ browserConnectionState: "connected", laneOpen: false, framesSeen: 0, upAt: 100_000 - u, downAt: 0, disconnectedAt: 0 }), actor(0, null, r)), `r=${r} u=${u}`)
        .toEqual(u >= 23000 && r === 0 ? { markAway: false, act: "channel-never-opened" } : { markAway: false, act: "none" })
  })
})
