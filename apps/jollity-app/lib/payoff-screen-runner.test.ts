// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPayoffScreenRunner, executeChestCommands, sendChestPageResult } from "./payoff-screen-runner"
import { resetPayoffSessionsForTest } from "./payoff-session"
import type { PayoffCommand } from "./payoff-machine"

const HANDOFF: PayoffCommand[] = [
      { kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ]

describe("payoff screen runner", () => {
  beforeEach(() => resetPayoffSessionsForTest())

  it("emits each chest fact once and hands off to Humanity", () => {
    const runner = createPayoffScreenRunner(5, "/chest")
    expect(runner.send({ type: "chest-opened" })).toEqual([{ kind: "telemetry", fact: "chestOpened" }])
    expect(runner.send({ type: "chest-result" })).toEqual([{ kind: "telemetry", fact: "chestShown" }])
    expect(runner.send({ type: "chest-result" })).toEqual([])
    expect(runner.send({ type: "chest-continue" })).toEqual(HANDOFF)
    expect(runner.send({ type: "chest-continue" })).toEqual([])
  })

  it("rejects an old chest read after a reread starts", () => {
    const runner = createPayoffScreenRunner(5, "/chest")
    const first = runner.capture()
    expect(runner.send({ type: "chest-reread-due" })).toEqual([{ kind: "load-chest" }])
    expect(runner.send({ type: "chest-result" }, first)).toEqual([])
    expect(runner.send({ type: "chest-result" })).toEqual([{ kind: "telemetry", fact: "chestShown" }])
  })

  it("keeps the restart fact current when it cancels an in-flight reread", () => {
    const runner = createPayoffScreenRunner(5, "/chest")
    const firstRead = runner.capture()

    // This is the page's automatic-reread order: advance the epoch, then let
    // reload start and capture it. The on-screen retry state still has tag 0.
    expect(runner.send({ type: "chest-reread-due" })).toEqual([{ kind: "load-chest" }])
    expect(runner.capture()).toEqual({ gameIndex: 5, epoch: 1 })
    expect(sendChestPageResult(runner, firstRead, false)).toEqual([])
    expect(runner.send({ type: "chest-continue" })).toEqual([])

    // When restart cancels that read, the page reports the current failure,
    // not the stale retrying view. Only then is Continue eligible.
    expect(sendChestPageResult(runner, firstRead, true)).toEqual([{ kind: "telemetry", fact: "chestShown" }])
    expect(runner.send({ type: "chest-continue" })).toEqual(HANDOFF)
  })

  it("keeps a chest stall in the outcome the hand-off ends the payoff with", () => {
    const chest = createPayoffScreenRunner(5, "/chest")
    chest.send({ type: "payoff-stalled", stage: "chest.load" })
    chest.send({ type: "chest-result" })
    expect(chest.send({ type: "chest-continue" })).toEqual([
      { kind: "end-payoff", outcome: "stalled", cause: "handed-off", sendGameLog: true },
      { kind: "hand-off" },
    ])
  })

  it("starts a fresh payoff when the chest mounts again after the retained journey ended", () => {
    const first = createPayoffScreenRunner(5, "/chest")
    first.send({ type: "chest-result" })
    expect(first.send({ type: "chest-continue" })).toHaveLength(2)

    const again = createPayoffScreenRunner(5, "/chest")
    again.send({ type: "chest-result" })
    expect(again.send({ type: "chest-continue" })).toEqual(HANDOFF)
  })

  it("runs the payoff's end, then the hand-off", () => {
    const handlers = {
      chestOpened: vi.fn(),
      chestShown: vi.fn(),
      payoffStalled: vi.fn(),
      payoffEnded: vi.fn(),
      handOff: vi.fn(),
      loadChest: vi.fn(),
    }
    executeChestCommands(HANDOFF, handlers)
    expect(handlers.payoffEnded).toHaveBeenCalledOnce()
    expect(handlers.handOff).toHaveBeenCalledOnce()
    expect(handlers.payoffEnded.mock.invocationCallOrder[0]).toBeLessThan(handlers.handOff.mock.invocationCallOrder[0]!)
  })
})
