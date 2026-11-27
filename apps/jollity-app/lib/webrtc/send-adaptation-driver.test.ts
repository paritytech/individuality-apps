// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { SendAdaptationDriver, sendAdaptationSnapshot, type SendAdaptationMesh } from "./send-adaptation-driver"
import { VIDEO_RUNGS, type VideoRungApplyResult } from "./send-adaptation-classifier"
import type { PeerReport } from "./mesh"

const result = (requested: number): VideoRungApplyResult => ({
  requested,
  uniform: true,
  senders: [{ id: "peer:0", status: "applied", appliedFields: ["maxBitrate", "scaleResolutionDownBy", "maxFramerate"], refusedFields: [] }],
})

const mesh = (): SendAdaptationMesh & { applyVideoRung: ReturnType<typeof vi.fn> } => {
  let rung = 0
  return {
    videoRung: () => rung,
    applyVideoRung: vi.fn(async (next) => {
      rung = next.index
      return result(next.index)
    }),
  }
}

const reports = (at: number, availableKbps: number, reason: "none" | "bandwidth" = "none", framesEncoded = at / 100): PeerReport[] =>
  Array.from({ length: 5 }, (_, index) => ({
    id: `p${index}`,
    away: false,
    conn: "connected" as const,
    ice: "connected" as const,
    gather: "complete" as const,
    sig: "stable" as const,
    send: ["video"],
    recv: ["video"],
      quality: {
      link: index + 1,
      at,
      rttMs: 80,
      outgoingKbps: availableKbps,
      localType: "host",
        remoteType: "srflx",
        inbound: { id: `in-${index}`, framesDecoded: framesEncoded },
      outbound: {
        id: `out-${index}`,
        framesEncoded,
        framesSent: framesEncoded,
        bytesSent: at * 5,
        packetsSent: at / 10,
        totalPacketSendDelay: at / 100_000,
        totalEncodeTime: at / 10_000,
        qualityLimitationReason: reason,
        targetBitrate: reason === "bandwidth" ? 20_000 : 300_000,
        qualityLimitationDurations: { none: reason === "none" ? at / 1_000 : 0, bandwidth: reason === "bandwidth" ? at / 1_000 : 0 },
      },
    },
  }))

