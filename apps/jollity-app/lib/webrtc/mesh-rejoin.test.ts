// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A peer that restarts its app (or rebuilds its link) comes back as a NEW
 * remote connection (#223). Its offer must go to a fresh RTCPeerConnection:
 * applied to the old one it fails on the m-line order, the way Chrome refused
 * it in games 160, 163 and 166. Driven through the fake RTCPeerConnection of
 * test-pc.ts, which enforces that m-line rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"
import { remoteSessionOf } from "./mesh"
import type { HealEvent } from "./heal"

async function setup(myId: string, peerId: string) {
  const heals: Array<[string, HealEvent]> = []
  const made = await setupMesh(myId, peerId, { onRtcEvent: (peer, { kind, ...event }) => kind === "heal" && heals.push([peer, event as HealEvent]) })
  return { ...made, heals }
}
const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const offer = (body: string) => ({ rtc: { desc: { type: "offer", sdp: body } } }) as never
const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never
/** what the mesh put on the statement store, as desc types */
const sent = (signals: unknown[]) => signals.map((s) => (s as { rtc: { desc?: { type: string } } }).rtc.desc?.type ?? "cand")

/** Hand an open channel to the answerer's PC and run a lane frame through it. */
async function lane(channel: FakeChannel, tag: "Offer" | "Answer", value: string) {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
  await vi.advanceTimersByTimeAsync(0)
}

/** "b" (the answerer) connected to "a"'s connection `session`, media added in band */
async function connectedAnswerer() {
  const made = await setup("b", "a")
  const { mesh, pc } = made
  await mesh.onRtc("a", offer(sdp("111")))
  const channel = new FakeChannel()
  channel.readyState = "open"
  ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
  await lane(channel, "Offer", sdp("111", { media: ["audio", "video"] }))
  state(pc, "connected")
  return made
}

describe("the remote session of an SDP", () => {
  it("is the o= session id with the fingerprint, unchanged by an ICE restart, and unknown on a bare SDP", () => {
    expect(remoteSessionOf(sdp("111", { ufrag: "u1" }))).toBe(remoteSessionOf(sdp("111", { ufrag: "u2", media: ["video"] })))
    expect(remoteSessionOf(sdp("111"))).not.toBe(remoteSessionOf(sdp("222")))
    // a stack that writes o=- 0 0 on every connection is told apart by its fingerprint
    expect(remoteSessionOf("o=- 0 0 IN IP4 0.0.0.0\na=fingerprint:sha-256 AA:BB")).not.toBe(remoteSessionOf("o=- 0 0 IN IP4 0.0.0.0\na=fingerprint:sha-256 CC:DD"))
    expect(remoteSessionOf("v=0")).toBeNull()
  })
})

describe("a peer that rejoins as a new connection (#223)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("gets a fresh connection for its new offer, answered, and the rejoin is healed by a rebuild", async () => {
    const { mesh, pc, signals, heals } = await connectedAnswerer()
    signals.length = 0
    await mesh.onRtc("a", offer(sdp("222"))) // a restarted: a new connection, the data channel alone
    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    const fresh = FakePC.last[1]
    expect(fresh.remoteDescription?.sdp).toBe(sdp("222"))
    expect(sent(signals)).toEqual(["answer"])
    state(fresh, "connected")
    expect(heals).toHaveLength(1)
    expect(heals[0][1]).toMatchObject({ trigger: "rejoin_offer", action: "rebuild", attempt: 1, healed: true, end: "connected" })
    mesh.close()
  })

  it("rebuilds as a responder when the initiator receives a new-session offer, avoiding an SSL-role race", async () => {
    const streams: MediaStream[] = []
    const { mesh, pc, signals } = await setupMesh(
      "a",
      "b",
      {},
      undefined,
      (_peer, stream) => streams.push(stream),
    )
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", answer(sdp("111")))
    state(pc, "connected")
    signals.length = 0

    await mesh.onRtc("b", offer(sdp("222")))

    const fresh = FakePC.last[1]!
    expect(fresh.channels).toHaveLength(0)
    expect(sent(signals)).toEqual(["answer"])
    const channel = new FakeChannel()
    channel.readyState = "open"
    ;(fresh.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
    const stream = {} as MediaStream
    fresh.ontrack!({ track: { kind: "video", addEventListener: () => {} }, streams: [stream] })
    expect(streams).toEqual([stream])
    mesh.close()
  })

  it("answers responder-only when an initiator receives an offer before its roster connection exists", async () => {
    const { mesh, signals } = await setup("a", "b")
    mesh.removePeer("b")
    signals.length = 0

    await mesh.onRtc("b", offer(sdp("111")))

    const fresh = FakePC.last[1]!
    expect(fresh.channels).toHaveLength(0)
    expect(sent(signals)).toEqual(["answer"])
    mesh.close()
  })

  it("takes a new connection's offer even while its own offer to the old one is in flight (the impolite end)", async () => {
    const { mesh, pc, signals } = await setup("a", "b")
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", answer(sdp("111", { media: ["video"] })))
    state(pc, "connected")
    pc.signalingState = "have-local-offer" // a's next offer, to the old connection, still unanswered
    signals.length = 0
    await mesh.onRtc("b", offer(sdp("222")))
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("222"))
    expect(sent(signals)).toEqual(["answer"])
    mesh.close()
  })

  it("rebuilds and offers anew when a new connection answers an offer of the old one", async () => {
    // the transport re-announces our first offer every heartbeat, so a peer that
    // restarted answers it from its fresh connection
    const { mesh, pc, heals } = await setup("a", "b")
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", answer(sdp("111")))
    state(pc, "connected")
    await mesh.onRtc("b", answer(sdp("222")))
    expect(FakePC.last).toHaveLength(2)
    const fresh = FakePC.last[1]
    expect(fresh.remoteDescription).toBeNull() // the answer was to an offer the fresh PC never made
    expect(fresh.channels).toHaveLength(1) // it offers (the data channel goes on that offer)
    state(fresh, "connected")
    expect(heals[0][1]).toMatchObject({ trigger: "rejoin_offer", action: "rebuild", healed: true })
    mesh.close()
  })

  it("lets the answerer of the pair re-offer when a new connection answered it", async () => {
    const { mesh, pc } = await setup("b", "a")
    await mesh.onRtc("a", offer(sdp("111")))
    state(pc, "connected")
    await mesh.onRtc("a", answer(sdp("222"))) // an answer to a recovery offer of ours, from a's new connection
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].channels).toHaveLength(1)
    mesh.close()
  })

  it("drops a late description from the connection the peer left, and keeps the fresh one (new, then old, then new)", async () => {
    const { mesh, signals, heals } = await connectedAnswerer()
    await mesh.onRtc("a", offer(sdp("222"))) // new
    expect(FakePC.last).toHaveLength(2)
    signals.length = 0
    await mesh.onRtc("a", offer(sdp("111", { media: ["audio", "video"] }))) // old, delivered late
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1].close).not.toHaveBeenCalled()
    expect(signals).toEqual([])
    await mesh.onRtc("a", offer(sdp("222"))) // new, re-announced
    expect(FakePC.last).toHaveLength(2)
    expect(heals).toEqual([])
    state(FakePC.last[1], "connected")
    expect(heals.map(([, e]) => [e.action, e.healed])).toEqual([["rebuild", true]])
    mesh.close()
  })

  it("keeps the connection for a renegotiation of the same connection, an ICE restart included", async () => {
    const { mesh, pc, signals, heals } = await connectedAnswerer()
    signals.length = 0
    await mesh.onRtc("a", offer(sdp("111", { ufrag: "u2", media: ["audio", "video"] })))
    expect(FakePC.last).toHaveLength(1)
    expect(pc.close).not.toHaveBeenCalled()
    expect(sent(signals)).toEqual(["answer"])
    expect(heals).toEqual([])
    mesh.close()
  })

  it("rebuilds when a connection refuses an offer, answers, then re-offers a replacement channel", async () => {
    const { mesh, pc, signals, heals } = await connectedAnswerer()
    signals.length = 0
    await mesh.onRtc("a", offer("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n")) // no session to tell by
    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    const fresh = FakePC.last[1]
    expect(fresh.channels).toHaveLength(1)
    expect(await fresh.fireDataChannelNegotiationNeeded()).toBe(false)
    expect(sent(signals)).toEqual(["answer", "offer"])
    state(fresh, "connected")
    expect(heals.map(([, e]) => [e.trigger, e.action, e.healed])).toEqual([["rejoin_offer", "rebuild", true]])
    mesh.close()
  })

  it("falls back to an explicit offer when a first-contact offer cannot be applied", async () => {
    const { mesh, signals } = await setup("b", "a")
    mesh.removePeer("a")
    signals.length = 0
    vi.spyOn(FakePC.prototype, "setRemoteDescription").mockRejectedValueOnce(new DOMException("refused", "InvalidAccessError"))

    await mesh.onRtc("a", offer(sdp("111")))

    expect(FakePC.last).toHaveLength(3)
    expect(FakePC.last[2].channels).toHaveLength(1)
    expect(sent(signals)).toEqual(["offer"])
    mesh.close()
  })

  it("falls back to an explicit offer when first contact is a departed session", async () => {
    const { mesh, signals } = await connectedAnswerer()
    await mesh.onRtc("a", offer(sdp("222")))
    mesh.removePeer("a")
    signals.length = 0

    await mesh.onRtc("a", offer(sdp("111")))

    expect(FakePC.last).toHaveLength(4)
    expect(FakePC.last[3].channels).toHaveLength(1)
    expect(sent(signals)).toEqual(["offer"])
    mesh.close()
  })

  it("rebuilds once only when the fresh connection refuses the offer too", async () => {
    const { mesh, signals } = await connectedAnswerer()
    signals.length = 0
    vi.spyOn(FakePC.prototype, "setRemoteDescription").mockRejectedValue(new DOMException("refused", "InvalidAccessError"))
    await mesh.onRtc("a", offer(sdp("111")))
    expect(FakePC.last).toHaveLength(2)
    expect(signals).toEqual([])
    mesh.close()
  })

  it("does not rebuild for a remote description on a connection that has none yet", async () => {
    const { mesh } = await setup("b", "a")
    await mesh.onRtc("a", offer(sdp("111")))
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })
})
