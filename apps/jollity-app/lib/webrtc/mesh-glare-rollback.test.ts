// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A polite side that rolls back its own lane offer on a link that already
 * receives video keeps a receiver that decodes and never presents a frame
 * (libwebrtc, Chromium 153 and WebKit 26.6; game 1331). Such a collision
 * rebuilds the connection instead, once per peer per round; a collision
 * before any video is received still rolls back, which is harmless there. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import type { HealEvent } from "./heal"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

type Mesh = Awaited<ReturnType<typeof setupMesh>>["mesh"]

const offer = (body: string) => ({ rtc: { desc: { type: "offer", sdp: body } } }) as never
const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never
const sent = (signals: unknown[]) => signals.map((s) => (s as { rtc: { desc?: { type: string } } }).rtc.desc?.type ?? "cand")

/** an SDP whose video section says `direction` (the writer's own) */
const withVideoDirection = (body: string, direction: string) => body.replace(/(m=video [^\r\n]*\r\n)/, `$1a=${direction}\r\n`)

const sendLane = (channel: FakeChannel, tag: "Offer" | "Answer", value: string) => {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}

/** hand `pc` an open lane, as the far end's channel arriving */
const openLane = (pc: FakePC) => {
  const channel = new FakeChannel()
  channel.readyState = "open"
  ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
  return channel
}

/** the polite answerer "b" of initiator "a": the statement offer (data channel only) answered, its lane open */
async function politeWithLane() {
  const heals: HealEvent[] = []
  const made = await setupMesh("b", "a", { onRtcEvent: (_peer, { kind, ...event }) => kind === "heal" && heals.push(event as HealEvent) })
  made.mesh.setRound(1)
  await made.mesh.onRtc("a", offer(sdp("111")))
  expect(made.pc.localDescription?.type).toBe("answer")
  return { ...made, channel: openLane(made.pc), heals }
}

/** the initiator's lane offer, carrying `video`, answered */
async function videoNegotiated(pc: FakePC, channel: FakeChannel, video = sdp("111", { media: ["video"] })) {
  sendLane(channel, "Offer", video)
  await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe(video))
  await vi.waitFor(() => expect(pc.signalingState).toBe("stable"))
}

/** this side's own ICE-restart offer goes out on the lane (recovery lets the answerer offer) */
async function ownRestartOffer(mesh: Mesh, pc: FakePC) {
  mesh.networkChanged()
  await pc.onnegotiationneeded!()
  expect(pc.signalingState).toBe("have-local-offer")
}

