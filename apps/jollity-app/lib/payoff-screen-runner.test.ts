// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPayoffScreenRunner, executeCollectablesCommands, sendCollectablesPageResult } from "./payoff-screen-runner"
import { resetPayoffSessionsForTest } from "./payoff-session"
import type { PayoffCommand } from "./payoff-machine"

const HANDOFF: PayoffCommand[] = [
      { kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ]

describe("payoff screen runner", () => {
  beforeEach(() => resetPayoffSessionsForTest())

  it("emits each collectables fact once and hands off to Humanity", () => {
    const runner = createPayoffScreenRunner(5, "/collectables")
    expect(runner.send({ type: "collectables-opened" })).toEqual([{ kind: "telemetry", fact: "collectablesOpened" }])
    expect(runner.send({ type: "collectables-result" })).toEqual([{ kind: "telemetry", fact: "collectablesShown" }])
    expect(runner.send({ type: "collectables-result" })).toEqual([])
    expect(runner.send({ type: "collectables-continue" })).toEqual(HANDOFF)
    expect(runner.send({ type: "collectables-continue" })).toEqual([])
  })

  it("rejects an old collectables read after a reread starts", () => {
    const runner = createPayoffScreenRunner(5, "/collectables")
    const first = runner.capture()
    expect(runner.send({ type: "collectables-reread-due" })).toEqual([{ kind: "load-collectables" }])
    expect(runner.send({ type: "collectables-result" }, first)).toEqual([])
    expect(runner.send({ type: "collectables-result" })).toEqual([{ kind: "telemetry", fact: "collectablesShown" }])
  })

  it("keeps the restart fact current when it cancels an in-flight reread", () => {
    const runner = createPayoffScreenRunner(5, "/collectables")
    const firstRead = runner.capture()

    // This is the page's automatic-reread order: advance the epoch, then let
    // reload start and capture it. The on-screen retry state still has tag 0.
    expect(runner.send({ type: "collectables-reread-due" })).toEqual([{ kind: "load-collectables" }])
    expect(runner.capture()).toEqual({ gameIndex: 5, epoch: 1 })
    expect(sendCollectablesPageResult(runner, firstRead, false)).toEqual([])
    expect(runner.send({ type: "collectables-continue" })).toEqual([])

    // When restart cancels that read, the page reports the current failure,
    // not the stale retrying view. Only then is Continue eligible.
    expect(sendCollectablesPageResult(runner, firstRead, true)).toEqual([{ kind: "telemetry", fact: "collectablesShown" }])
    expect(runner.send({ type: "collectables-continue" })).toEqual(HANDOFF)
  })

  it("keeps a collectables screen stall in the outcome the hand-off ends the payoff with", () => {
    const collectables = createPayoffScreenRunner(5, "/collectables")
    collectables.send({ type: "payoff-stalled", stage: "chest.load" })
    collectables.send({ type: "collectables-result" })
    expect(collectables.send({ type: "collectables-continue" })).toEqual([
      { kind: "end-payoff", outcome: "stalled", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ])
  })

  it("starts a fresh payoff when the collectables screen mounts again after the retained journey ended", () => {
    const first = createPayoffScreenRunner(5, "/collectables")
    first.send({ type: "collectables-result" })
    expect(first.send({ type: "collectables-continue" })).toHaveLength(2)

    const again = createPayoffScreenRunner(5, "/collectables")
    again.send({ type: "collectables-result" })
    expect(again.send({ type: "collectables-continue" })).toEqual(HANDOFF)
  })

  it("runs the payoff's end, then the hand-off", () => {
    const handlers = {
      collectablesOpened: vi.fn(),
      collectablesShown: vi.fn(),
      payoffStalled: vi.fn(),
      payoffEnded: vi.fn(),
      handOff: vi.fn(),
      loadCollectables: vi.fn(),
    }
    executeCollectablesCommands(HANDOFF, handlers)
    expect(handlers.payoffEnded).toHaveBeenCalledOnce()
    expect(handlers.handOff).toHaveBeenCalledOnce()
    expect(handlers.payoffEnded.mock.invocationCallOrder[0]).toBeLessThan(handlers.handOff.mock.invocationCallOrder[0]!)
  })
})
