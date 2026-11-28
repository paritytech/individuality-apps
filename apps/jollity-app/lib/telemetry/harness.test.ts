// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"

const buildLogsExport = vi.hoisted(() => vi.fn(async () => ({ json: '{"meta":{},"entries":[]}', count: 0, filename: "f.json" })))
const flushGameLog = vi.hoisted(() => vi.fn(async () => ({ gameIndex: 3, sent: true, note: "sent" })))
vi.mock("../debug/telemetry", () => ({ buildLogsExport }))
vi.mock("./index", () => ({ flushGameLog }))
const configFromEnvironment = vi.hoisted(() => vi.fn((): { testTag: string } | null => null))
vi.mock("./init", () => ({ configFromEnvironment }))
const longTaskSnapshot = vi.hoisted(() => vi.fn(() => [{ ms: 9000, endedAt: 5, scene: "game.round" }]))
vi.mock("./smoothness", () => ({ longTaskSnapshot }))
const devLog = vi.hoisted(() => vi.fn())
vi.mock("../debug/log-store", () => ({ devLog }))
const gameLogTailDurable = vi.hoisted(() => vi.fn(() => true))
const gameLogTailState = vi.hoisted(() => vi.fn(() => ({ durable: true, pendingLines: 0, newestLineAgeMs: null })))
vi.mock("./game-log-outbox", () => ({ gameLogTailDurable, gameLogTailState }))
vi.mock("../health/snapshot", () => ({ getHealthSnapshot: () => ({ selfId: "self", at: 9, turnServers: 2, peers: [{ id: "peer", conn: "connected", frames: 17 }] }) }))
vi.mock("../low-power", () => ({ getLowPower: () => true, getLowPowerReason: () => "debug-menu" }))
vi.mock("../webrtc/send-adaptation-driver", () => ({
  sendAdaptationSnapshot: () => ({ gameIndex: 17, rung: 4, state: { rung: 4 }, transitions: Array.from({ length: 64 }, (_, index) => ({ id: String(index) })) }),
}))
const chainNowMs = vi.hoisted(() => vi.fn((): number | null => 1_792_912_812_450))
const readChainClock = vi.hoisted(() => vi.fn(() => ({ offset: -7.25, block: 539_116 })))
vi.mock("../chain-clock", () => ({ chainNowMs, readChainClock }))
vi.mock("../debug/clock", () => ({ getClockSnapshot: () => ({ offsetMs: -7_250, method: "peer", peers: 5 }) }))

import { HARNESS_HOOK, harnessEnabled, installHarnessHook, type HarnessHook } from "./harness"

function installed(): HarnessHook {
  const target: Record<string, unknown> = {}
  installHarnessHook(target, true)
  return target[HARNESS_HOOK] as HarnessHook
}

describe("the live E2E's read-only hook", () => {
  it("hands over the export, the game-log flush, the tail state, the game clock and a devLog line", async () => {
    const hook = installed()
    await expect(hook.exportLogs()).resolves.toBe('{"meta":{},"entries":[]}')
    await expect(hook.flushGameLog()).resolves.toEqual({ gameIndex: 3, sent: true, note: "sent" })
    expect(hook.gameLogTailDurable()).toBe(true)
    expect(gameLogTailDurable).toHaveBeenCalledOnce()
    expect(hook.gameLogTailState()).toEqual({ durable: true, pendingLines: 0, newestLineAgeMs: null })
    expect(gameLogTailState).toHaveBeenCalledOnce()
    expect(hook.gameClock()).toEqual({
      nowMs: 1_792_912_812_450,
      nowSeconds: 1_792_912_812,
      offset: -7.25,
      block: 539_116,
      sync: { offsetMs: -7_250, method: "peer", peers: 5 },
    })
    hook.devLog("rtc", "runner step")
    expect(devLog).toHaveBeenCalledWith("rtc", "runner step")
  })

  it("withholds the game clock until the game has a chain anchor", () => {
    chainNowMs.mockReturnValueOnce(null)
    expect(installed().gameClock()).toBeNull()
  })

  it("hands over the app's own long tasks", () => {
    expect(installed().smoothness()).toEqual([{ ms: 9000, endedAt: 5, scene: "game.round" }])
  })

  it("exposes the upload snapshot with the real low-power state", () => {
    const snapshot = installed().sendAdaptation()
    expect(snapshot).toMatchObject({ gameIndex: 17, rung: 4, lowPower: true, lowPowerReason: "debug-menu" })
    expect(snapshot.transitions).toHaveLength(64)
  })

  it("counts the mesh's relay servers and peers, and nothing mutable", () => {
    expect(installed().mesh()).toEqual({ turnServers: 2, peers: 1 })
  })

  it("is frozen and carries no fault seams", () => {
    const hook = installed()
    expect(Object.isFrozen(hook)).toBe(true)
    expect(Object.keys(hook).sort()).toEqual([
      "devLog", "exportLogs", "flushGameLog", "gameClock", "gameLogTailDurable", "gameLogTailState", "mesh", "sendAdaptation", "smoothness",
    ])
  })

  it("installs nothing when it is not enabled", () => {
    const target: Record<string, unknown> = {}
    installHarnessHook(target, false)
    expect(target).toEqual({})
  })

  describe("which pages carry it", () => {
    it("a development build does", () => expect(harnessEnabled("development")).toBe(true))
    it("a production page with an empty test tag, or no telemetry config, does not", () => {
      configFromEnvironment.mockReturnValueOnce({ testTag: "" })
      expect(harnessEnabled("production")).toBe(false)
      configFromEnvironment.mockReturnValueOnce(null)
      expect(harnessEnabled("production")).toBe(false)
    })
    it("a production page whose test tag is set does, read without turning telemetry on", () => {
      configFromEnvironment.mockReturnValueOnce({ testTag: "e2e-run" })
      expect(harnessEnabled("production")).toBe(true)
      expect(configFromEnvironment).toHaveBeenLastCalledWith({ allowHarnessOnly: true })
    })
  })
})
