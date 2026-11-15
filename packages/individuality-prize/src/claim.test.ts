// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { CLAIM_REFUSALS, CLAIM_RETRY_MS, claimWithRetry, type ClaimStatus } from "./claim"
import type { DispatchResult } from "@individuality/people-chain"

function run(statuses: ClaimStatus[], sends: (DispatchResult | Error)[]) {
  const sent: number[] = []
  const slept: number[] = []
  const retried: number[] = []
  let read = 0
  const outcome = claimWithRetry({
    status: async () => statuses[Math.min(read++, statuses.length - 1)],
    send: async () => {
      const next = sends[sent.length]!
      sent.push(sent.length)
      if (next instanceof Error) throw next
      return next
    },
    declined: (detail) => /user rejected/i.test(detail),
    sleep: async (ms) => void slept.push(ms),
    onRetry: (attempt) => void retried.push(attempt),
  })
  return { outcome, sent, slept, retried }
}

describe("claimWithRetry", () => {
  it("claims on the first send", async () => {
    const { outcome, sent } = run(["claimable"], [{ ok: true }])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(1)
  })

  it("sends nothing for a claim that already landed", async () => {
    const { outcome, sent } = run(["claimed"], [])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(0)
  })

  it("sends nothing once the claim is closed, and keeps the reason the read gives", async () => {
    const { outcome, sent } = run([{ closed: "PlayedSince" }], [])
    expect(await outcome).toEqual({ kind: "refused", detail: "PlayedSince" })
    expect(sent).toHaveLength(0)
  })

  it("names the rule a refusal broke when the read after it tells", async () => {
    const { outcome } = run(["claimable", { closed: "NotMember" }], [{ ok: false, error: "NotEligibleForAirdrop" }])
    expect(await outcome).toEqual({ kind: "refused", detail: "NotMember" })
  })

  it("sends again after a nonce refusal", async () => {
    const { outcome, sent } = run(["claimable"], [{ ok: false, error: "Stale" }, { ok: false, error: "Future" }, { ok: true }])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(3)
  })

  it("stops at a closed signing sheet without sending again", async () => {
    const { outcome, sent } = run(["claimable"], [{ ok: false, error: "User rejected the request" }])
    expect(await outcome).toEqual({ kind: "cancelled", detail: "User rejected the request" })
    expect(sent).toHaveLength(1)
  })

  it("sends a dropped call again after each wait and claims", async () => {
    const { outcome, sent, slept, retried } = run(["claimable"], [new Error("socket closed"), new Error("socket closed"), { ok: true }])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(3)
    expect(slept).toEqual([CLAIM_RETRY_MS[0], CLAIM_RETRY_MS[1]])
    expect(retried).toEqual([1, 2])
  })

  it("gives up after the last wait", async () => {
    const dropped = new Error("socket closed")
    const { outcome, sent, slept } = run(["claimable"], [dropped, dropped, dropped, dropped])
    expect(await outcome).toEqual({ kind: "failed", detail: "socket closed" })
    expect(sent).toHaveLength(CLAIM_RETRY_MS.length + 1)
    expect(slept).toEqual([...CLAIM_RETRY_MS])
  })

  it("reads the status once more after the last send, which may have landed", async () => {
    const unknown = { ok: false as const, error: "Tracking stopped", landingUnknown: true as const }
    const statuses: ClaimStatus[] = [...Array<ClaimStatus>(CLAIM_RETRY_MS.length + 1).fill("claimable"), "claimed"]
    const { outcome, sent } = run(statuses, [unknown, unknown, unknown, unknown])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(CLAIM_RETRY_MS.length + 1)
  })

  it("does not send again once the status read finds the dropped claim landed", async () => {
    const { outcome, sent } = run(["claimable", "claimed"], [new Error("socket closed")])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(1)
  })

  it("reads a refusal again before calling it one", async () => {
    const { outcome } = run(["claimable", "claimed"], [{ ok: false, error: "AlreadyClaimed" }])
    expect(await outcome).toEqual({ kind: "claimed" })
  })

  it("ends on a refusal the status read does not explain", async () => {
    const { outcome, sent } = run(["claimable"], [{ ok: false, error: "NotWinner" }])
    expect(await outcome).toEqual({ kind: "refused", detail: "NotWinner" })
    expect(sent).toHaveLength(1)
  })

  it("sends again when the landing of a send is unknown", async () => {
    const { outcome, sent } = run(["claimable"], [{ ok: false, error: "watch ended", landingUnknown: true }, { ok: true }])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(2)
  })

  it("sends when the status read fails", async () => {
    const { outcome, sent } = run([undefined], [{ ok: true }])
    expect(await outcome).toEqual({ kind: "claimed" })
    expect(sent).toHaveLength(1)
  })
})

describe("CLAIM_REFUSALS", () => {
  it("names the reasons a claim is refused for, once each", () => {
    expect(CLAIM_REFUSALS).toContain("NotEligibleForAirdrop")
    expect(CLAIM_REFUSALS).toContain("ClaimingWindowClosed")
    expect(new Set(CLAIM_REFUSALS).size).toBe(CLAIM_REFUSALS.length)
  })
})
