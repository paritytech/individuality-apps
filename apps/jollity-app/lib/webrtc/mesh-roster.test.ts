// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One mesh for the game's rounds. The room no longer changes at a regroup, so
 * the Mesh is told who it links to: this round's group (`active`) and every
 * later round's co-players (`standby`). A player in both rounds keeps the very same
 * RTCPeerConnection; one who leaves the group is closed; a stranger's signal
 * in the game's room opens nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, sdp, setupMesh } from "./test-pc"

describe("the mesh's roster across rounds", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("keeps the connection of a player who stays, closes the one who leaves, and stands the newcomer by", async () => {
    const { mesh } = await setupMesh("a", "b")
    mesh.setPeers(["b", "c"], [])
    const [pcB, pcC] = FakePC.last
    // the last turn: d joins next round, b stays, c leaves after it
    mesh.setPeers(["b", "c"], ["d"])
    expect(FakePC.last).toHaveLength(3)
    const pcD = FakePC.last[2]!
    expect(mesh.standing()).toEqual(["d"])
    // the gap: the next group is b and d
    const removed = mesh.setPeers(["b", "d"], [])
    expect(removed).toEqual(["c"])
    expect(pcC!.close).toHaveBeenCalled()
    expect(pcB!.close).not.toHaveBeenCalled()
    expect(pcD.close).not.toHaveBeenCalled()
    expect(FakePC.last).toHaveLength(3) // nobody rebuilt
    expect(mesh.standing()).toEqual([])
    expect([...mesh.health().keys()].sort()).toEqual(["b", "d"])
    mesh.close()
  })

  it("opens no link for a signal from someone outside the roster", async () => {
    const { mesh } = await setupMesh("b", "a")
    mesh.setPeers(["a"], [])
    await mesh.onRtc("z", { rtc: { desc: { type: "offer", sdp: sdp("9") }, gen: "z.1" } })
    expect(FakePC.last).toHaveLength(1)
    expect(mesh.health().has("z")).toBe(false)
    mesh.close()
  })

  it("still takes a signal from a standby peer before its hello", async () => {
    const { mesh, signals } = await setupMesh("b", "a")
    mesh.setPeers(["a"], ["c"])
    await mesh.onRtc("c", { rtc: { desc: { type: "offer", sdp: sdp("7") }, gen: "c.1" } })
    expect(mesh.health().has("c")).toBe(true)
    expect(signals.some((s) => (s as { rtc: { desc?: { type: string } } }).rtc.desc?.type === "answer")).toBe(true)
    mesh.close()
  })

  it("a mesh never given a roster takes every signal, as before", async () => {
    const { mesh } = await setupMesh("b", "a")
    await mesh.onRtc("z", { rtc: { desc: { type: "offer", sdp: sdp("9") }, gen: "z.1" } })
    expect(mesh.health().has("z")).toBe(true)
    mesh.close()
  })

  it("reads link views against this round's group", async () => {
    const { mesh } = await setupMesh("a", "b", { members: ["a", "b"] })
    mesh.setPeers(["b", "c"], ["d"])
    expect(mesh.members()).toEqual(["b", "c", "a"])
    mesh.close()
  })
})
