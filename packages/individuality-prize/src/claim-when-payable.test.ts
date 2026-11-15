// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { claimWhenPayable, type PayableDraw } from "./claim-when-payable"

const payable: PayableDraw = { claimed: false, claimable: true }

describe("a prize claimed once payable", () => {
  it("waits for the attendance, reads the draw again, and claims it", async () => {
    const order: string[] = []
    const run = await claimWhenPayable({
      attendanceApplied: async () => void order.push("attendance"),
      readDraw: async () => (order.push("read"), payable),
      onClaiming: () => order.push("claiming"),
      claim: async () => void order.push("claim"),
    })
    expect(run).toEqual({ kind: "claimed", now: true })
    expect(order).toEqual(["attendance", "read", "claiming", "claim"])
  })

  it("never sends a claim the chain would refuse, and hands back the draw that says why", async () => {
    const claim = vi.fn(async () => {})
    const draw = { claimed: false, claimable: false, reason: "not recognized" }
    const run = await claimWhenPayable({ attendanceApplied: async () => {}, readDraw: async () => draw, claim })
    expect(run).toEqual({ kind: "not-payable", draw })
    expect(claim).not.toHaveBeenCalled()
  })

  it("says a prize already claimed is claimed, without sending", async () => {
    const claim = vi.fn(async () => {})
    const run = await claimWhenPayable({ attendanceApplied: async () => {}, readDraw: async () => ({ claimed: true, claimable: false }), claim })
    expect(run).toEqual({ kind: "claimed", now: false })
    expect(claim).not.toHaveBeenCalled()
  })

  it("tells each way it can stop", async () => {
    const boom = new Error("boom")
    const base = { attendanceApplied: async () => {}, readDraw: async () => payable, claim: async () => {} }
    await expect(claimWhenPayable({ ...base, attendanceApplied: () => Promise.reject(boom) })).resolves.toEqual({ kind: "no-attendance", error: boom })
    await expect(claimWhenPayable({ ...base, readDraw: () => Promise.reject(boom) })).resolves.toEqual({ kind: "unreadable", error: boom })
    await expect(claimWhenPayable({ ...base, readDraw: async () => undefined })).resolves.toEqual({ kind: "no-draw" })
    await expect(claimWhenPayable({ ...base, claim: () => Promise.reject(boom) })).resolves.toEqual({ kind: "not-claimed", error: boom })
  })
})