describe("lane glare on the polite side", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("rebuilds instead of rolling back once it receives video (game 1331), and the fresh link offers", async () => {
    const { mesh, pc, channel, signals } = await politeWithLane()
    await videoNegotiated(pc, channel)
    await ownRestartOffer(mesh, pc)
    const applied = vi.spyOn(pc, "setRemoteDescription")

    // the impolite initiator's own restart offer crosses ours
    sendLane(channel, "Offer", sdp("111", { ufrag: "u2", media: ["video"] }))

    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
    expect(applied).not.toHaveBeenCalled() // never rolled into the old connection
    expect(pc.close).toHaveBeenCalled()
    const fresh = FakePC.last[1]!
    expect(fresh.channelCreations).toHaveLength(1)
    const before = signals.length
    await fresh.onnegotiationneeded!()
    expect(signals.length).toBe(before + 1)
    expect(signals.at(-1)).toMatchObject({ rtc: { desc: { type: "offer" } } })
    mesh.close()
  })

  it("reports a rebuild with no heal open as glare_rebuild, and keeps an open heal's trigger otherwise", async () => {
    const { mesh, pc, channel, heals } = await politeWithLane()
    await videoNegotiated(pc, channel)
    await pc.setLocalDescription() // an offer of ours with no heal behind it
    sendLane(channel, "Offer", sdp("111", { ufrag: "u2", media: ["video"] }))
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
    const fresh = FakePC.last[1]!
    fresh.connectionState = "connected"
    fresh.onconnectionstatechange!()
    expect(heals).toMatchObject([{ trigger: "glare_rebuild", action: "rebuild", healed: true }])
    mesh.close()
  })

  it("rebuilds once per round: the next crossing on the fresh link rolls back", async () => {
    const { mesh, pc, channel } = await politeWithLane()
    await videoNegotiated(pc, channel)
    await ownRestartOffer(mesh, pc)
    sendLane(channel, "Offer", sdp("111", { ufrag: "u2", media: ["video"] }))
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))

    const fresh = FakePC.last[1]!
    await fresh.setLocalDescription()
    await mesh.onRtc("a", answer(sdp("333")))
    const freshLane = openLane(fresh)
    await videoNegotiated(fresh, freshLane, sdp("333", { media: ["video"] }))
    await fresh.setLocalDescription() // our offer again
    sendLane(freshLane, "Offer", sdp("333", { ufrag: "u3", media: ["video"] }))

    await vi.waitFor(() => expect(fresh.localDescription?.type).toBe("answer"))
    expect(FakePC.last).toHaveLength(2)
    expect(fresh.close).not.toHaveBeenCalled()
    mesh.close()
  })

  it("still rolls back and answers when only the data channel is negotiated", async () => {
    const { mesh, pc, channel } = await politeWithLane()
    expect(pc.remoteDescription?.sdp).toBe(sdp("111")) // a real, data-only description
    await ownRestartOffer(mesh, pc)

    sendLane(channel, "Offer", sdp("111", { media: ["video"] }))

    await vi.waitFor(() => expect(pc.localDescription?.type).toBe("answer"))
    expect(FakePC.last).toHaveLength(1)
    expect(pc.close).not.toHaveBeenCalled()
    mesh.close()
  })

  it("still rolls back and answers when the far end sends no video (recvonly)", async () => {
    const { mesh, pc, channel } = await politeWithLane()
    await videoNegotiated(pc, channel, withVideoDirection(sdp("111", { media: ["video"] }), "recvonly"))
    await ownRestartOffer(mesh, pc)

    sendLane(channel, "Offer", withVideoDirection(sdp("111", { ufrag: "u2", media: ["video"] }), "recvonly"))

    await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toContain("a=ice-ufrag:u2"))
    await vi.waitFor(() => expect(pc.localDescription?.type).toBe("answer"))
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })
})

describe("the impolite far end of a glare rebuild", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("takes the rebuilt connection's offer as a new session and answers it as responder", async () => {
    const { mesh, pc, signals } = await setupMesh("a", "b")
    mesh.setRound(1)
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", answer(sdp("111", { media: ["video"] })))
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    pc.signalingState = "have-local-offer" // its own restart offer on the lane, the one the polite side never answers
    signals.length = 0

    await mesh.onRtc("b", offer(sdp("222")))

    expect(FakePC.last).toHaveLength(2)
    const fresh = FakePC.last[1]!
    expect(fresh.channelCreations).toHaveLength(0) // the responder adopts the offerer's channel
    expect(fresh.remoteDescription?.sdp).toBe(sdp("222"))
    expect(sent(signals)).toEqual(["answer"])
    mesh.close()
  })
})

describe("receivesVideo", () => {
  it("reads the far end's video section: a live port and a sending direction", async () => {
    const { receivesVideo } = await import("./mesh")
    const video = sdp("1", { media: ["video"] })
    expect(receivesVideo(undefined)).toBe(false)
    expect(receivesVideo(sdp("1"))).toBe(false)
    expect(receivesVideo(video)).toBe(true) // no attribute: sendrecv
    expect(receivesVideo(withVideoDirection(video, "sendrecv"))).toBe(true)
    expect(receivesVideo(withVideoDirection(video, "sendonly"))).toBe(true)
    expect(receivesVideo(withVideoDirection(video, "recvonly"))).toBe(false)
    expect(receivesVideo(withVideoDirection(video, "inactive"))).toBe(false)
    expect(receivesVideo(video.replace("m=video 9 ", "m=video 0 "))).toBe(false)
    expect(receivesVideo(sdp("1", { media: ["audio"] }))).toBe(false)
  })
})
