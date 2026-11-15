// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPrizeDrawPayoffRunner, executePrizeDrawCommands } from "./payoff-runner"
import { resetPayoffSessionsForTest } from "../payoff-session"

const kinds = (commands: ReturnType<ReturnType<typeof createPrizeDrawPayoffRunner>["send"]>) =>
  commands.map((command) => (command.kind === "telemetry" ? `${command.kind}:${command.fact}` : command.kind))

describe("prize-draw payoff runner", () => {
  beforeEach(() => resetPayoffSessionsForTest())

  it("drives the 60 s idle path without marking the draw seen", () => {
    const runner = createPrizeDrawPayoffRunner(5)
    expect(kinds(runner.send({ type: "draw-result" }))).toEqual(["telemetry:drawShown"])
    expect(kinds(runner.send({ type: "draw-offered" }))).toEqual(["arm-draw-idle"])
    expect(kinds(runner.send({ type: "draw-idle" }))).toEqual(["cancel-draw-idle", "load-chest", "replace-route"])
  })

  it("records one late draw fact after bypass and no second navigation", () => {
    const runner = createPrizeDrawPayoffRunner(5)
    const load = runner.capture()
    expect(kinds(runner.send({ type: "draw-bypass" }))).toEqual(["load-chest", "replace-route"])
    expect(kinds(runner.send({ type: "draw-result" }, load))).toEqual(["telemetry:drawShown"])
    expect(runner.send({ type: "draw-result" }, load)).toEqual([])
  })

  it("rejects a result tagged before a newer read epoch", () => {
    const runner = createPrizeDrawPayoffRunner(5)
    const load = runner.capture()
    runner.send({ type: "draw-bypass" })
    runner.send({ type: "chest-reread-due" })
    expect(runner.send({ type: "draw-result" }, load)).toEqual([])
  })

  it("gets the chest ready when the payoff says so, and lets the chest's own commands pass", () => {
    const handlers = { drawShown: vi.fn(), markDrawSeen: vi.fn(), replaceChest: vi.fn(), armIdle: vi.fn(), cancelIdle: vi.fn(), loadChest: vi.fn() }
    executePrizeDrawCommands(
      [
        { kind: "load-chest" },
        { kind: "telemetry", fact: "chestShown" },
        { kind: "replace-route", route: "/prize-draw" },
        { kind: "hand-off" },
        { kind: "end-payoff", outcome: "shown", cause: "handed-off", sendGameLog: true },
      ],
      handlers,
    )
    expect(handlers.loadChest).toHaveBeenCalledOnce()
    expect(handlers.drawShown).not.toHaveBeenCalled()
    expect(handlers.replaceChest).not.toHaveBeenCalled()
  })
})
