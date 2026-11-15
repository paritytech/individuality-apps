// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const stored = vi.hoisted(() => new Map<string, unknown>())
const PENDING = "jollity.chain-restart-pending"
const counts = vi.hoisted(() => [] as Array<{ name: string; attrs: Record<string, string> }>)
const distributions = vi.hoisted(() => [] as Array<{ name: string; value: number; attrs: Record<string, string> }>)

vi.mock("./host/storage", async () => (await import("./chain-health-fixtures")).memoryHostStorage(stored))
vi.mock("./telemetry", () => ({
  recordCount: (name: string, _value: number, attrs: Record<string, string>) =>
    counts.push({ name, attrs }),
  recordDistribution: (name: string, value: number, _unit: string, attrs: Record<string, string>) =>
    distributions.push({ name, value, attrs }),
}))
vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))

import { applyRestartProbe, recordRestartCardCleared, recordRestartCardShown } from "./chain-restart"
import { HEALTHY, LOST } from "./chain-health-fixtures"

describe("restart-card attribution", () => {
  beforeEach(() => {
    stored.clear()
    counts.length = 0
  })

  it("survives a full reopen and records that the next probe recovered", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1234)
    await applyRestartProbe("waiting", LOST, true)
    expect(stored.get(PENDING)).toBe(1234)

    await expect(
      applyRestartProbe("open", { outcome: "healthy", latencyMs: 12 }, false),
    ).resolves.toEqual({ pending: true, succeeded: true })
    expect(stored.has(PENDING)).toBe(false)
    expect(counts).toEqual([
      { name: "chain.restart_card_shown", attrs: { "chain.health.where": "waiting" } },
      {
        name: "chain.restart_card_next_probe",
        attrs: {
          "chain.health.where": "open",
          "chain.restart_card_next_probe": "true",
        },
      },
    ])
  })

  it("records delayed restart advice when the reconnecting minute expires", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5678)
    await recordRestartCardShown("waiting")
    expect(stored.get(PENDING)).toBe(5678)
    expect(counts).toEqual([
      { name: "chain.restart_card_shown", attrs: { "chain.health.where": "waiting" } },
    ])
    vi.spyOn(Date, "now").mockReturnValue(15_678)
    // The card hook has no local shownAt timestamp for a delayed escalation;
    // the escalation marker must still supply the visible duration.
    recordRestartCardCleared("recheck", undefined)
    expect(distributions.at(-1)).toEqual({
      name: "chain.restart_card_visible_ms",
      value: 10_000,
      attrs: { "chain.health.where": "recheck" },
    })
  })

  it("records an unsuccessful next probe but keeps the known-lost marker", async () => {
    stored.set(PENDING, 1234)
    await expect(
      applyRestartProbe("open", LOST, false),
    ).resolves.toEqual({ pending: true, succeeded: false })
    expect(stored.has(PENDING)).toBe(false)
    expect(counts[0].attrs["chain.restart_card_next_probe"]).toBe("false")
  })

  it("records an unknown next probe once without preserving a blocking marker", async () => {
    stored.set(PENDING, 1234)
    await expect(
      applyRestartProbe("open", {
        outcome: "unknown",
        latencyMs: 5000,
        errorClass: "unknown",
        error: "chain health probe timed out",
      }, false),
    ).resolves.toEqual({ pending: true, succeeded: false })
    expect(stored.has(PENDING)).toBe(false)
    expect(counts.filter((point) => point.name === "chain.restart_card_next_probe")).toHaveLength(1)
  })

  it("does not let a handover probe spend the marker before a real reopen", async () => {
    await Promise.all([
      applyRestartProbe(
        "waiting",
        LOST,
        true,
      ),
      applyRestartProbe("handover", { outcome: "healthy", latencyMs: 8 }, false),
    ])
    expect(stored.has(PENDING)).toBe(true)
    expect(counts.map((point) => point.name)).toEqual(["chain.restart_card_shown"])
  })

  it("counts an in-game bar without leaving a false restart marker", async () => {
    await applyRestartProbe("recheck", LOST, "bar")
    expect(stored.has(PENDING)).toBe(false)
    expect(counts).toEqual([
      { name: "chain.restart_bar_shown", attrs: { "chain.health.where": "recheck" } },
    ])
  })
})

describe("the card's re-check and the restart marker", () => {
  beforeEach(() => {
    stored.clear()
    counts.length = 0
  })

  it("leaves the marker for the first probe after a real restart", async () => {
    stored.set(PENDING, 1234)
    await expect(applyRestartProbe("recheck", HEALTHY, false)).resolves.toEqual({ pending: false, succeeded: null })
    expect(stored.get(PENDING)).toBe(1234)
    expect(counts).toEqual([])
    await expect(applyRestartProbe("open", HEALTHY, false)).resolves.toEqual({ pending: true, succeeded: true })
  })

  it("records how long a cleared card held the player", () => {
    distributions.length = 0
    recordRestartCardCleared("recheck", 10_000)
    expect(distributions).toEqual([
      { name: "chain.restart_card_visible_ms", value: 10_000, attrs: { "chain.health.where": "recheck" } },
    ])
  })
})
