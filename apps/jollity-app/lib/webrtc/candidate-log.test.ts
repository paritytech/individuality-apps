// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { candidateForLog } from "./candidate-log"

const ADDRESSES = ["203.0.113.7", "61234", "198.51.100.9", "3478", "10.0.0.12", "2001:db8::1", "4f1c2a9e-7d3b-4e5f-9a1b-2c3d4e5f6a7b.local", "9"]

function expectNoAddress(text: string): void {
  for (const value of ADDRESSES) expect(text).not.toContain(value)
}

describe("a candidate in the debug log", () => {
  it("keeps the type, protocol and component of a remote candidate line, and no address or port", () => {
    const text = candidateForLog({ candidate: "candidate:842163049 1 udp 1677729535 203.0.113.7 61234 typ srflx raddr 10.0.0.12 rport 61234 generation 0 ufrag abcd network-cost 999" })
    expect(text).toBe("srflx/udp rtp")
    expectNoAddress(text)
  })

  it("reads a relay candidate's line with the a= prefix and the rtcp component", () => {
    const text = candidateForLog({ candidate: "a=candidate:1 2 UDP 41885439 198.51.100.9 3478 typ relay raddr 203.0.113.7 rport 61234" })
    expect(text).toBe("relay/udp rtcp")
    expectNoAddress(text)
  })

  it("keeps a TCP candidate's tcptype", () => {
    const text = candidateForLog({ candidate: "candidate:2 1 tcp 1518280447 2001:db8::1 9 typ host tcptype passive generation 0" })
    expect(text).toBe("host/tcp rtp tcptype passive")
    expectNoAddress(text)
  })

  it("hides an mDNS host name the same way", () => {
    const text = candidateForLog({ candidate: "candidate:3 1 udp 2122260223 4f1c2a9e-7d3b-4e5f-9a1b-2c3d4e5f6a7b.local 54400 typ host generation 0" })
    expect(text).toBe("host/udp rtp")
    expectNoAddress(text)
  })

  it("prefers a local RTCIceCandidate's own fields and never prints its address", () => {
    const local = {
      candidate: "candidate:842163049 1 udp 1677729535 203.0.113.7 61234 typ srflx raddr 10.0.0.12 rport 61234",
      type: "srflx",
      protocol: "udp",
      component: "rtp",
      address: "203.0.113.7",
      port: 61234,
      relatedAddress: "10.0.0.12",
    }
    const text = candidateForLog(local)
    expect(text).toBe("srflx/udp rtp")
    expectNoAddress(text)
  })

  it("describes a stats report's candidate by its candidateType", () => {
    const text = candidateForLog({ candidateType: "prflx", protocol: "udp" })
    expect(text).toBe("prflx/udp")
  })

  it("says end of candidates for the null or empty candidate", () => {
    expect(candidateForLog(null)).toBe("(end of candidates)")
    expect(candidateForLog({ candidate: "" })).toBe("(end of candidates)")
  })

  it("never echoes a line it cannot parse", () => {
    const text = candidateForLog({ candidate: "garbage 203.0.113.7 61234" })
    expect(text).toBe("?/?")
    expectNoAddress(text)
  })
})
