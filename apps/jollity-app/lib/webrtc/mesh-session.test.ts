// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What the mesh does with the signalling's session facts (#214):
 *  - it echoes an offer's gen on its answer (F7), so the transport labels the
 *    answer with the offer it answers and not with whatever generation came
 *    after;
 *  - it rebuilds a peer's connection when the transport says the peer's
 *    session changed (`onPeerSession`: the peer reloaded), instead of waiting
 *    to tell it from the SDP of the new session's first description.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, sdp, setupMesh } from "./test-pc"
import type { HealEvent } from "./heal"

const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const answers = (signals: unknown[]) =>
  signals.filter((s) => (s as { rtc: { desc?: { type: string } } }).rtc.desc?.type === "answer") as Array<{ rtc: { gen?: string } }>

describe("the mesh and the offer's gen (F7)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("echoes the gen of the offer it answers", async () => {
    const { mesh, signals } = await setupMesh("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "g1" } })
    expect(answers(signals).map((s) => s.rtc.gen)).toEqual(["g1"])
    mesh.close()
  })

  it("echoes it on the fresh connection too, when the old one refused the offer", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111", { media: ["audio", "video"] }) }, gen: "g1" } })
    state(pc, "connected")
    signals.length = 0
    // no session to tell by, so the refusal is what rebuilds
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" }, gen: "g2" } })
    expect(FakePC.last).toHaveLength(2)
    expect(answers(signals).map((s) => s.rtc.gen)).toEqual(["g2"])
    mesh.close()
  })

  it("leaves the answer to the newer run when a newer offer was applied during the gather", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    pc.iceGatheringState = "gathering" // each answer waits for its gather
    const first = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    await vi.advanceTimersByTimeAsync(0)
    const second = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111", { ufrag: "u2" }) }, gen: "A.2" } })
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([first, second])
    expect(answers(signals).map((s) => s.rtc.gen)).toEqual(["A.2"])
    mesh.close()
  })

  it("still answers when the offer's candidates are added during the gather (game 1120)", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    pc.iceGatheringState = "gathering"
    const answering = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    await vi.advanceTimersByTimeAsync(0)
    // a bundle carries the offer and its candidates: they land while the answer gathers
    await mesh.onRtc("a", { rtc: { cand: { candidate: "candidate:1 1 udp 41885439 104.30.149.195 47556 typ relay raddr 0.0.0.0 rport 0" } } } as never)
    expect(pc.remoteDescription?.sdp).not.toBe(sdp("111"))
    await vi.advanceTimersByTimeAsync(10_000)
    await answering
    expect(answers(signals).map((s) => s.rtc.gen)).toEqual(["A.1"])
    mesh.close()
  })

  it("sends an answer with no gen when the offer came without one", async () => {
    const { mesh, signals } = await setupMesh("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") } } })
    expect(answers(signals)).toHaveLength(1)
    expect(answers(signals)[0].rtc).not.toHaveProperty("gen")
    mesh.close()
  })
})

describe("the mesh and a peer's new session", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("rebuilds the connection when the peer's session changes, and answers the new session's offer on the fresh one without another rebuild", async () => {
    const heals: HealEvent[] = []
    const { mesh, pc, signals } = await setupMesh("b", "a", { onRtcEvent: (_peer, { kind, ...event }) => kind === "heal" && heals.push(event as HealEvent) })
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    state(pc, "connected")
    signals.length = 0
    mesh.onPeerSession("a")
    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    // the new session's offer: the same o= line (a stack that writes o=- 0 0) is no obstacle now
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "B.1" } })
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("111"))
    expect(answers(signals).map((s) => s.rtc.gen)).toEqual(["B.1"])
    state(FakePC.last[1], "connected")
    expect(heals.map((e) => [e.trigger, e.action, e.healed])).toEqual([["rejoin_offer", "rebuild", true]])
    mesh.close()
  })

  it("rebuilds the initiator's connection that offered to the old session and offers anew", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    await pc.onnegotiationneeded!() // our offer, to the session that then reloaded
    mesh.onPeerSession("b")
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].channels).toHaveLength(1) // it offers (the data channel goes on that offer)
    mesh.close()
  })

  it("lets the answerer of the pair offer when its own recovery offer went to the old session", async () => {
    const { mesh, pc } = await setupMesh("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    state(pc, "connected")
    pc.localDescription = { type: "offer", sdp: "v=0" } // a recovery offer of ours, unanswered when a reloaded
    mesh.onPeerSession("a")
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].channels).toHaveLength(1) // it may offer (the data channel goes on that offer)
    mesh.close()
  })

  it("keeps the answerer waiting for the reloaded initiator's offer otherwise", async () => {
    const { mesh, pc } = await setupMesh("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    state(pc, "connected")
    mesh.onPeerSession("a")
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].channels).toHaveLength(0)
    mesh.close()
  })

  it("leaves a connection that has negotiated nothing yet alone", async () => {
    const { mesh } = await setupMesh("b", "a")
    mesh.onPeerSession("a")
    mesh.onPeerSession("nobody")
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })
})
