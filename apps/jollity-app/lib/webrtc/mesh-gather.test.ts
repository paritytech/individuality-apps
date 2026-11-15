// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What each peer connection gathered (#260), driven through the fake
 * RTCPeerConnection of test-pc.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setupMesh } from "./test-pc"
import type { GatherEvent, IceErrorEvent } from "./gather"

async function setup() {
  const gathers: Array<[string, GatherEvent]> = []
  const errors: Array<[string, IceErrorEvent]> = []
  const made = await setupMesh("a", "b", {
    onRtcEvent: (peer, { kind, ...event }) => {
      if (kind === "gather") gathers.push([peer, event as GatherEvent])
      if (kind === "ice_error") errors.push([peer, event as IceErrorEvent])
    },
  })
  return { ...made, gathers, errors }
}
const candidate = (type: string | null, address?: string) => ({
  candidate: {
    type,
    address,
    candidate: address
      ? `candidate:1 1 udp 1 ${address} 5000 typ ${type ?? "host"}`
      : "x",
    toJSON: () => ({}),
  },
})

describe("ICE gathering detail", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("counts the local candidates by type and times the gathering when it completes", async () => {
    const { mesh, pc, gathers } = await setup()
    pc.iceGatheringState = "gathering"
    pc.onicegatheringstatechange!()
    vi.advanceTimersByTime(300)
    for (const type of ["host", "host", "srflx", "relay"]) pc.onicecandidate!(candidate(type))
    vi.advanceTimersByTime(900)
    pc.iceGatheringState = "complete"
    pc.onicegatheringstatechange!()
    expect(gathers).toEqual([["b", { counts: { host: 2, srflx: 1, relay: 1, other: 0 }, ms: 1200, errors: [] }]])
    mesh.close()
  })

  it("ignores the end-of-candidates marker", async () => {
    const { mesh, pc } = await setup()
    pc.onicecandidate!({ candidate: null })
    expect((await mesh.report())[0].gathered?.counts).toEqual({ host: 0, srflx: 0, relay: 0, other: 0 })
    mesh.close()
  })

  it("shows what a gathering that never completed had gathered, in the report", async () => {
    const { mesh, pc, gathers } = await setup()
    pc.iceGatheringState = "gathering"
    pc.onicegatheringstatechange!()
    pc.onicecandidate!(candidate("host"))
    const [row] = await mesh.report()
    expect(row.gathered).toEqual({ counts: { host: 1, srflx: 0, relay: 0, other: 0 }, errors: [] })
    expect(gathers).toEqual([])
    mesh.close()
  })

  it("starts the count afresh when an ICE restart gathers again", async () => {
    const { mesh, pc, gathers } = await setup()
    for (const round of [1, 2]) {
      pc.iceGatheringState = "gathering"
      pc.onicegatheringstatechange!()
      for (let n = 0; n < round; n++) pc.onicecandidate!(candidate("host"))
      pc.iceGatheringState = "complete"
      pc.onicegatheringstatechange!()
    }
    expect(gathers.map(([, event]) => event.counts.host)).toEqual([1, 2])
    mesh.close()
  })

  it("reports each completed gathering's local address set", async () => {
    const addresses: Array<[string, readonly string[]]> = []
    const { mesh, pc } = await setupMesh("a", "b", {
      onLocalAddresses: (peer, found) => addresses.push([peer, found]),
    })
    for (const found of [["10.0.0.4", "fd00::4"], ["192.168.1.9"]]) {
      pc.iceGatheringState = "gathering"
      pc.onicegatheringstatechange!()
      for (const address of found) pc.onicecandidate!(candidate("host", address))
      pc.onicecandidate!(candidate("host", "randomized.local"))
      pc.onicecandidate!(candidate("srflx", "203.0.113.4"))
      pc.iceGatheringState = "complete"
      pc.onicegatheringstatechange!()
    }
    expect(addresses).toEqual([
      // IPv6 privacy addresses rotate independently of the physical path and
      // must not manufacture a network-change retry.
      ["b", ["10.0.0.4"]],
      ["b", ["192.168.1.9"]],
    ])
    mesh.close()
  })

  it("reports a candidate error as its code and the server's host, never the url", async () => {
    const { mesh, pc, errors } = await setup()
    pc.onicecandidateerror!({ errorCode: 701, url: "turn:user:pw@turn.example.org:3478?transport=udp", errorText: "Address not reachable" })
    pc.onicecandidateerror!({})
    expect(errors).toEqual([
      ["b", { code: "701", host: "turn.example.org" }],
      ["b", { code: "unsupported", host: "unsupported" }],
    ])
    mesh.close()
  })

  it("tallies a gathering's errors by code and host, and hands the tally over with the gathering", async () => {
    const { mesh, pc, gathers } = await setup()
    pc.iceGatheringState = "gathering"
    pc.onicegatheringstatechange!()
    for (const url of ["turn:t1.example.org:3478", "turn:t1.example.org:3478?transport=tcp", "turn:t2.example.org:3478"])
      pc.onicecandidateerror!({ errorCode: 701, url })
    pc.iceGatheringState = "complete"
    pc.onicegatheringstatechange!()
    expect(gathers[0][1].errors).toEqual([
      { code: "701", host: "t1.example.org", n: 2 },
      { code: "701", host: "t2.example.org", n: 1 },
    ])
    mesh.close()
  })

  it("starts the error tally afresh with a new gathering", async () => {
    const { mesh, pc } = await setup()
    pc.onicecandidateerror!({ errorCode: 701, url: "turn:t1.example.org" })
    pc.iceGatheringState = "gathering"
    pc.onicegatheringstatechange!()
    expect((await mesh.report())[0].gathered?.errors).toEqual([])
    mesh.close()
  })

  it("keeps the mesh going when an observer throws", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {
      onRtcEvent: () => {
        throw new Error("boom")
      },
    })
    pc.iceGatheringState = "gathering"
    pc.onicegatheringstatechange!()
    expect(() => {
      pc.iceGatheringState = "complete"
      pc.onicegatheringstatechange!()
      pc.onicecandidateerror!({ errorCode: 701 })
    }).not.toThrow()
    mesh.close()
  })
})
