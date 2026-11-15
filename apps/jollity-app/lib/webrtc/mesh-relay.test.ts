// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * RELAY ONLY (path-mode.ts): the network check found this phone's UDP blocked
 * and a TURN relay answering over TCP or TLS, the hotel case. Every link
 * gathers against those relays alone, keeps to them through late TURN, a
 * rebuild and a network change, and sends its description once its relay
 * candidate is in rather than at the 750 ms budget. Driven through the fake
 * RTCPeerConnection of test-pc.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC } from "./test-pc"

const GOOGLE: RTCIceServer = { urls: ["stun:stun.l.google.com:19302"] }
const issued = (urls: string): RTCIceServer => ({ urls, username: "u", credential: "c" })
const TURN_UDP = ["turn:turn.cloudflare.com:3478?transport=udp"].map(issued)
const TURN_TCP = ["turn:turn.cloudflare.com:3478?transport=tcp", "turn:turn.cloudflare.com:80?transport=tcp"].map(issued)
const TURN_TLS = ["turns:turn.cloudflare.com:443?transport=tcp"].map(issued)
const SERVERS = [GOOGLE, issued("stun:stun.cloudflare.com:3478"), ...TURN_UDP, ...TURN_TCP, ...TURN_TLS]

const relay = (port: number) => {
  const line = `candidate:3 1 udp 25108223 104.30.149.195 ${port} typ relay raddr 0.0.0.0 rport 0`
  return { type: "relay", protocol: "udp", address: "104.30.149.195", candidate: line, toJSON: () => ({ candidate: line }) }
}
const offer = { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never
const descs = (signals: unknown[]) => signals.filter((signal) => (signal as { rtc?: { desc?: unknown } }).rtc?.desc)

/** a Mesh for `myId` made on `policy` with one peer added */
async function made(myId: string, peerId: string, { policy = "relay" as RTCIceTransportPolicy, relayProtocols = ["tcp", "tls"] } = {}) {
  vi.resetModules()
  FakePC.last = []
  vi.stubGlobal("RTCPeerConnection", FakePC)
  const { Mesh } = await import("./mesh")
  const signals: unknown[] = []
  const mesh = new Mesh(
    myId,
    { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream,
    { iceServers: SERVERS, iceTransportPolicy: policy },
    (_to, data) => signals.push(data),
    () => {},
    () => {},
    () => {},
    { relayProtocols },
  )
  mesh.addPeer(peerId)
  return { mesh, pc: FakePC.last[0]!, signals }
}

describe("relay only: the servers each link gathers against", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("are the relays that answered alone, with one candidate pooled", async () => {
    const { mesh, pc } = await made("a", "b")
    expect(pc.config).toEqual({ iceServers: [...TURN_TCP, ...TURN_TLS], iceTransportPolicy: "relay", iceCandidatePoolSize: 1 })
    mesh.close()
  })

  it("stay those relays through late TURN, a network change's rebuild and a link made after", async () => {
    const { mesh, pc } = await made("b", "a") // b answers: a network change rebuilds its link
    mesh.setIceServers(SERVERS) // the credentials a network change fetched again
    expect(pc.config?.iceServers).toEqual([...TURN_TCP, ...TURN_TLS])
    expect(pc.config?.iceCandidatePoolSize).toBe(1)
    mesh.networkChanged()
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1]!.config).toEqual({ iceServers: [...TURN_TCP, ...TURN_TLS], iceTransportPolicy: "relay", iceCandidatePoolSize: 1 })
    mesh.addPeer("c")
    expect(FakePC.last[2]!.config?.iceServers).toEqual([...TURN_TCP, ...TURN_TLS])
    mesh.close()
  })

  it("follow a network check that turns relay only, or finds another transport, and leave each link its own pool", async () => {
    const { mesh, pc } = await made("a", "b", { policy: "all" })
    expect(pc.config).toEqual({ iceServers: SERVERS, iceTransportPolicy: "all" })
    mesh.setIcePolicy("relay", ["tls"])
    // a connection that has described itself refuses a new pool size
    // (InvalidModificationError), and with it the servers and the policy
    expect(pc.config).toEqual({ iceServers: TURN_TLS, iceTransportPolicy: "relay", iceCandidatePoolSize: 0 })
    mesh.setIcePolicy("relay", ["tcp"]) // the same policy over another transport is still news
    expect(pc.config?.iceServers).toEqual(TURN_TCP)
    mesh.setIcePolicy("relay", ["tcp"])
    expect(pc.setConfiguration).toHaveBeenCalledTimes(2)
    mesh.addPeer("c")
    expect(FakePC.last[1]!.config).toEqual({ iceServers: TURN_TCP, iceTransportPolicy: "relay", iceCandidatePoolSize: 1 })
    mesh.setIcePolicy("all")
    expect(FakePC.last[1]!.config).toEqual({ iceServers: SERVERS, iceTransportPolicy: "all", iceCandidatePoolSize: 1 })
    mesh.close()
  })
})

