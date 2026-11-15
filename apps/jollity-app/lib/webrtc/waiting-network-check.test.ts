// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { HOST_ONLY_GATHER_DWELL_MS } from "./path-health"
import {
  runWaitingNetworkCheck,
  retainWaitingNetworkDecision,
  WAITING_NETWORK_CHECK_TIMEOUT_MS,
  waitingNetworkAllowsHandover,
  waitingNetworkRestartNotice,
  WEBRTC_RESTART_NOTICE,
  ZERO_CALLBACK_OBSERVATION_MS,
  type WaitingNetworkCheckResult,
} from "./waiting-network-check"

const ICE: RTCIceServer[] = [
  { urls: "stun:stun.example:3478" },
  { urls: "turn:relay.example:3478", username: "u", credential: "p" },
]
const MULTI_TURN_ICE: RTCIceServer[] = [
  { urls: "stun:stun.example:3478" },
  { urls: ["turn:relay.example:3478?transport=udp", "turns:relay.example:5349?transport=tcp"], username: "u", credential: "p" },
]

class CheckPc {
  iceGatheringState: RTCIceGatheringState = "gathering"
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  onicecandidateerror: ((event: RTCPeerConnectionIceErrorEvent) => void) | null = null
  onicegatheringstatechange: ((event: Event) => void) | null = null
  close = vi.fn()
  createDataChannel = vi.fn(() => ({} as RTCDataChannel))
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "v=0" }) as RTCSessionDescriptionInit)
  constructor(private readonly script: (pc: CheckPc) => void) {}
  async setLocalDescription() { this.script(this) }
  candidate(type: RTCIceCandidateType) {
    this.onicecandidate?.({ candidate: { type, candidate: `candidate:1 1 udp 1 10.0.0.1 1 typ ${type}` } } as RTCPeerConnectionIceEvent)
  }
  unreachable(url = "turn:relay.example:3478") {
    this.onicecandidateerror?.({ errorCode: 701, url } as RTCPeerConnectionIceErrorEvent)
  }
  complete() {
    this.iceGatheringState = "complete"
    this.onicegatheringstatechange?.(new Event("icegatheringstatechange"))
  }
  end() {
    this.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent)
  }
}

class DeferredDescriptionPc extends CheckPc {
  private release!: () => void
  private readonly installed = new Promise<void>((resolve) => { this.release = resolve })
  override async setLocalDescription() {
    await this.installed
    return super.setLocalDescription()
  }
  install() { this.release() }
}

afterEach(() => vi.useRealTimers())

