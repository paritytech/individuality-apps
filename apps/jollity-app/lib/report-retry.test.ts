// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { ReportVote } from "@jollity/protocol"
import { REPORT_STATUS_POLL_MS, ReportWindowClosedError, submitReportAttempt } from "./report-retry"

const REPORT: ReportVote[][] = [["Person"]]

describe("retryable report attempts", () => {
  it("re-reads reportSent before submitting", async () => {
    const order: string[] = []
    const result = await submitReportAttempt(
      {
        nowSeconds: () => 100,
        reportStatus: async () => {
          order.push("read")
          return { closed: false, report: "not-sent" as const }
        },
        submitReport: async () => {
          order.push("submit")
        },
      },
      REPORT,
      7,
      115,
    )
    expect(result).toBe("sent")
    expect(order).toEqual(["read", "submit"])
  })

  it("accepts a late reportSent read without submitting again", async () => {
    const submitReport = vi.fn()
    const result = await submitReportAttempt(
      {
        nowSeconds: () => 100,
        reportStatus: async () => ({ closed: false, report: "sent" as const }),
        submitReport,
      },
      REPORT,
      7,
      115,
    )
    expect(result).toBe("sent")
    expect(submitReport).not.toHaveBeenCalled()
  })

  it("does not submit after report_ends", async () => {
    const reportStatus = vi.fn()
    const submitReport = vi.fn()
    const result = await submitReportAttempt(
      { nowSeconds: () => 115, reportStatus, submitReport },
      REPORT,
      7,
      115,
    )
    expect(result).toBe("closed")
    expect(reportStatus).not.toHaveBeenCalled()
    expect(submitReport).not.toHaveBeenCalled()
  })

  it.each(["read", "submit"])("keeps a never-settling %s until report_ends without resubmitting", async (hang) => {
    vi.useFakeTimers()
    try {
      const pending = submitReportAttempt(
        {
          nowSeconds: () => 100,
          reportStatus: () =>
            hang === "read"
              ? new Promise(() => {})
              : Promise.resolve({ closed: false, report: "not-sent" as const }),
          submitReport: () => new Promise(() => {}),
        },
        REPORT,
        7,
        115,
      )
      const assertion = expect(pending).resolves.toBe("closed")
      await vi.advanceTimersByTimeAsync(15_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits for a healthy eight-second inclusion and submits exactly once", async () => {
    vi.useFakeTimers()
    try {
      const submitReport = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
      )
      const pending = submitReportAttempt(
        { nowSeconds: () => 100, reportStatus: async () => ({ closed: false, report: "not-sent" as const }), submitReport },
        REPORT,
        7,
        115,
      )
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(pending).resolves.toBe("sent")
      expect(submitReport).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["closed", { closed: true, report: "not-sent" as const }, { kind: "chain-closed", at: "watch" }],
    ["sent", { closed: false, report: "sent" as const }, "sent"],
  ])("polls the status beside a hanging watch: %s ends the attempt before report_ends", async (_, later, expected) => {
    vi.useFakeTimers()
    try {
      let status: { closed: boolean; report: "sent" | "not-sent" } = { closed: false, report: "not-sent" }
      let aborted = false
      const pending = submitReportAttempt(
        {
          nowSeconds: () => 100,
          reportStatus: async () => status,
          submitReport: (_report, signal) =>
            new Promise(() => signal?.addEventListener("abort", () => (aborted = true))),
        },
        REPORT,
        7,
        130,
      )
      await vi.advanceTimersByTimeAsync(4_000)
      status = later
      await vi.advanceTimersByTimeAsync(4_000)
      await expect(pending).resolves.toEqual(expected)
      expect(aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // #596: the chain can shut the window before report_ends
  it("files nothing once the chain has left Reporting", async () => {
    const submitReport = vi.fn()
    const result = await submitReportAttempt(
      { nowSeconds: () => 100, reportStatus: async () => ({ closed: true, report: "not-sent" as const }), submitReport },
      REPORT,
      7,
      115,
    )
    expect(result).toEqual({ kind: "chain-closed", at: "pre-submit" })
    expect(submitReport).not.toHaveBeenCalled()
  })

  it("takes the pallet's NoReporting as the chain closing the window, not a retry", async () => {
    const result = await submitReportAttempt(
      {
        nowSeconds: () => 100,
        reportStatus: async () => ({ closed: false, report: "not-sent" as const }),
        submitReport: () => Promise.reject(new ReportWindowClosedError()),
      },
      REPORT,
      7,
      115,
    )
    expect(result).toEqual({ kind: "chain-closed", at: "NoReporting" })
  })

  it("names the NoReporting refusal", () => {
    const error = new ReportWindowClosedError()
    expect(error.message).toBe("NoReporting")
    expect(error.name).toBe("ReportWindowClosedError")
  })

  it("surfaces any other submit failure to the caller (who retries), asynchronous or thrown", async () => {
    const open = async () => ({ closed: false, report: "not-sent" as const })
    const boom = new Error("rpc down")
    await expect(
      submitReportAttempt({ nowSeconds: () => 100, reportStatus: open, submitReport: () => Promise.reject(boom) }, REPORT, 7, 115),
    ).rejects.toBe(boom)
    await expect(
      submitReportAttempt(
        { nowSeconds: () => 100, reportStatus: open, submitReport: () => { throw boom } },
        REPORT,
        7,
        115,
      ),
    ).rejects.toBe(boom)
  })

  it("treats a failed status read as an open window and still submits", async () => {
    const submitReport = vi.fn(async () => {})
    const result = await submitReportAttempt(
      { nowSeconds: () => 100, reportStatus: () => Promise.reject(new Error("read failed")), submitReport },
      REPORT,
      7,
      115,
    )
    expect(result).toBe("sent")
    expect(submitReport).toHaveBeenCalledTimes(1)
  })

  it("polls every REPORT_STATUS_POLL_MS beside a hanging watch and leaves no timer behind", async () => {
    vi.useFakeTimers()
    try {
      const reportStatus = vi.fn(async () => ({ closed: false, report: "not-sent" as const }))
      const pending = submitReportAttempt(
        { nowSeconds: () => 100, reportStatus, submitReport: () => new Promise(() => {}) },
        REPORT,
        7,
        130,
      )
      await vi.advanceTimersByTimeAsync(REPORT_STATUS_POLL_MS - 1)
      expect(reportStatus).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(reportStatus).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(REPORT_STATUS_POLL_MS)
      expect(reportStatus).toHaveBeenCalledTimes(3)
      const assertion = expect(pending).resolves.toBe("closed")
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears its timers when the submission settles first", async () => {
    vi.useFakeTimers()
    try {
      const result = await submitReportAttempt(
        {
          nowSeconds: () => 100,
          reportStatus: async () => ({ closed: false, report: "not-sent" as const }),
          submitReport: async () => {},
        },
        REPORT,
        7,
        115,
      )
      expect(result).toBe("sent")
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["the window closing", "closed", "the report window closed"],
    ["a poll finding the report sent", "sent", "the report attempt ended"],
  ])("drops the pending watch with a reason when %s", async (_, kind, reason) => {
    vi.useFakeTimers()
    try {
      let status = { closed: false, report: "not-sent" as "sent" | "not-sent" }
      let abortReason: unknown
      const pending = submitReportAttempt(
        {
          nowSeconds: () => 100,
          reportStatus: async () => status,
          submitReport: (_report, signal) =>
            new Promise(() => signal?.addEventListener("abort", () => (abortReason = signal.reason))),
        },
        REPORT,
        7,
        115,
      )
      if (kind === "sent") {
        status = { closed: false, report: "sent" }
        await vi.advanceTimersByTimeAsync(REPORT_STATUS_POLL_MS)
      } else await vi.advanceTimersByTimeAsync(15_000)
      await pending
      expect((abortReason as Error).message).toBe(reason)
    } finally {
      vi.useRealTimers()
    }
  })
})
