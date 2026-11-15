// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { candidateType, countCandidate, emptyCounts, GatherTracker, gatheredAttr, iceErrorInfo, urlHost } from "./gather"

describe("candidateType", () => {
  it("reads the type the browser reports", () => {
    expect(candidateType({ type: "host" })).toBe("host")
    expect(candidateType({ type: "srflx" })).toBe("srflx")
    expect(candidateType({ type: "relay" })).toBe("relay")
  })
  it("falls back to the typ of the candidate line where the browser reports no type", () => {
    expect(candidateType({ candidate: "candidate:1 1 udp 2113937151 10.0.0.2 5000 typ srflx raddr 0.0.0.0 rport 0" })).toBe("srflx")
  })
  it("classifies Chromium's obfuscated mDNS candidate as host", () => {
    expect(candidateType({ candidate: "candidate:2 1 udp 2113937151 browser-id.local 5000 typ host generation 0" })).toBe("host")
  })
  it("counts a peer-reflexive or unreadable candidate as other, never as nothing", () => {
    expect(candidateType({ type: "prflx" })).toBe("other")
    expect(candidateType({})).toBe("other")
  })
})

describe("countCandidate", () => {
  it("adds one to the type's count", () => {
    const counts = emptyCounts()
    countCandidate(counts, { type: "host" })
    countCandidate(counts, { type: "host" })
    countCandidate(counts, { type: "relay" })
    expect(counts).toEqual({ host: 2, srflx: 0, relay: 1, other: 0 })
  })
})

describe("gatheredAttr", () => {
  it("reads host/srflx/relay as one short text, so a pair with no relay shows 0", () => {
    expect(gatheredAttr({ host: 2, srflx: 1, relay: 0, other: 0 })).toBe("2/1/0")
  })
})

describe("urlHost", () => {
  it.each([
    ["stun:stun.l.google.com:19302", "stun.l.google.com"],
    ["turn:turn.example.org:3478?transport=udp", "turn.example.org"],
    ["turns:turn.example.org:443?transport=tcp", "turn.example.org"],
    ["turn:[2001:db8::1]:3478", "[2001:db8::1]"],
    ["turn:10.1.2.3", "10.1.2.3"],
  ])("%s is %s", (url, host) => expect(urlHost(url)).toBe(host))

  it("never carries a credential, whatever the url holds", () => {
    expect(urlHost("turn:someone:s3cret@turn.example.org:3478")).toBe("turn.example.org")
    expect(urlHost("turn:someone:s3cret@turn.example.org:3478?transport=udp&password=x")).not.toMatch(/someone|s3cret|password/)
  })
  it("says unsupported for an empty or unreadable url", () => {
    expect(urlHost(undefined)).toBe("unsupported")
    expect(urlHost("")).toBe("unsupported")
    expect(urlHost("not a url")).toBe("unsupported")
  })
})

describe("iceErrorInfo", () => {
  it("is the error code and the server's host alone", () => {
    expect(iceErrorInfo({ errorCode: 701, url: "turn:turn.example.org:3478?transport=udp", errorText: "Address not reachable" })).toEqual({
      code: "701",
      host: "turn.example.org",
    })
  })
  it("says unsupported for what the browser did not report", () => {
    expect(iceErrorInfo({})).toEqual({ code: "unsupported", host: "unsupported" })
  })
})

describe("GatherTracker", () => {
  it("counts candidates and the time from a restart to complete, once", () => {
    const gather = new GatherTracker()
    gather.restart(1000)
    gather.add({ type: "host" })
    gather.add({ type: "relay" })
    expect(gather.snapshot()).toEqual({ counts: { host: 1, srflx: 0, relay: 1, other: 0 }, errors: [] })
    expect(gather.complete(1900)).toEqual({ counts: { host: 1, srflx: 0, relay: 1, other: 0 }, ms: 900, errors: [] })
    expect(gather.complete(2500)).toBeNull()
    expect(gather.snapshot().ms).toBe(900)
  })

  it("starts itself on a candidate or a complete when no gathering state came first", () => {
    const gather = new GatherTracker()
    gather.startIfIdle(100)
    gather.startIfIdle(500) // already started: the first start stands
    expect(gather.complete(700)?.ms).toBe(600)
    expect(new GatherTracker().complete(50)?.ms).toBe(0)
  })

  it("tallies errors by code and host, and a restart clears them", () => {
    const gather = new GatherTracker()
    gather.addError({ code: "701", host: "t" })
    gather.addError({ code: "701", host: "t" })
    gather.addError({ code: "401", host: "t" })
    expect(gather.snapshot().errors).toEqual([
      { code: "701", host: "t", n: 2 },
      { code: "401", host: "t", n: 1 },
    ])
    gather.restart(0)
    expect(gather.snapshot().errors).toEqual([])
  })
})