describe("waiting-room peerless network check", () => {
  it("passes a normal gather without waiting for the host-only dwell", async () => {
    const pc = new CheckPc((self) => { self.candidate("host"); self.candidate("srflx") })
    const result = await runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => pc })
    expect(result).toMatchObject({ result: "pass", counts: { host: 1, srflx: 1, relay: 0 } })
    expect(pc.close).toHaveBeenCalledOnce()
  })

  it("reuses the live mesh dwell before blaming an in-progress host-only gather", async () => {
    vi.useFakeTimers()
    let clock = 0
    const pc = new CheckPc((self) => { self.candidate("host"); self.unreachable() })
    const pending = runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => pc, now: () => clock })
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(HOST_ONLY_GATHER_DWELL_MS - 1)
    expect(settled).toBe(false)
    clock = HOST_ONLY_GATHER_DWELL_MS
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ result: "blocked", relayUnreachable: true })
  })

  it("treats completed host-only gathering as conclusive relay failure", async () => {
    const pc = new CheckPc((self) => { self.candidate("host"); self.complete() })
    await expect(runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => pc }))
      .resolves.toMatchObject({ result: "blocked", reason: "complete", relayUnreachable: true })
  })

  it("treats timed-out host-only gathering as conclusive relay failure", async () => {
    vi.useFakeTimers()
    const pc = new CheckPc((self) => { self.candidate("host") })
    const pending = runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => pc })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ result: "blocked", reason: "timeout", relayUnreachable: true })
  })

  it("does not warn when UDP TURN fails before a slower TLS relay succeeds", async () => {
    vi.useFakeTimers()
    const pc = new CheckPc((self) => {
      self.candidate("host")
      self.unreachable("turn:relay.example:3478?transport=udp")
      setTimeout(() => self.candidate("relay"), 2_000)
    })
    const pending = runWaitingNetworkCheck({ iceServers: MULTI_TURN_ICE, createPeerConnection: () => pc })
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ result: "pass", counts: { relay: 1 }, relayUnreachable: false })
  })

  it("accepts relay-unreachable proof delivered just after gathering completes", async () => {
    const pc = new CheckPc((self) => {
      self.candidate("host")
      self.complete()
      self.unreachable()
    })
    await expect(runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => pc }))
      .resolves.toMatchObject({ result: "blocked", reason: "complete", relayUnreachable: true })
  })

  it("never opens a connection when no TURN credentials are configured", async () => {
    const make = vi.fn()
    await expect(runWaitingNetworkCheck({ iceServers: [ICE[0]], createPeerConnection: make }))
      .resolves.toMatchObject({ result: "inconclusive", reason: "no-turn" })
    expect(make).not.toHaveBeenCalled()
  })

  it("starts the zero-callback window only after local-description installation", async () => {
    vi.useFakeTimers()
    const first = new DeferredDescriptionPc(() => {})
    const made = [first]
    const pending = runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => made.shift()! })
    let settled = false
    void pending.then(() => { settled = true })

    await vi.advanceTimersByTimeAsync(ZERO_CALLBACK_OBSERVATION_MS)
    expect(settled).toBe(false)
    expect(made).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(WAITING_NETWORK_CHECK_TIMEOUT_MS - ZERO_CALLBACK_OBSERVATION_MS)
    await expect(pending).resolves.toMatchObject({ result: "inconclusive", reason: "error", attempts: 1 })
  })

  it("requires two fresh post-local-description zero-callback stalls", async () => {
    vi.useFakeTimers()
    const peers = [new CheckPc(() => {}), new CheckPc(() => {})]
    const pending = runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => peers.shift()! })

    await vi.advanceTimersByTimeAsync(ZERO_CALLBACK_OBSERVATION_MS)
    let settled = false
    void pending.then(() => { settled = true })
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(ZERO_CALLBACK_OBSERVATION_MS)

    await expect(pending).resolves.toMatchObject({ result: "runtime-stalled", reason: "zero-callback", attempts: 2 })
  })

  it("does not confirm a single stalled probe when the fresh probe gathers", async () => {
    vi.useFakeTimers()
    const peers = [new CheckPc(() => {}), new CheckPc((self) => self.candidate("srflx"))]
    const pending = runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => peers.shift()! })

    await vi.advanceTimersByTimeAsync(ZERO_CALLBACK_OBSERVATION_MS)
    await expect(pending).resolves.toMatchObject({ result: "pass", attempts: 2, counts: { srflx: 1 } })
  })

  it("shows restart copy only for the twice-confirmed exact stall", () => {
    expect(waitingNetworkRestartNotice("runtime-stalled")).toBe(WEBRTC_RESTART_NOTICE)
    for (const result of ["pass", "blocked", "inconclusive", "unsupported", "cancelled"] satisfies WaitingNetworkCheckResult[])
      expect(waitingNetworkRestartNotice(result)).toBeNull()
  })

  it("retains a confirmed stall for the same game through reruns and kickoff", () => {
    const confirmed: { gameAt: number; result: WaitingNetworkCheckResult } = {
      gameAt: 1_800_000_000,
      result: "runtime-stalled",
    }
    expect(retainWaitingNetworkDecision(confirmed, { ...confirmed, result: "pass" })).toBe(confirmed)
    expect(waitingNetworkAllowsHandover({ inWaiting: false, done: true, result: confirmed.result })).toBe(false)
    expect(waitingNetworkRestartNotice(confirmed.result)).toBe(WEBRTC_RESTART_NOTICE)
  })

  it("allows a healthy late join without requiring a waiting-room probe", () => {
    expect(waitingNetworkAllowsHandover({ inWaiting: false, done: false, result: "inconclusive" })).toBe(true)
  })

  it.each([
    ["end marker", (pc: CheckPc) => pc.end()],
    ["gathering completion", (pc: CheckPc) => pc.complete()],
    ["candidate error", (pc: CheckPc) => pc.unreachable()],
  ])("does not call a %s an exact zero-callback stall", async (_label, callback) => {
    vi.useFakeTimers()
    const pc = new CheckPc(callback)
    const pending = runWaitingNetworkCheck({ iceServers: ICE, createPeerConnection: () => pc })
    await vi.advanceTimersByTimeAsync(WAITING_NETWORK_CHECK_TIMEOUT_MS)
    await expect(pending).resolves.not.toMatchObject({ result: "runtime-stalled" })
  })
})
