// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())
const startSessionRecord = vi.hoisted(() => vi.fn(async () => ({ classification: "killed-background" } as const)))
vi.mock("../telemetry/session-record", () => ({ startSessionRecord }))

import { journeysNamed, resetRecorded } from "../telemetry/testing"
import { appOpenStep, endAppOpen, gateCheckFor, noteAppOpenHost, resetAppOpenForTests, runGateCheck } from "./app-open"

beforeEach(() => {
  resetRecorded()
  resetAppOpenForTests()
  startSessionRecord.mockClear()
})

describe("journey.app-open", () => {
  it("starts at the page's navigation start and collects its steps", () => {
    appOpenStep("host.connect").end()
    appOpenStep("chain.genesis").end({ "chain.genesis": "found" })
    endAppOpen("ready")
    const [journey] = journeysNamed("app-open")
    expect(journey.options.startedAt).toBe(Math.round(performance.timeOrigin))
    expect(journey.steps.map((step) => step.name)).toEqual(["host.connect", "chain.genesis"])
    expect(journey.outcome).toBe("ready")
  })

  it("ends with the host storage numbers, as numbers (#776)", () => {
    endAppOpen("ready")
    expect(journeysNamed("app-open")[0].endAttrs).toMatchObject({ "storage.reads": 0, "storage.failed": 0, "storage.slow_3s": 0, "storage.slow_10s": 0, "storage.max_ms": 0 })
  })

  it("is one journey per page, and quiet once ended", () => {
    endAppOpen("gate")
    appOpenStep("host.connect").end()
    endAppOpen("ready")
    expect(journeysNamed("app-open")).toHaveLength(1)
    expect(journeysNamed("app-open")[0]).toMatchObject({ outcome: "gate", steps: [] })
  })

  it("records the host build and labels a missing current-host version", () => {
    noteAppOpenHost({ name: "Polkadot", version: "2.4.0" })
    expect(journeysNamed("app-open")[0].attrs).toMatchObject({
      "host.app": "Polkadot",
      "host.app_version": "2.4.0",
    })
    resetAppOpenForTests()
    noteAppOpenHost({ name: "Polkadot", version: "" })
    expect(journeysNamed("app-open").at(-1)?.attrs).toMatchObject({
      "host.app": "Polkadot",
      "host.app_version": "host sent no version",
    })
    resetAppOpenForTests()
    noteAppOpenHost(null, true)
    expect(journeysNamed("app-open").at(-1)?.attrs).toMatchObject({
      "host.app": "unknown",
      "host.app_version": "version read failed",
    })
  })
})

describe("the gate check", () => {
  it("ends no-source without asking anything", async () => {
    const check = vi.fn(async () => true)
    await expect(runGateCheck(false, check)).resolves.toBe("no-source")
    expect(check).not.toHaveBeenCalled()
    expect(journeysNamed("app-open")[0].outcome).toBe("no-source")
  })

  it("ends ready for a granted player, measuring the check", async () => {
    await expect(runGateCheck(true, async () => true)).resolves.toBe("ready")
    const [journey] = journeysNamed("app-open")
    expect(journey.steps[0]).toMatchObject({ name: "permissions.check", ended: true, endAttrs: { "permissions.granted": "true" } })
    expect(journey.outcome).toBe("ready")
  })

  it("ends gate for a player sent to /permissions", async () => {
    await expect(runGateCheck(true, async () => false)).resolves.toBe("gate")
    expect(journeysNamed("app-open")[0].outcome).toBe("gate")
  })
})

describe("the previous exit", () => {
  it("rides the open journey, and the record starts once", async () => {
    appOpenStep("host.connect").end()
    await vi.waitFor(() => expect(journeysNamed("app-open")[0].attrs).toMatchObject({ "previous.exit": "killed-background" }))
    expect(startSessionRecord).toHaveBeenCalledTimes(1)
    expect(startSessionRecord).toHaveBeenCalledWith(expect.objectContaining({ record: expect.any(Function), recover: expect.any(Function) }))
  })
})

describe("the dev skip of the gate (NEXT_PUBLIC_SKIP_PERMISSION_GATE)", () => {
  it("passes the check without asking, so the open still ends ready (and telemetry's grant is asked)", async () => {
    const check = vi.fn(async () => false)
    await expect(runGateCheck(true, gateCheckFor(true, check))).resolves.toBe("ready")
    expect(check).not.toHaveBeenCalled()
    expect(journeysNamed("app-open")[0]).toMatchObject({ outcome: "ready" })
  })

  it("is the real check when not skipped", async () => {
    const check = vi.fn(async () => false)
    await expect(runGateCheck(true, gateCheckFor(false, check))).resolves.toBe("gate")
    expect(check).toHaveBeenCalledOnce()
  })
})
