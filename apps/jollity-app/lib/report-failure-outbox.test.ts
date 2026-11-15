// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, unknown>()
vi.mock("./host/storage", () => ({
  readStoredJSON: vi.fn(async (key: string) => store.get(key) ?? null),
  writeStoredJSON: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
}))

import {
  clearPendingReportFailure,
  recordPendingReportFailure,
  settlePendingReportFailure,
  type ReportFailureSource,
} from "./report-failure-outbox"

const ACCOUNT = "5Alice"
const failure = { gameIndex: 7, account: ACCOUNT, reason: "refused" as const, detail: "Rejected" }
const source = (status: Awaited<ReturnType<ReportFailureSource["reportStatus"]>>): ReportFailureSource => ({
  player: ACCOUNT,
  reportStatus: vi.fn(async () => status),
})

beforeEach(() => store.clear())

describe("a terminal report failure that outlives the page", () => {
  it("sends exactly one report-failed on the next open, once the chain shows the miss", async () => {
    await recordPendingReportFailure(failure) // the page unmounts here
    const send = vi.fn()

    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ gameIndex: 7, reason: "refused", detail: "Rejected" })
  })

  it("claims nothing while the chain may still take the report, or when a read failed, and keeps the record", async () => {
    await recordPendingReportFailure(failure)
    const send = vi.fn()
    await settlePendingReportFailure(source({ closed: false, report: "not-sent" }), send)
    await settlePendingReportFailure(source({ closed: false, report: "unknown" }), send)
    expect(send).not.toHaveBeenCalled()

    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("drops the record without a claim when the report landed after all, or the chain keeps nothing", async () => {
    for (const report of ["sent", "gone"] as const) {
      await recordPendingReportFailure(failure)
      const send = vi.fn()
      await settlePendingReportFailure(source({ closed: true, report }), send)
      await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
      expect(send).not.toHaveBeenCalled()
    }
  })

  it("is not sent a second time when the page already sent it", async () => {
    await recordPendingReportFailure(failure)
    await clearPendingReportFailure(7)
    const send = vi.fn()
    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
    expect(send).not.toHaveBeenCalled()
  })

  it("does not clear another game's record, nor settle another account's", async () => {
    await recordPendingReportFailure(failure)
    await clearPendingReportFailure(8)
    const send = vi.fn()
    await settlePendingReportFailure({ ...source({ closed: true, report: "not-sent" }), player: "5Bob" }, send)
    expect(send).not.toHaveBeenCalled()
    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("sends once when two opens settle at the same time", async () => {
    await recordPendingReportFailure(failure)
    const send = vi.fn()
    const s = source({ closed: true, report: "not-sent" })
    await Promise.all([settlePendingReportFailure(s, send), settlePendingReportFailure(s, send)])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("never throws when storage or the send fails", async () => {
    await recordPendingReportFailure(failure)
    await expect(
      settlePendingReportFailure(source({ closed: true, report: "not-sent" }), () => {
        throw new Error("boom")
      }),
    ).resolves.toBeUndefined()
  })

  it("sends 0 or 1 times across two opens when the clearing write fails", async () => {
    await recordPendingReportFailure(failure)
    const storage = await import("./host/storage")
    vi.mocked(storage.writeStoredJSON).mockImplementation(async () => undefined) // swallowed failure
    const send = vi.fn()
    const s = source({ closed: true, report: "not-sent" })
    await settlePendingReportFailure(s, send)
    await settlePendingReportFailure(s, send)
    expect(send.mock.calls.length).toBeLessThanOrEqual(1)
    expect(send).not.toHaveBeenCalled()
    vi.mocked(storage.writeStoredJSON).mockImplementation(async (k: string, v: unknown) => void store.set(k, v))
  })

  it("the page does not send when its clear is not confirmed", async () => {
    await recordPendingReportFailure(failure)
    const storage = await import("./host/storage")
    vi.mocked(storage.writeStoredJSON).mockImplementation(async () => undefined)
    expect(await clearPendingReportFailure(7)).toBe(false)
    vi.mocked(storage.writeStoredJSON).mockImplementation(async (k: string, v: unknown) => void store.set(k, v))
  })

  it("a clear right after the parking write removes the record, even before the write landed", async () => {
    const storage = await import("./host/storage")
    vi.mocked(storage.writeStoredJSON).mockImplementationOnce(async (k: string, v: unknown) => {
      await new Promise((r) => setTimeout(r, 10))
      store.set(k, v)
    })
    void recordPendingReportFailure(failure) // not awaited, as in the page
    expect(await clearPendingReportFailure(7, ACCOUNT)).toBe(true)
    const send = vi.fn()
    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
    expect(send).not.toHaveBeenCalled()
  })

  it("clear leaves another account's record", async () => {
    await recordPendingReportFailure(failure)
    expect(await clearPendingReportFailure(7, "5Bob")).toBe(true)
    const send = vi.fn()
    await settlePendingReportFailure(source({ closed: true, report: "not-sent" }), send)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