describe("SendAdaptationDriver", () => {
  const setup = () => {
    let now = 0
    let hidden = false
    const driver = new SendAdaptationDriver({
      nowMs: () => now,
      hidden: () => hidden,
      effectsHealth: () => ({ windowMs: 30_000 }),
    })
    return { driver, setNow: (value: number) => (now = value), setHidden: (value: boolean) => (hidden = value) }
  }

  it("a pinned game starts at the pin, applies it to the mesh and labels the snapshot", () => {
    const driver = new SendAdaptationDriver({ nowMs: () => 0, hidden: () => false, effectsHealth: () => ({ windowMs: 30_000 }), pinnedRung: () => 4 })
    const attached = mesh()
    driver.attachMesh(attached)
    driver.startGame(17)
    expect(driver.videoRung()).toBe(4)
    expect(attached.applyVideoRung).toHaveBeenCalledWith(expect.objectContaining({ name: "survival" }))
    expect(sendAdaptationSnapshot().pinned).toBe("survival")
  })

  it("starts every game Full and uses the first completed window for fit", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60))
    expect(attached.applyVideoRung).not.toHaveBeenCalled()
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60))
    expect(driver.videoRung()).toBe(4)
    expect(attached.applyVideoRung).toHaveBeenCalledWith(VIDEO_RUNGS[4])

    driver.startGame(18)
    expect(driver.videoRung()).toBe(0)
  })

  it("keeps the rung across an in-game room rebuild", async () => {
    const { driver, setNow } = setup()
    driver.startGame(17)
    const first = mesh()
    driver.attachMesh(first)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60))
    expect(driver.videoRung()).toBe(4)
    driver.detachMesh(first)
    const second = mesh()
    driver.attachMesh(second)
    expect(driver.rung()).toBe(VIDEO_RUNGS[4])
    await vi.waitFor(() => expect(second.applyVideoRung).toHaveBeenCalledWith(VIDEO_RUNGS[4]))
  })

  it("does not stay awaiting apply when no mesh exists or a mesh write throws", async () => {
    const { driver, setNow } = setup()
    driver.startGame(17)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60))
    expect(driver.videoRung()).toBe(0)
    expect(sendAdaptationSnapshot().state.mode).toBe("steady")

    const failed = mesh()
    failed.applyVideoRung.mockRejectedValueOnce(new Error("setParameters failed"))
    driver.attachMesh(failed)
    setNow(7_000)
    await driver.observeReports(reports(7_000, 60, "bandwidth"))
    setNow(10_000)
    await driver.observeReports(reports(10_000, 60, "bandwidth"))
    expect(sendAdaptationSnapshot().state.mode).toBe("steady")
  })

  it("does not punish an empty probe apply as a failed recovery", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    driver.detachMesh(attached)
    for (const at of [7_000, 10_000, 13_000, 16_000, 19_000]) {
      setNow(at)
      await driver.observeReports(reports(at, 3_000, "none"))
    }
    expect(sendAdaptationSnapshot().state).toMatchObject({ mode: "steady", rung: 4, recoveryHoldMs: 12_000 })
  })

  it("clears baselines on visibility return and earns no pressure credit", async () => {
    const { driver, setNow, setHidden } = setup()
    driver.startGame(17)
    const attached = mesh()
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 3_000, "bandwidth"))
    setHidden(true)
    driver.visibilityChanged(true)
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    expect(attached.applyVideoRung).not.toHaveBeenCalled()
    setHidden(false)
    driver.visibilityChanged(false)
    setNow(7_000)
    await driver.observeReports(reports(7_000, 60, "bandwidth"))
    expect(attached.applyVideoRung).not.toHaveBeenCalled()
  })

  it("re-applies last-good when a foreground reset interrupts an upward probe", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    expect(driver.videoRung()).toBe(4)
    for (const at of [7_000, 10_000, 13_000, 16_000]) {
      setNow(at)
      await driver.observeReports(reports(at, 3_000, "none"))
    }
    expect(driver.videoRung()).toBe(3)
    driver.visibilityChanged(false)
    await vi.waitFor(() => expect(attached.applyVideoRung).toHaveBeenLastCalledWith(VIDEO_RUNGS[4]))
    expect(driver.videoRung()).toBe(4)
  })

  it("never mutates low-power or effects under CPU pressure", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 3_000, "none"))
    setNow(4_000)
    const cpu = reports(4_000, 3_000, "none")
    for (const row of cpu) row.quality!.outbound!.qualityLimitationReason = "cpu"
    await driver.observeReports(cpu)
    expect(attached.applyVideoRung).not.toHaveBeenCalled()
  })

  it("does not seed a baseline or recovery credit from an already-congested first window", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    const highRtt = (at: number, available: number, reason: "none" | "bandwidth") => {
      const rows = reports(at, available, reason)
      for (const row of rows) row.quality!.rttMs = 400
      return rows
    }
    setNow(1_000)
    await driver.observeReports(highRtt(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(highRtt(4_000, 60, "bandwidth"))
    expect(driver.videoRung()).toBe(4)
    for (const at of [7_000, 10_000, 13_000, 16_000]) {
      setNow(at)
      await driver.observeReports(highRtt(at, 3_000, "none"))
    }
    expect(driver.videoRung()).toBe(4)
    expect(sendAdaptationSnapshot().state.mode).not.toBe("probing-up")
  })

  it("clears stale capacity windows whenever the mesh is replaced", async () => {
    const { driver, setNow } = setup()
    const first = mesh()
    driver.startGame(17)
    driver.attachMesh(first)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 4_000).slice(0, 2))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 4_000).slice(0, 2))
    expect(sendAdaptationSnapshot().lastWindow).toBeDefined()
    driver.detachMesh(first)
    expect(sendAdaptationSnapshot().lastWindow).toBeUndefined()
    driver.attachMesh(mesh())
    await driver.activeSendersChanged(5)
    expect(driver.videoRung()).toBe(0)
  })

  it("rejects a BWE-limited upward probe instead of accepting an unchanged encoder", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    for (const at of [7_000, 10_000, 13_000, 16_000]) {
      setNow(at)
      await driver.observeReports(reports(at, 3_000, "none"))
    }
    expect(driver.videoRung()).toBe(3)
    const limited = reports(19_000, 3_000, "bandwidth")
    for (const row of limited) row.quality!.outbound!.targetBitrate = 30_000
    setNow(19_000)
    await driver.observeReports(limited)
    expect(driver.videoRung()).toBe(4)
    expect(sendAdaptationSnapshot().state.recoveryHoldMs).toBe(24_000)
  })

  it("recovers on a target-less engine after explicit none and healthy queue/RTT", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    expect(driver.videoRung()).toBe(4)

    for (const at of [7_000, 10_000, 13_000, 16_000]) {
      const healthy = reports(at, 3_000, "none")
      for (const row of healthy) delete row.quality!.outbound!.targetBitrate
      setNow(at)
      await driver.observeReports(healthy)
    }
    expect(driver.videoRung()).toBe(3)
    expect(sendAdaptationSnapshot().state.mode).toBe("probing-up")
  })

  it("does not divide a measured per-PC cap again when the sender count grows", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 1_400).slice(0, 2))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 1_400).slice(0, 2))
    expect(driver.videoRung()).toBe(0)

    setNow(4_100)
    await driver.activeSendersChanged(5)
    expect(driver.videoRung()).toBe(0)
    expect(attached.applyVideoRung).not.toHaveBeenCalled()
  })

  it("does not reset recovery when a reconnect still fits the measured cap", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth").slice(0, 4))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth").slice(0, 4))
    expect(driver.videoRung()).toBe(4)

    for (const at of [7_000, 10_000, 13_000]) {
      setNow(at)
      await driver.observeReports(reports(at, 400, "none").slice(0, 4))
    }
    expect(sendAdaptationSnapshot().state.healthyWindows).toBe(3)
    setNow(13_100)
    await driver.activeSendersChanged(5)
    expect(sendAdaptationSnapshot().state.healthyWindows).toBe(3)

    setNow(16_000)
    await driver.observeReports(reports(16_000, 400, "none"))
    setNow(19_000)
    await driver.observeReports(reports(19_000, 400, "none"))
    expect(driver.videoRung()).toBe(3)
    expect(attached.applyVideoRung).toHaveBeenLastCalledWith(VIDEO_RUNGS[3])
  })

  it("does not synthesize pressure from a baseline-only partial sender window", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 2_250).slice(0, 2))
    const partial = reports(4_000, 2_250).slice(0, 2)
    partial[1]!.quality!.outbound!.id = "replaced-outbound"
    setNow(4_000)
    await driver.observeReports(partial)
    setNow(4_100)
    await driver.activeSendersChanged(5)
    expect(attached.applyVideoRung).not.toHaveBeenCalled()
  })

  it("treats sender growth during an upward probe as a neutral regroup", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    for (const [at, reason, cap] of [
      [1_000, "bandwidth", 60],
      [4_000, "bandwidth", 60],
      [7_000, "none", 3_000],
      [10_000, "none", 3_000],
      [13_000, "none", 3_000],
      [16_000, "none", 3_000],
    ] as const) {
      setNow(at)
      await driver.observeReports(reports(at, cap, reason))
    }
    expect(sendAdaptationSnapshot().state.mode).toBe("probing-up")
    setNow(16_100)
    await driver.activeSendersChanged(6)
    expect(sendAdaptationSnapshot().state).toMatchObject({ mode: "steady", rung: 4, recoveryHoldMs: 12_000 })
    await vi.waitFor(() => expect(attached.applyVideoRung).toHaveBeenLastCalledWith(VIDEO_RUNGS[4]))
  })

  it("bounds a persistently invalid new link instead of freezing adaptation", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    for (const at of [1_000, 4_000, 7_000, 10_000, 13_000]) {
      const rows = reports(at, 60, "bandwidth").slice(0, 2)
      rows[1]!.quality!.outbound!.id = `new-outbound-${at}`
      setNow(at)
      await driver.observeReports(rows)
    }
    expect(driver.videoRung()).toBeGreaterThan(0)
  })

  it("keeps the low RTT floor when later pressured samples bloat", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    const atRtt = (at: number, cap: number, reason: "none" | "bandwidth", rttMs: number) => {
      const rows = reports(at, cap, reason)
      for (const row of rows) row.quality!.rttMs = rttMs
      return rows
    }
    for (const [at, cap, reason, rtt] of [
      [1_000, 3_000, "none", 80],
      [4_000, 3_000, "none", 80],
      [7_000, 300, "bandwidth", 800],
      [10_000, 300, "bandwidth", 800],
      [13_000, 3_000, "none", 800],
      [16_000, 3_000, "none", 800],
      [19_000, 3_000, "none", 800],
      [22_000, 3_000, "none", 800],
    ] as const) {
      setNow(at)
      await driver.observeReports(atRtt(at, cap, reason, rtt))
    }
    expect(driver.videoRung()).toBeGreaterThan(0)
    expect(sendAdaptationSnapshot().state.mode).not.toBe("probing-up")
  })

  it("continues stepwise recovery after a benign Wi-Fi-to-cell RTT change", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    const atRtt = (at: number, rttMs: number, reason: "none" | "bandwidth", availableKbps: number) => {
      const rows = reports(at, availableKbps, reason)
      for (const row of rows) row.quality!.rttMs = rttMs
      return rows
    }

    for (const at of [1_000, 4_000]) {
      setNow(at)
      await driver.observeReports(atRtt(at, 21, "bandwidth", 60))
    }
    expect(driver.videoRung()).toBe(4)

    for (const at of [7_000, 10_000, 13_000, 16_000, 19_000]) {
      setNow(at)
      await driver.observeReports(atRtt(at, 21, "none", 3_000))
    }
    const cellWindows = [22_000, 25_000, 28_000, 31_000, 34_000, 37_000, 40_000, 43_000, 46_000, 49_000, 52_000, 55_000]
    for (const at of cellWindows) {
      setNow(at)
      await driver.observeReports(atRtt(at, 65, "none", 3_000))
      if (at === cellWindows[0])
        expect(sendAdaptationSnapshot().lastWindow).toMatchObject({ rttMs: 65, baselineRttMs: 21, pressure: "healthy" })
    }

    expect(driver.videoRung()).toBe(1)
    expect(sendAdaptationSnapshot().lastWindow).toMatchObject({ rttMs: 65, pressure: "healthy" })
  })

  it("reconciles evidence when a regroup interrupts an in-flight probe", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    let resolveProbe: ((value: VideoRungApplyResult) => void) | undefined
    attached.applyVideoRung.mockImplementationOnce((next) => new Promise<VideoRungApplyResult>((resolve) => (resolveProbe = resolve)).then(() => result(next.index)))
    let observing: Promise<void> = Promise.resolve()
    for (const at of [7_000, 10_000, 13_000, 16_000, 19_000]) {
      setNow(at)
      observing = driver.observeReports(reports(at, 3_000, "none"))
      await Promise.resolve()
      if (resolveProbe) break
      await observing
    }
    expect(resolveProbe).toBeTypeOf("function")
    driver.visibilityChanged(false)
    expect(sendAdaptationSnapshot()).toMatchObject({ currentRung: 4, state: { mode: "steady", rung: 4 } })
    resolveProbe!(result(3))
    await observing
    expect(sendAdaptationSnapshot()).toMatchObject({ currentRung: 4, state: { mode: "steady", rung: 4 } })
  })

  it("keeps an unanswered down request across a regroup and rewrites the mesh rung, not full", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    // hold the apply so the request is in flight when the regroup lands
    let resolveDown: ((value: VideoRungApplyResult) => void) | undefined
    attached.applyVideoRung.mockImplementationOnce((next) => new Promise<VideoRungApplyResult>((resolve) => (resolveDown = resolve)).then(() => result(next.index)))
    setNow(4_000)
    const observing = driver.observeReports(reports(4_000, 60, "bandwidth"))
    await Promise.resolve()
    expect(resolveDown).toBeTypeOf("function")
    driver.detachMesh(attached)
    expect(sendAdaptationSnapshot().state).toMatchObject({ mode: "awaiting-apply", rung: 0 })
    // the host finally answers the move it actually applied
    resolveDown!(result(4))
    await observing
    expect(sendAdaptationSnapshot().state).toMatchObject({ mode: "down-hold", rung: 4 })
    const second = mesh()
    driver.attachMesh(second)
    await vi.waitFor(() => expect(second.applyVideoRung).toHaveBeenCalledWith(VIDEO_RUNGS[4]))
    expect(driver.videoRung()).toBe(4)
  })

  it("counts an empty apply result on a down request as a refusal, not a neutral regroup", async () => {
    const { driver, setNow } = setup()
    const attached = mesh()
    driver.startGame(17)
    driver.attachMesh(attached)
    // the mesh applies rung 4 itself and answers the request with no senders
    attached.applyVideoRung.mockImplementationOnce(async (next) => {
      ;(attached as unknown as { videoRung: () => number }).videoRung = () => next.index
      return { requested: next.index, uniform: false, senders: [] }
    })
    setNow(1_000)
    await driver.observeReports(reports(1_000, 60, "bandwidth"))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 60, "bandwidth"))
    expect(sendAdaptationSnapshot().state).toMatchObject({ mode: "steady", rung: 0, recoveryHoldMs: 12_000 })
    await vi.waitFor(() => expect(attached.applyVideoRung).toHaveBeenLastCalledWith(VIDEO_RUNGS[0]))
  })

  it("retains account-keyed decoded-frame growth for live receiver proof", async () => {
    const { driver, setNow } = setup()
    driver.startGame(17)
    driver.setGameTurn(0)
    setNow(1_000)
    await driver.observeReports(reports(1_000, 900).slice(0, 1))
    setNow(4_000)
    await driver.observeReports(reports(4_000, 900, "none", 50).slice(0, 1))
    driver.setGameTurn(4)
    for (let index = 0; index < 70; index += 1) {
      const at = 7_000 + index * 3_000
      setNow(at)
      await driver.observeReports(reports(at, 900, "none", 51 + index).slice(0, 1))
    }
    expect(sendAdaptationSnapshot().peers[0]).toEqual({
      account: "p0",
      connected: true,
      away: false,
      firstFramesDecoded: 10,
      lastFramesDecoded: 120,
      decodedSamples: [
        { turn: 0, firstElapsedMs: 1_000, lastElapsedMs: 4_000, firstFramesDecoded: 10, lastFramesDecoded: 50 },
        { turn: 4, firstElapsedMs: 7_000, lastElapsedMs: 214_000, firstFramesDecoded: 51, lastFramesDecoded: 120 },
      ],
    })
  })
})
