// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))
vi.mock("./telemetry/session-record", () => ({ noteOwnReload: vi.fn() }))
vi.mock("./telemetry/metrics", () => ({ recordCount: vi.fn(), recordDistribution: vi.fn() }))

import { noteOwnReload } from "./telemetry/session-record"
import { recordCount } from "./telemetry/metrics"
import { requestSelfReload, SELF_RELOAD_CAP, SELF_RELOAD_KEY } from "./self-reload"

describe("the shared self-reload budget", () => {
  const values = new Map<string, string>()
  const reload = vi.fn()
  beforeEach(() => {
    values.clear()
    reload.mockReset()
    vi.setSystemTime(1_000_000)
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
    vi.stubGlobal("window", { location: { reload } })
    vi.mocked(noteOwnReload).mockClear()
    vi.mocked(recordCount).mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("shares one three-in-ten-minutes cap across host and suspension reloads", () => {
    expect(requestSelfReload("host-channel")).toBe(true)
    expect(requestSelfReload("long-suspension", { awayMs: 600_000, screen: "waiting", stage: "none" })).toBe(true)
    expect(requestSelfReload("host-channel")).toBe(true)
    expect(requestSelfReload("long-suspension", { awayMs: 700_000 })).toBe(false)
    expect(reload).toHaveBeenCalledTimes(SELF_RELOAD_CAP)
    expect(noteOwnReload).toHaveBeenCalledTimes(SELF_RELOAD_CAP)
    expect(JSON.parse(values.get(SELF_RELOAD_KEY) ?? "[]")).toHaveLength(SELF_RELOAD_CAP)
    expect(recordCount).toHaveBeenCalledWith("app.self_reload_suppressed", 1, expect.objectContaining({ "app.reload_reason": "long-suspension" }))
  })

  it("refuses to reload when sessionStorage cannot record the budget", async () => {
    // each call is a fresh page load: without storage the count never rises,
    // so a reload here would be granted a fresh budget forever (H-R1)
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new Error("SecurityError")
      },
    })
    for (let page = 0; page < SELF_RELOAD_CAP + 1; page++) {
      vi.resetModules()
      const { requestSelfReload: onThisPage } = await import("./self-reload")
      expect(onThisPage("host-channel")).toBe(false)
    }
    expect(reload).not.toHaveBeenCalled()
  })

  it("refuses to reload when the history can be read but not written", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    })
    expect(requestSelfReload("host-channel")).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it("still reloads when the stored history is merely unparseable", () => {
    values.set(SELF_RELOAD_KEY, "not json")
    expect(requestSelfReload("host-channel")).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("persists caller state before starting the reload", () => {
    const order: string[] = []
    reload.mockImplementation(() => order.push("reload"))
    expect(requestSelfReload("long-suspension", {}, () => order.push("persist"))).toBe(true)
    expect(order).toEqual(["persist", "reload"])
  })
})
