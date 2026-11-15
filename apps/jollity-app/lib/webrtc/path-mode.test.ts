// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { classifyPath, iceConfigFor, icePolicyFor, lastPathProbe, parseCandidate, probePath, turnTransport, type ProbeCandidate } from "./path-mode"

const opts = { turnConfigured: true, gatherMs: 900, at: 1 }
const line = (s: string) => parseCandidate({ candidate: s })!

describe("the path this phone can take", () => {
  it("reads a candidate line's type, public address and the address it maps", () => {
    expect(line("candidate:1 1 udp 1686052607 203.0.113.7 40001 typ srflx raddr 192.168.1.5 rport 50000 generation 0")).toEqual({
      type: "srflx",
      address: "203.0.113.7",
      port: 40001,
      relatedAddress: "192.168.1.5",
      relatedPort: 50000,
      relayProtocol: undefined,
    })
  })

  it("is direct when STUN gave a public address", () => {
    const probe = classifyPath([line("candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host"), line("candidate:2 1 udp 1686052607 203.0.113.7 40001 typ srflx raddr 192.168.1.5 rport 50000")], opts)
    expect(probe).toMatchObject({ mode: "direct", udp: true })
    expect(icePolicyFor(probe)).toBe("all")
  })

  it("is relay when UDP is blocked but a relay answered over TCP or TLS: the hotel", () => {
    const relay: ProbeCandidate = { ...line("candidate:3 1 udp 41885439 104.30.149.195 47556 typ relay raddr 0.0.0.0 rport 0"), relayProtocol: "tls" }
    const probe = classifyPath([line("candidate:1 1 udp 2122260223 10.68.29.143 50000 typ host"), relay], opts)
    expect(probe).toMatchObject({ mode: "relay", udp: false, relayProtocols: ["tls"], nat: "unknown" })
    expect(icePolicyFor(probe)).toBe("relay")
  })

  it("is blocked with local addresses only and no relay (game 248)", () => {
    expect(classifyPath([line("candidate:1 1 udp 2122260223 10.68.29.143 50000 typ host")], opts).mode).toBe("blocked")
    // with no TURN to ask, a host-only gathering proves nothing
    expect(classifyPath([line("candidate:1 1 udp 2122260223 10.68.29.143 50000 typ host")], { ...opts, turnConfigured: false }).mode).toBe("unknown")
  })

  it("sees a symmetric NAT: one socket, a different public port for each server", () => {
    const probe = classifyPath(
      [
        line("candidate:2 1 udp 1686052607 203.0.113.7 40001 typ srflx raddr 192.168.1.5 rport 50000"),
        line("candidate:4 1 udp 1686052607 203.0.113.7 40777 typ srflx raddr 192.168.1.5 rport 50000"),
      ],
      opts,
    )
    expect(probe.nat).toBe("symmetric")
  })

  it("sees a cone NAT: the TURN server saw the same public port STUN did", () => {
    const probe = classifyPath(
      [
        line("candidate:2 1 udp 1686052607 203.0.113.7 40001 typ srflx raddr 192.168.1.5 rport 50000"),
        { ...line("candidate:3 1 udp 41885439 104.30.149.195 47556 typ relay raddr 203.0.113.7 rport 40001"), relayProtocol: "udp" },
      ],
      opts,
    )
    expect(probe.nat).toBe("cone")
  })

  it("probes once, keeps the result for the page, and closes its connection", async () => {
    let closed = false
    let onCandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
    const probe = await probePath({
      iceServers: [{ urls: "turns:turn.example:443?transport=tcp", username: "u", credential: "c" }],
      createPeerConnection: () => ({
        iceGatheringState: "new",
        set onicecandidate(handler: ((event: RTCPeerConnectionIceEvent) => void) | null) {
          onCandidate = handler
        },
        get onicecandidate() {
          return onCandidate
        },
        createDataChannel: () => ({}),
        createOffer: async () => {
          setTimeout(() => {
            onCandidate?.({ candidate: { candidate: "candidate:3 1 udp 41885439 104.30.149.195 47556 typ relay raddr 0.0.0.0 rport 0", relayProtocol: "tcp" } } as unknown as RTCPeerConnectionIceEvent)
            onCandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent)
          }, 0)
          return { type: "offer", sdp: "" }
        },
        setLocalDescription: async () => {},
        close: () => {
          closed = true
        },
      }),
    })
    expect(probe).toMatchObject({ mode: "relay", relayProtocols: ["tcp"] })
    expect(lastPathProbe()).toBe(probe)
    expect(closed).toBe(true)
  })
})

