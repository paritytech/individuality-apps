// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * TURN that arrives after the mesh opened (#270 starts a mesh on STUN only
 * after 8 s): every connection made from then on uses it, rebuilds included,
 * and the ones that have not connected take it at once. Driven through the
 * fake RTCPeerConnection of test-pc.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, setupMesh } from "./test-pc"

const STUN = { urls: ["stun:stun.l.google.com:19302"] }
const TURN = { urls: ["turn:relay.example:3478"], username: "u", credential: "p" }

describe("TURN that arrives after the mesh opened", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("reaches a link that has not connected at once, and every rebuild after", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setIceServers([STUN, TURN])
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
    expect(pc.config?.iceServers).toEqual([STUN, TURN])
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(21_000) // never connected: rebuilt
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].config?.iceServers).toEqual([STUN, TURN])
    const boundary = consoleLog.mock.calls.find((call) => call[0] === "[jollity-rtc] PC constructor configuration" && call[1] === "ice_servers=2")
    expect(boundary).toEqual(["[jollity-rtc] PC constructor configuration", "ice_servers=2", "turn_servers=1"])
    expect(boundary?.join(" ")).not.toContain("relay.example")
    expect(boundary?.join(" ")).not.toContain("credential")
    mesh.close()
  })

  it("updates a connected link without restarting it, ready for a later ICE restart", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    mesh.setIceServers([STUN, TURN])
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
    expect(pc.config?.iceServers).toEqual([STUN, TURN])
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })
})