describe("relay only: the description waits for its relay candidate", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("an offer goes once the relay is in and its siblings have had a moment, not at 750 ms", async () => {
    const { mesh, pc, signals } = await made("a", "b")
    pc.iceGatheringState = "gathering" // the dead servers that held `complete` are gone, but say it never came
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(120)
    pc.emitCandidate(relay(47556)) // the TCP relay, ~125 ms in on the relay bot
    await vi.advanceTimersByTimeAsync(25)
    pc.emitCandidate(relay(47558)) // its TLS sibling, ~25 ms behind
    await vi.advanceTimersByTimeAsync(24)
    expect(descs(signals)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await negotiating
    expect(descs(signals)).toEqual([{ rtc: { desc: { type: "offer", sdp: "v=0" } } }])
    mesh.close()
  })

  it("an answer waits for its relay the same way", async () => {
    const { mesh, pc, signals } = await made("b", "a")
    pc.iceGatheringState = "gathering"
    const responding = mesh.onRtc("a", offer)
    await vi.advanceTimersByTimeAsync(130)
    pc.emitCandidate(relay(47556))
    await vi.advanceTimersByTimeAsync(49)
    expect(descs(signals)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await responding
    expect(descs(signals)).toEqual([{ rtc: { desc: { type: "answer", sdp: "v=0" } } }])
    mesh.close()
  })

  it("a relay slower than 750 ms (TLS on a hotel network) still rides the description, not a later bundle", async () => {
    const { mesh, pc, signals } = await made("a", "b")
    pc.iceGatheringState = "gathering"
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(1400)
    expect(descs(signals)).toEqual([])
    pc.emitCandidate(relay(47556))
    await vi.advanceTimersByTimeAsync(50)
    await negotiating
    expect(descs(signals)).toHaveLength(1)
    mesh.close()
  })

  it("goes without one at 2.5 s, and the relay trickles after it", async () => {
    const { mesh, pc, signals } = await made("a", "b")
    pc.iceGatheringState = "gathering"
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(2499)
    expect(descs(signals)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await negotiating
    expect(descs(signals)).toHaveLength(1)
    mesh.close()
  })

  it("goes after the moment when the relay is in the description already (a pooled candidate)", async () => {
    const { mesh, pc, signals } = await made("a", "b")
    const original = pc.setLocalDescription.bind(pc)
    pc.setLocalDescription = async (desc) => {
      await original(desc)
      pc.localDescription!.sdp += `\r\na=${relay(47556).candidate}`
    }
    pc.iceGatheringState = "gathering"
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(50)
    await negotiating
    expect(descs(signals)).toHaveLength(1)
    mesh.close()
  })

  it("goes at once when gathering completes first", async () => {
    const { mesh, pc, signals } = await made("a", "b")
    pc.iceGatheringState = "gathering"
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(160)
    pc.iceGatheringState = "complete"
    pc.dispatch("icegatheringstatechange")
    await negotiating
    expect(descs(signals)).toHaveLength(1)
    mesh.close()
  })
})

describe("every other path", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("is unchanged: the whole list, no pool, and the offer at the 750 ms budget whatever it gathered", async () => {
    const { mesh, pc, signals } = await made("a", "b", { policy: "all" })
    expect(pc.config).toEqual({ iceServers: SERVERS, iceTransportPolicy: "all" })
    pc.iceGatheringState = "gathering"
    const negotiating = pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(120)
    pc.emitCandidate(relay(47556))
    await vi.advanceTimersByTimeAsync(629)
    expect(descs(signals)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await negotiating
    expect(descs(signals)).toHaveLength(1)
    mesh.close()
  })
})
