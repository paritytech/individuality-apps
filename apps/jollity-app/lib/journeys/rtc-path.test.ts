// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest"
import { resolvedRelay, type RtcSample } from "../webrtc/rtc-stats"
import { resetPaths, trackPaths } from "./rtc-path"

const sample = (over: Partial<RtcSample> = {}): RtcSample => ({
  link: 1,
  localType: "relay",
  remoteType: "srflx",
  protocol: "udp",
  relayProtocol: "tls",
  networkType: "cellular",
  ...over,
})
const row = (id: string, quality?: RtcSample) => ({ id, quality })
const host = { localType: "host", remoteType: "host", relayProtocol: undefined }

beforeEach(() => resetPaths())

describe("the selected path", () => {
  it("is a step's attributes and a log line the link script reads", () => {
    const [event] = trackPaths([row("5Amy", sample())])
    expect(event.attrs).toEqual({
      "rtc.path": "relay",
      "rtc.local_type": "relay",
      "rtc.remote_type": "srflx",
      "rtc.protocol": "udp",
      "rtc.relay_protocol": "tls",
      "rtc.relay_protocol_source": "stats",
      "rtc.turn_host": "unsupported",
      "rtc.network": "cellular",
    })
    // the relay protocol is the one that matters on a relay, so the line carries it
    expect(event.line).toBe("[jollity-rtc] path 5Amy relay/srflx tls")
    expect(trackPaths([row("5Bob", sample(host))])[0].line).toBe("[jollity-rtc] path 5Bob host/host udp")
  })

  it("has none until both candidate types are known", () => {
    expect(trackPaths([row("a", undefined), row("b", { link: 1, localType: "host" })])).toEqual([])
  })

  it("says unsupported for what the browser did not report, and remote when only the far end relays", () => {
    const [bare] = trackPaths([row("a", sample({ protocol: undefined, relayProtocol: undefined, networkType: undefined }))])
    expect(bare.attrs).toMatchObject({ "rtc.protocol": "unsupported", "rtc.relay_protocol": "unsupported", "rtc.network": "unsupported" })
    expect(bare.line).toBe("[jollity-rtc] path a relay/srflx unsupported")
    const [far] = trackPaths([row("b", sample({ localType: "host", remoteType: "relay", relayProtocol: undefined }))])
    expect(far.attrs["rtc.relay_protocol"]).toBe("remote")
    const [direct] = trackPaths([row("c", sample(host))])
    expect(direct.attrs["rtc.relay_protocol"]).toBeUndefined()
    expect(direct.attrs["rtc.relay_protocol_source"]).toBeUndefined()
    expect(direct.attrs["rtc.turn_host"]).toBeUndefined()
    expect(far.attrs["rtc.relay_protocol_source"]).toBeUndefined()
  })

  it("reads a relay's protocol off its TURN url when the browser reports none (WebKit)", () => {
    const iphone = sample({ relayProtocol: undefined, relayTransport: "tcp", relayHost: "turn.cloudflare.com", relayEndpoint: "turn:turn.cloudflare.com:3478?transport=tcp" })
    const [event] = trackPaths([row("a", iphone)])
    expect(event.attrs).toMatchObject({ "rtc.relay_protocol": "tcp", "rtc.relay_protocol_source": "url", "rtc.turn_host": "turn.cloudflare.com" })
    expect(event.line).toBe("[jollity-rtc] path a relay/srflx tcp")
    // the browser's own relayProtocol wins over the url when both are there
    const [both] = trackPaths([row("b", sample({ relayProtocol: "tls", relayTransport: "tcp" }))])
    expect(both.attrs).toMatchObject({ "rtc.relay_protocol": "tls", "rtc.relay_protocol_source": "stats" })
    const [neither] = trackPaths([row("c", sample({ relayProtocol: undefined }))])
    expect(neither.attrs).toMatchObject({ "rtc.relay_protocol": "unsupported", "rtc.relay_protocol_source": "unsupported" })
  })

  it("counts a relay protocol learnt from the url as the path's own, not a change on every report", () => {
    const iphone = sample({ relayProtocol: undefined, relayTransport: "udp" })
    trackPaths([row("a", iphone)])
    expect(trackPaths([row("a", iphone)])).toEqual([])
    expect(trackPaths([row("a", { ...iphone, relayTransport: "tcp" })])).toEqual([expect.objectContaining({ change: true })])
  })
})

describe("resolvedRelay", () => {
  it("prefers the browser's relayProtocol, then the url's transport, then unsupported", () => {
    expect(resolvedRelay({ relayProtocol: "tls", relayTransport: "tcp" })).toEqual({ protocol: "tls", source: "stats" })
    expect(resolvedRelay({ relayTransport: "tcp" })).toEqual({ protocol: "tcp", source: "url" })
    expect(resolvedRelay({})).toEqual({ protocol: "unsupported", source: "unsupported" })
  })
})

describe("watching the selected path", () => {
  it("reports the first path of a peer as set, and the same path again as nothing", () => {
    expect(trackPaths([row("a", sample())])).toEqual([expect.objectContaining({ id: "a", change: false })])
    expect(trackPaths([row("a", sample())])).toEqual([])
  })

  it("reports a different path as a change", () => {
    trackPaths([row("a", sample())])
    expect(trackPaths([row("a", sample(host))])).toEqual([expect.objectContaining({ id: "a", change: true })])
  })

  it("is not fooled by a rebuilt connection that lands on the same path", () => {
    trackPaths([row("a", sample({ link: 1 }))])
    expect(trackPaths([row("a", sample({ link: 2 }))])).toEqual([])
  })

  it("keeps the last path through a report with no pair, so a gap is not a change", () => {
    trackPaths([row("a", sample())])
    expect(trackPaths([row("a", { link: 1 })])).toEqual([])
    expect(trackPaths([row("a", sample())])).toEqual([])
  })

  it("follows each peer on its own", () => {
    expect(trackPaths([row("a", sample()), row("b", sample(host))]).map((event) => event.id)).toEqual(["a", "b"])
  })

  it("hands back one shared empty list on a quiet report", () => {
    trackPaths([row("a", sample())])
    expect(trackPaths([row("a", sample())])).toBe(trackPaths([row("a", sample())]))
  })
})
