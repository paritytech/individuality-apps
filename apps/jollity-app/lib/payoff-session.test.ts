// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest"
import { payoffSession, resetPayoffSessionsForTest } from "./payoff-session"

describe("payoff session", () => {
  beforeEach(() => resetPayoffSessionsForTest())

  it("starts the chest fresh when an unfinished draw session belongs to another screen", () => {
    expect(payoffSession(9, "/prize-draw").current().kind).toBe("draw-waiting")

    const chest = payoffSession(9, "/chest")
    expect(chest.current().kind).toBe("chest-reading")
    expect(chest.send({ type: "chest-result" })).toEqual([{ kind: "telemetry", fact: "chestShown" }])
    expect(chest.send({ type: "chest-continue" })).toEqual([
      { kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ])
  })

  it.each([
    ["/prize-draw", "draw-waiting"],
    ["/chest", "chest-reading"],
  ] as const)("starts a new %s visit after the retained journey ended", (route, kind) => {
    const first = payoffSession(9, "/chest")
    first.send({ type: "chest-result" })
    expect(first.send({ type: "chest-continue" })).toHaveLength(2)

    expect(payoffSession(9, route).current().kind).toBe(kind)
  })
})
