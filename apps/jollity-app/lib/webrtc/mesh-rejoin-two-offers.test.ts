// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A player whose app was down for a while comes back on fresh connections,
 * and each peer's two offers arrive almost at once: the one it left in the
 * store while the player was away, and its fresh rejoin offer, from another
 * connection (games 1565, 1571, 1575; bot 20). Chrome runs the two
 * setRemoteDescription calls one after the other on its operations chain, so
 * the second offer reached the new-session check while the first was still
 * being set (no remote description yet), and both were applied to one
 * connection. The first run's answer then answered the second offer, and the
 * second run's setLocalDescription, on a stable connection, made an OFFER
 * that went out as the answer. The peer took it for glare and ignored it,
 * and the link never formed.
 *
 * The mesh takes one peer's signals in turn: a description is applied before
 * the next signal from that peer is read, so the second offer sees the first
 * one's session and takes the new-session rebuild. And only an answer is ever
 * sent as one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, decodeChannelMessage, decodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

type Sent = { rtc: { desc?: { type: string; sdp?: string }; gen?: string } }
const descriptions = (signals: unknown[]) => (signals as Sent[]).filter((s) => s.rtc.desc).map((s) => ({ type: s.rtc.desc!.type, gen: s.rtc.gen }))

describe("a rejoining player's two offers from one peer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    FakePC.operationsChain = true
  })
  afterEach(() => {
    FakePC.operationsChain = false
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("answers the second on a rebuilt connection, and sends no offer as an answer", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    pc.iceGatheringState = "gathering" // a real answer gathers for a while
    // the stored offer from the peer's earlier connection, then its fresh rejoin offer
    const stored = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    const fresh = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("222") }, gen: "A.2" } })
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all([stored, fresh])

    // exactly one description went out, and it is the fresh offer's answer
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.2" }])
    // the second offer took the new-session rebuild: the fresh connection holds it
    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("222"))
    expect(FakePC.last[1].localDescription?.type).toBe("answer")
    mesh.close()
  })

  it("takes three back-to-back offers in turn: only answers go out, the last to the last offer", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    pc.iceGatheringState = "gathering"
    // the stored offer, a self-heal re-offer and the rejoin offer, each from another connection
    const runs = ["111", "222", "333"].map((session, i) =>
      mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp(session) }, gen: `A.${i + 1}` } }))
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all(runs)
    // A rebuilt connection here gathers at once, so the second offer's answer
    // may go out before the third rebuilds (the peer's gen gate drops it);
    // what must hold is that only answers go out, one per offer at most, the
    // last one to the last offer.
    const sent = descriptions(signals)
    expect(sent.every((d) => d.type === "answer")).toBe(true)
    expect(new Set(sent.map((d) => d.gen)).size).toBe(sent.length)
    expect(sent.at(-1)).toEqual({ type: "answer", gen: "A.3" })
    expect(FakePC.last).toHaveLength(3)
    expect(FakePC.last.at(-1)!.remoteDescription?.sdp).toBe(sdp("333"))
    expect(FakePC.last.at(-1)!.localDescription?.type).toBe("answer")
    mesh.close()
  })

  it("never rolls back our own offer, made and sent while the answer gathered", async () => {
    FakePC.operationsChain = false
    const { mesh, pc, signals } = await setupMesh("b", "a")
    pc.iceGatheringState = "gathering"
    const answering = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    await vi.advanceTimersByTimeAsync(0)
    expect(pc.localDescription?.type).toBe("answer")
    // our own offer (a renegotiation), set and sent during the answer's gather
    await pc.setLocalDescription()
    const ours = pc.localDescription
    await vi.advanceTimersByTimeAsync(10_000)
    await answering
    expect(pc.signalingState).toBe("have-local-offer")
    expect(pc.localDescription).toBe(ours)
    // this connection sends no answer; the polite side answers the offer on a
    // fresh responder instead (#1606), under the offer's own gen
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1]!.localDescription?.type).toBe("answer")
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.1" }])
    mesh.close()
  })

  it("sends nothing when the local description it would send is not an answer", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    // a connection whose setLocalDescription made an offer (it was stable when it ran)
    vi.spyOn(pc, "setLocalDescription").mockImplementation(async () => {
      pc.localDescription = { type: "offer", sdp: "v=0" }
      pc.signalingState = "have-local-offer"
    })
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    await vi.advanceTimersByTimeAsync(0)
    // nothing from this connection; the answer comes from the fresh responder (#1606)
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1]!.localDescription?.type).toBe("answer")
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.1" }])
    mesh.close()
  })

  it("applies a second offer of the same connection once the first answer is set, without glare", async () => {
    const { mesh, pc, signals } = await setupMesh("b", "a")
    pc.iceGatheringState = "gathering"
    const first = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    const second = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111", { ufrag: "u2" }) }, gen: "A.2" } })
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all([first, second])
    expect(FakePC.last).toHaveLength(1)
    expect(pc.remoteDescription?.sdp).toBe(sdp("111", { ufrag: "u2" }))
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.2" }])
    mesh.close()
  })

  it("waits no longer than its bound for an offer whose setRemoteDescription never settles", async () => {
    FakePC.operationsChain = false
    const { mesh, pc, signals } = await setupMesh("b", "a")
    vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce(() => new Promise<void>(() => {}))
    void mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    // not awaited: with the actor driving, onRtc also waits out the hung command
    void mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("222") }, gen: "A.2" } })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(descriptions(signals)).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.2" }])
    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("222"))
    mesh.close()
  })

  it("keeps the fresh offer authoritative when the first session's setRemoteDescription resolves late", async () => {
    FakePC.operationsChain = false
    const { mesh, pc, signals } = await setupMesh("b", "a")
    const internals = mesh as unknown as {
      conns: Map<string, { pc: FakePC; offersApplied: number }>
      statementAnswering: Map<string, { gen?: string; applied?: number }>
    }
    const answeringSet = vi.spyOn(internals.statementAnswering, "set")
    const stale = internals.conns.get("a")!
    const setRemoteDescription = pc.setRemoteDescription.bind(pc)
    const setLocalDescription = FakePC.prototype.setLocalDescription
    let resolveFirst!: () => void
    let resolveFreshAnswer!: () => void
    vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce((desc) => new Promise<void>((resolve, reject) => {
      resolveFirst = () => void setRemoteDescription(desc).then(resolve, reject)
    }))
    vi.spyOn(FakePC.prototype, "setLocalDescription").mockImplementation(function (this: FakePC, desc) {
      if (FakePC.last.indexOf(this) !== 1) return setLocalDescription.call(this, desc)
      return new Promise<void>((resolve, reject) => {
        resolveFreshAnswer = () => void setLocalDescription.call(this, desc).then(resolve, reject)
      })
    })
    const first = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    const second = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("222") }, gen: "A.2" } })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("222"))
    expect(descriptions(signals)).toEqual([])

    resolveFirst()
    await vi.advanceTimersByTimeAsync(0)
    const fresh = internals.conns.get("a")!
    expect(fresh.offersApplied).toBe(1)
    expect(answeringSet).toHaveBeenLastCalledWith("a", expect.objectContaining({ gen: "A.2", applied: 1 }))
    expect(stale.offersApplied).toBe(0)

    resolveFreshAnswer()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([first, second])
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.2" }])
    expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("222"))
    mesh.close()
  })

  it("does not hold the peer's offer on a fresh connection for one hung on the connection it replaced", async () => {
    FakePC.operationsChain = false
    const { mesh, pc, signals } = await setupMesh("b", "a")
    vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce(() => new Promise<void>(() => {}))
    void mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    mesh.removePeer("a") // the hung connection is closed
    void mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("222") }, gen: "A.2" } })
    await vi.advanceTimersByTimeAsync(0) // no bound waited out
    expect(FakePC.last).toHaveLength(2)
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.2" }])
    mesh.close()
  })

  it("rolls an offer made in place of the answer back, so the connection is stable again", async () => {
    FakePC.operationsChain = false
    const { mesh, pc, signals } = await setupMesh("b", "a")
    vi.spyOn(pc, "setLocalDescription").mockImplementationOnce(async () => {
      pc.localDescription = { type: "offer", sdp: "v=0" }
      pc.signalingState = "have-local-offer"
    })
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    expect(pc.signalingState).toBe("stable")
    expect(pc.localDescription).toBeNull()
    // nothing from this connection; the fresh responder answers (#1606)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakePC.last).toHaveLength(2)
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.1" }])
    mesh.close()
  })

  it("sends no offer as a lane answer either", async () => {
    FakePC.operationsChain = false
    const { mesh, pc } = await setupMesh("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") } } })
    const channel = new FakeChannel()
    channel.readyState = "open"
    ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
    vi.spyOn(pc, "setLocalDescription").mockImplementation(async () => {
      pc.localDescription = { type: "offer", sdp: "v=0" }
      pc.signalingState = "have-local-offer"
    })
    const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag: "Offer", value: sdp("111", { media: ["video"] }) }) })
    ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe(sdp("111", { media: ["video"] })))
    await vi.advanceTimersByTimeAsync(0)
    const laneAnswers = channel.send.mock.calls
      .map(([bytes]) => decodeChannelMessage(new Uint8Array(bytes as ArrayBuffer)))
      .filter((message) => message.id === USE_CASE_RENEGOTIATION)
      .map((message) => decodePeerConnectionSignal(message.data).tag)
    expect(laneAnswers).toEqual([])
    mesh.close()
  })
})
