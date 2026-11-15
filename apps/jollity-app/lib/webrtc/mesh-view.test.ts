// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Who sees whom (link-view.ts): the Mesh shares what it sees of the room with
 * every peer, reads theirs, heals the direction only a peer's view can show
 * (it decodes none of our video while ours of theirs is fine), and logs the
 * pairs a relay through this phone could join. Driven through the fake
 * RTCPeerConnection of test-pc.ts, as mesh-heal.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { chromeStats } from "./test-stats"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"
import { decodeViewFrame, encodeView, encodeViewFrame } from "./link-view"
import type { HealEpisodeEvent, HealEvent } from "./heal"

const track = { readyState: "live", enabled: true, muted: false }
const camera = { getVideoTracks: () => [track], getTracks: () => [] }
const ROOM = ["a", "b", "c"]
const row = (codes: Record<string, "-" | "~" | "0" | "1" | "2" | "3">) => encodeView(ROOM, (m) => codes[m]!)

async function room(myId = "a", peerId = "b") {
  const own: string[] = []
  const heals: HealEvent[] = []
  const episodes: HealEpisodeEvent[] = []
  const made = await setupMesh(myId, peerId, { members: ROOM, onOwnView: (r) => own.push(r), onRtcEvent: (_p, { kind, ...e }) => {
    if (kind === "heal") heals.push(e as HealEvent)
    if (kind === "heal_episode") episodes.push(e as HealEpisodeEvent)
  } }, camera)
  return { ...made, own, heals, episodes }
}
const up = (pc: FakePC) => {
  pc.connectionState = "connected"
  pc.onconnectionstatechange!()
}
let decoded = 0
/** one watch sweep, with their frames advancing on every link */
async function sweep(...pcs: FakePC[]) {
  decoded += 30
  for (const pc of pcs) pc.stats = chromeStats({ t: 1000 + decoded, decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
  await vi.advanceTimersByTimeAsync(4000)
}
const tell = (pc: FakePC, r: string) => (pc.channels[0].onmessage as (e: { data: unknown }) => void)({ data: encodeViewFrame(r).buffer })
const laneAnswer = async (pc: FakePC) => {
  const frame = encodeChannelMessage({
    id: USE_CASE_RENEGOTIATION,
    data: encodePeerConnectionSignal({ tag: "Answer", value: sdp("222", { media: ["video"] }) }),
  })
  ;(pc.channels[0].onmessage as (e: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
  await Promise.resolve()
  await Promise.resolve()
}

describe("who sees whom", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    Object.assign(track, { enabled: true, muted: false })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("shares what this phone sees, each sweep, on the open channel and to the caller", async () => {
    const { mesh, pc, own } = await room()
    pc.channels[0].readyState = "open"
    up(pc)
    await sweep(pc)
    await sweep(pc)
    const mine = row({ a: "-", b: "3", c: "0" }) // b's video decodes; c was never heard
    expect(own.at(-1)).toBe(mine)
    const sent = pc.channels[0].send.mock.calls.map(([bytes]) => decodeViewFrame(bytes as Uint8Array)).filter(Boolean)
    expect(sent.at(-1)).toBe(mine)
    mesh.close()
  })

  it("says when its own camera is off, and reads a peer's camera off from that peer's own view", async () => {
    const { mesh, pc, own } = await room()
    pc.channels[0].readyState = "open"
    up(pc)
    track.muted = true // the OS took the camera
    await sweep(pc)
    expect(own.at(-1)).toBe(row({ a: "~", b: "3", c: "0" }))
    expect(mesh.seats().get("b")?.cameraOff).toBe(false)
    tell(pc, row({ a: "3", b: "~", c: "0" }))
    expect(mesh.seats().get("b")?.cameraOff).toBe(true)
    tell(pc, row({ a: "3", b: "-", c: "0" }))
    expect(mesh.seats().get("b")?.cameraOff).toBe(false)
    mesh.close()
  })

  it("is healed by the initiator when the peer says it decodes none of our video, though ours of theirs flows", async () => {
    const { mesh, pc, heals } = await room("a", "b")
    pc.channels[0].readyState = "open"
    up(pc)
    for (let i = 0; i < 5; i++) {
      tell(pc, row({ a: "2", b: "-", c: "0" })) // b: linked to a, no video from a
      await sweep(pc)
    }
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.map((parts) => parts.join(" ")).find((line) => line.includes("unseen:"))).toContain("unseen: signalingState=stable")
    tell(pc, row({ a: "3", b: "-", c: "0" })) // b sees a again
    expect(heals).toEqual([expect.objectContaining({ trigger: "peer_no_video", action: "ice_restart", healed: true, end: "peer_sees" })])
    mesh.close()
  })

  it("never heals a peer that keeps reporting it decodes our video past the link grace period", async () => {
    const { mesh, pc } = await room("a", "b")
    pc.channels[0].readyState = "open"
    up(pc)
    for (let i = 0; i < 8; i++) {
      tell(pc, row({ a: "3", b: "-", c: "0" })) // b keeps decoding a's video
      await sweep(pc)
    }
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("never rebuilds on the peer's word alone, and a round-label flap cannot reset its restart budget", async () => {
    const { mesh, pc } = await room("a", "b")
    mesh.setRound(1)
    pc.channels[0].readyState = "open"
    up(pc)
    for (let i = 0; i < 40; i++) {
      tell(pc, row({ a: "2", b: "-", c: "0" })) // b keeps saying it decodes none of a's video
      await sweep(pc)
    }
    expect(pc.restartIce).toHaveBeenCalledTimes(2)
    expect(FakePC.last).toHaveLength(1) // the same link all along
    mesh.setRound(2)
    mesh.setRound(1)
    for (let i = 0; i < 20; i++) {
      tell(pc, row({ a: "2", b: "-", c: "0" }))
      await sweep(pc)
    }
    expect(pc.restartIce).toHaveBeenCalledTimes(2)
    mesh.close()
  })

  it("uses one separate rebuild when unseen evidence follows a logged negotiation error", async () => {
    const { mesh, pc, heals, episodes } = await room("a", "b")
    mesh.setRound(1)
    pc.channels[0].readyState = "open"
    await pc.onnegotiationneeded!()
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("lane refused", "InvalidAccessError"))
    await laneAnswer(pc)
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))

    const rebuilt = FakePC.last[1]!
    rebuilt.channels[0]!.readyState = "open"
    up(rebuilt)
    expect(heals).toEqual([]) // connected is not proof that the rebuilt video lane works
    for (let i = 0; i < 5 && FakePC.last.length === 2; i++) {
      tell(rebuilt, row({ a: "2", b: "-", c: "0" }))
      await sweep(rebuilt)
    }

    expect(rebuilt.restartIce).not.toHaveBeenCalled()
    expect(FakePC.last).toHaveLength(3)
    expect(heals).toEqual([expect.objectContaining({ trigger: "negotiation_error", action: "rebuild", healed: true, end: "media_flowing" })])
    const unseen = FakePC.last[2]!
    unseen.channels[0]!.readyState = "open"
    up(unseen)
    await sweep(unseen)
    expect(episodes).toContainEqual(expect.objectContaining({
      ladder: "negotiation_error/unseen:rebuild",
      steps: 1,
      healed: true,
      end: "media_flowing",
    }))
    mesh.close()
  })

  it("is left to the initiator by the answerer", async () => {
    const { mesh, pc } = await room("b", "a")
    // the answerer's channel is the initiator's, arriving
    const channel = new FakeChannel()
    channel.readyState = "open"
    pc.channels.push(channel)
    ;(pc.ondatachannel as (e: { channel: FakeChannel }) => void)({ channel })
    up(pc)
    for (let i = 0; i < 5; i++) {
      tell(pc, row({ a: "-", b: "2", c: "0" }))
      await sweep(pc)
    }
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("does not act on a view from another roster, or on a link too young to show video", async () => {
    const { mesh, pc } = await room("a", "b")
    pc.channels[0].readyState = "open"
    up(pc)
    for (let i = 0; i < 5; i++) {
      tell(pc, encodeView(["a", "b", "z"], (m) => (m === "a" ? "2" : m === "b" ? "-" : "0")))
      await sweep(pc)
    }
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.close()
  })

  it("logs a pair that both send us video but have no link to each other: a relay through us would join them", async () => {
    const { mesh, pc } = await room("a", "b")
    mesh.addPeer("c")
    const pcC = FakePC.last[1]
    for (const p of [pc, pcC]) {
      p.channels[0].readyState = "open"
      up(p)
    }
    await sweep(pc, pcC)
    tell(pc, row({ a: "3", b: "-", c: "1" })) // b hears c on the store, no link
    tell(pcC, row({ a: "3", b: "0", c: "-" })) // c never heard b
    await sweep(pc, pcC)
    const lines = vi.mocked(console.log).mock.calls.map((parts) => parts.join(" "))
    expect(lines.filter((l) => l.includes("relay candidate:"))).toEqual(["[jollity-rtc] relay candidate: b and c both send us video, but have no link to each other"])
    mesh.close()
  })
})