// what a link is handed: the Google STUN list (ice.ts) and the eight servers
// the issuer gives ("8 TURN servers configured"), Cloudflare's: two STUN, and
// TURN over UDP, TCP and TLS on two ports each
const GOOGLE: RTCIceServer = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }
const issued = (urls: string): RTCIceServer => ({ urls, username: "u", credential: "c" })
const STUN_CF = ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"].map(issued)
const TURN_UDP = ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"].map(issued)
const TURN_TCP = ["turn:turn.cloudflare.com:3478?transport=tcp", "turn:turn.cloudflare.com:80?transport=tcp"].map(issued)
const TURN_TLS = ["turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"].map(issued)
const SERVERS = [GOOGLE, ...STUN_CF, ...TURN_UDP, ...TURN_TCP, ...TURN_TLS]

describe("the servers a link gathers against on its path", () => {
  it("reads a TURN url's transport the way a relay candidate names it", () => {
    expect(turnTransport("turn:turn.example:3478?transport=udp")).toBe("udp")
    expect(turnTransport("turn:turn.example:3478")).toBe("udp")
    expect(turnTransport("turn:turn.example:80?transport=tcp")).toBe("tcp")
    expect(turnTransport("turns:turn.example:443?transport=tcp")).toBe("tls")
    expect(turnTransport("turns:turn.example:5349")).toBe("tls")
    expect(turnTransport("stun:stun.example:3478")).toBeNull()
  })

  it("on relay only, is the relays that answered alone: no STUN, no UDP TURN (the hotel)", () => {
    const config = iceConfigFor({ iceServers: SERVERS, iceTransportPolicy: "relay" }, ["tcp", "tls"])
    expect(config.iceServers).toEqual([...TURN_TCP, ...TURN_TLS])
    expect(config.iceTransportPolicy).toBe("relay")
  })

  it("keeps only the transport that answered when the other did not", () => {
    expect(iceConfigFor({ iceServers: SERVERS, iceTransportPolicy: "relay" }, ["tls"]).iceServers).toEqual(TURN_TLS)
    expect(iceConfigFor({ iceServers: SERVERS, iceTransportPolicy: "relay" }, ["udp"]).iceServers).toEqual(TURN_UDP)
  })

  it("filters inside a server that lists several urls under one credential", () => {
    const shared = { urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" }
    expect(iceConfigFor({ iceServers: [GOOGLE, shared], iceTransportPolicy: "relay" }, ["tls"]).iceServers).toEqual([{ ...shared, urls: ["turns:turn.cloudflare.com:443?transport=tcp"] }])
  })

  it("keeps every relay, still without STUN, when it cannot tell which transport answered", () => {
    const relays = [...TURN_UDP, ...TURN_TCP, ...TURN_TLS]
    expect(iceConfigFor({ iceServers: SERVERS, iceTransportPolicy: "relay" }, ["unknown"]).iceServers).toEqual(relays)
    expect(iceConfigFor({ iceServers: SERVERS, iceTransportPolicy: "relay" }, []).iceServers).toEqual(relays)
    // relays renewed onto other transports than the probe saw: all of them, never none
    expect(iceConfigFor({ iceServers: [GOOGLE, ...TURN_TLS], iceTransportPolicy: "relay" }, ["tcp"]).iceServers).toEqual(TURN_TLS)
  })

  it("on relay only, pools one candidate, so the relay is allocated when the connection is made", () => {
    expect(iceConfigFor({ iceServers: SERVERS, iceTransportPolicy: "relay" }, ["tcp"]).iceCandidatePoolSize).toBe(1)
  })

  it("leaves every other path as it is: direct, blocked and unknown take the whole list, unpooled", () => {
    for (const config of [{ iceServers: SERVERS }, { iceServers: SERVERS, iceTransportPolicy: "all" as const }]) {
      expect(iceConfigFor(config, ["tcp", "tls"])).toEqual(config)
    }
  })

  it("leaves a STUN-only list alone: with no relay to keep there is nothing to trim", () => {
    expect(iceConfigFor({ iceServers: [GOOGLE], iceTransportPolicy: "relay" }, ["tls"]).iceServers).toEqual([GOOGLE])
  })
})
