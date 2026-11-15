// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { LinkSummary } from "./webrtc/useMesh"
import { clockFace, dotRow, howToPlay, peerDot, SWIPE_MIN_PX, swipeStep, trackArrivals, waitingFooter, waitingPeers, type PeerDot, type WaitingPeer } from "./waiting-room"

describe("peerDot", () => {
  const link = (conn: RTCPeerConnectionState, extra: Partial<LinkSummary> = {}): LinkSummary => ({ id: "p", conn, path: "unknown", standby: false, endpoint: false, ...extra })

  it.each([
    ["linked directly", link("connected", { path: "direct", endpoint: true }), "direct"],
    ["linked through a relay", link("connected", { path: "relay", endpoint: true }), "turn"],
    ["linked through a relay on a standby link", link("connected", { path: "relay", endpoint: true, standby: true }), "turn"],
    ["their endpoint is on the store, the link still forming", link("connecting", { endpoint: true }), "connecting"],
    ["their endpoint is on the store, the link failed", link("failed", { endpoint: true }), "connecting"],
    ["their endpoint is on the store, the link closed", link("closed", { endpoint: true }), "connecting"],
    ["a link is forming with no endpoint from them", link("connecting"), "no-endpoint"],
    ["a new link with no endpoint from them", link("new"), "no-endpoint"],
    ["there is no link at all", undefined, "no-endpoint"],
  ] as const)("when %s", (_, summary, dot) => {
    expect(peerDot(summary)).toBe(dot)
  })
})

describe("waitingPeers", () => {
  const link = (id: string, conn: RTCPeerConnectionState, extra: Partial<LinkSummary> = {}): LinkSummary => ({ id, conn, path: "direct", standby: false, endpoint: true, ...extra })

  it("puts the current round first, then the later rounds, each with its whole group", () => {
    const peers = waitingPeers({ rounds: [["a", "b"], ["b", "c"], ["d"]], links: [] })
    expect(peers.map((peer) => [peer.id, peer.round])).toEqual([["a", 0], ["b", 0], ["b", 1], ["c", 1], ["d", 2]])
  })

  it("gives a co-player met in two rounds the one dot of their one link, in both", () => {
    const peers = waitingPeers({ rounds: [["a", "b"], ["b", "c"]], links: [link("b", "connected")] })
    expect(peers.filter((peer) => peer.id === "b")).toEqual([
      { id: "b", round: 0, dot: "direct" },
      { id: "b", round: 1, dot: "direct" },
    ])
  })

  it("gives each co-player the dot of their link", () => {
    const peers = waitingPeers({
      rounds: [["up", "relayed", "forming", "silent", "none"]],
      links: [link("up", "connected"), link("relayed", "connected", { path: "relay" }), link("forming", "connecting", { path: "unknown" }), link("silent", "new", { path: "unknown", endpoint: false })],
    })
    expect(peers).toEqual([
      { id: "up", round: 0, dot: "direct" },
      { id: "relayed", round: 0, dot: "turn" },
      { id: "forming", round: 0, dot: "connecting" },
      { id: "silent", round: 0, dot: "no-endpoint" },
      { id: "none", round: 0, dot: "no-endpoint" },
    ])
  })
})

describe("trackArrivals", () => {
  const peer = (id: string, dot: PeerDot): WaitingPeer => ({ id, round: 0, dot })

  it("numbers the co-players as they come through, in seat order when together", () => {
    const first = trackArrivals(new Map(), [peer("a", "connecting"), peer("b", "direct"), peer("c", "turn")])
    expect([...first]).toEqual([["b", 1], ["c", 2]])
    const second = trackArrivals(first, [peer("a", "direct"), peer("b", "direct"), peer("c", "turn")])
    expect([...second]).toEqual([["b", 1], ["c", 2], ["a", 3]])
  })

  it("drops a co-player whose link fell back, and gives a later number on the way back", () => {
    const up = trackArrivals(new Map(), [peer("a", "direct"), peer("b", "direct")])
    const dropped = trackArrivals(up, [peer("a", "connecting"), peer("b", "direct")])
    expect([...dropped]).toEqual([["b", 2]])
    expect([...trackArrivals(dropped, [peer("a", "turn"), peer("b", "direct")])]).toEqual([["b", 2], ["a", 3]])
  })

  it("numbers a co-player met in two rounds once", () => {
    const twice = [peer("a", "direct"), { ...peer("a", "direct"), round: 1 }, peer("b", "direct")]
    expect([...trackArrivals(new Map(), twice)]).toEqual([["a", 1], ["b", 2]])
  })

  it("keeps the same map when nothing came or went", () => {
    const map = trackArrivals(new Map(), [peer("a", "direct")])
    expect(trackArrivals(map, [peer("a", "turn"), peer("b", "no-endpoint")])).toBe(map)
  })
})

describe("dotRow", () => {
  const peer = (id: string, round: number, dot: PeerDot): WaitingPeer => ({ id, round, dot })

  it("runs each round's linked first in arrival order, then its rings, then its crosses, each in seat order otherwise", () => {
    const peers = [
      peer("x1", 0, "no-endpoint"),
      peer("r1", 0, "connecting"),
      peer("t1", 0, "turn"),
      peer("x2", 1, "no-endpoint"),
      peer("d1", 1, "direct"),
      peer("r2", 1, "connecting"),
    ]
    const { dots, breaks } = dotRow(peers, new Map([["d1", 1], ["t1", 2]]))
    expect(dots.map((p) => p.id)).toEqual(["t1", "r1", "x1", "d1", "r2", "x2"])
    expect(breaks).toEqual([3])
  })

  it("draws a co-player met in two rounds in both rounds' groups: five and five", () => {
    // round 1: a b c d e; round 2: c d e f g, three of them again
    const round1 = ["a", "b", "c", "d", "e"].map((id) => peer(id, 0, id === "c" ? "direct" : "no-endpoint"))
    const round2 = ["c", "d", "e", "f", "g"].map((id) => peer(id, 1, id === "c" ? "direct" : "no-endpoint"))
    const { dots, breaks } = dotRow([...round1, ...round2], new Map([["c", 1]]))
    expect(dots.map((p) => `${p.round}:${p.id}`)).toEqual(["0:c", "0:a", "0:b", "0:d", "0:e", "1:c", "1:d", "1:e", "1:f", "1:g"])
    expect(breaks).toEqual([5])
  })

  it("puts the linked with no arrival yet after the numbered ones, in seat order", () => {
    const { dots } = dotRow([peer("a", 0, "direct"), peer("b", 0, "direct"), peer("c", 0, "direct")], new Map([["c", 1]]))
    expect(dots.map((p) => p.id)).toEqual(["c", "a", "b"])
  })

  it("breaks the row after each round's count of co-players but the last", () => {
    const peers = [peer("a", 0, "direct"), peer("b", 0, "direct"), peer("c", 1, "direct"), peer("d", 2, "direct"), peer("e", 2, "direct")]
    expect(dotRow(peers, new Map()).breaks).toEqual([2, 3])
    expect(dotRow(peers.slice(0, 2), new Map()).breaks).toEqual([])
  })

  it("has no dots and no breaks with no co-players", () => {
    expect(dotRow([], new Map())).toEqual({ dots: [], breaks: [] })
  })
})

describe("clockFace", () => {
  const kickoffAt = 10_000
  const at = (beforeKickoff: number) => clockFace({ kickoffAt, nowMs: () => 0 }, (kickoffAt - beforeKickoff) * 1000)

  it("counts the digits to the dial's 00", () => {
    expect(at(300)).toEqual({ kind: "digits", text: "4:57" })
    expect(at(64)).toEqual({ kind: "digits", text: "1:01" })
    expect(at(63.5)).toEqual({ kind: "digits", text: "1:01" })
  })

  it("turns the dial for one window, then shows 00 for one second, to the tiles move-in", () => {
    expect(at(63)).toEqual({ kind: "dial", left: 61 })
    expect(at(62.5)).toEqual({ kind: "dial", left: 60.5 })
    expect(at(3)).toEqual({ kind: "dial", left: 1 })
    expect(at(2.5)).toEqual({ kind: "dial", left: 0.5 })
  })

  it("ends as the 00 second ends, when the tiles start to move in", () => {
    expect(at(2)).toEqual({ kind: "ended" })
    expect(at(0)).toEqual({ kind: "ended" })
  })
})

describe("waitingFooter", () => {
  const home = (check: "running" | "pass" | "blocked" | "other") => ({ route: "home" as const, check })
  const LIVE = { storeLive: true, subActive: true, lastError: "" }
  const game = (
    connected: number,
    expected: number,
    network: "checking" | "direct" | "relay" | "blocked" = "direct",
    over: { checking?: boolean; quality?: 1 | 2 | 3 | 4 | null; store?: { storeLive: boolean; subActive: boolean; lastError: string } } = {},
  ) => ({ route: "game" as const, network, connected, expected, quality: over.quality ?? 4, checking: over.checking ?? false, store: "store" in over ? over.store : LIVE })
  const restart = { heading: "Restart the Polkadot app", body: "The app lost the chain.", advice: "restart" as const }
  const words = (footer: ReturnType<typeof waitingFooter>) => [footer.text, footer.detail]

  it("puts a restart first, its body in the tooltip and the chain failing", () => {
    expect(waitingFooter({ restart, unreachable: false, room: game(1, 2) })).toEqual({
      text: "Restart the Polkadot app",
      detail: null,
      info: "The app lost the chain.",
      testId: "chain-restart",
      restartAdvice: "restart",
      network: "direct",
      quality: 4,
      chain: "failing",
    })
  })

  it("puts a restart over an unreachable network", () => {
    expect(waitingFooter({ restart, unreachable: true, room: home("blocked") })).toMatchObject({ text: "Restart the Polkadot app", testId: "chain-restart", network: "blocked" })
  })

  it("says when this phone cannot reach the others, and what to do, with no tooltip", () => {
    expect(waitingFooter({ restart: null, unreachable: true, room: game(3, 5) })).toEqual({
      text: "You can’t reach the other players",
      detail: "Switch to mobile data to join",
      info: null,
      testId: "waiting-network-blocked",
      network: "blocked",
      quality: null,
      chain: "connecting",
    })
  })

  it.each([
    ["running", ["Checking your network…", "Finding the fastest way to reach your players"], "checking"],
    ["pass", ["Waiting for the groups", null], "direct"],
    ["other", ["Waiting for the groups", null], "checking"],
  ] as const)("on the home with the check %s", (check, line, network) => {
    const footer = waitingFooter({ restart: null, unreachable: false, room: home(check) })
    expect(words(footer)).toEqual(line)
    expect(footer).toMatchObject({ network, quality: null, chain: "ok", info: null })
  })

  it.each([
    ["no groups", game(0, 0), ["Waiting for the groups", null]],
    ["the path check runs", game(0, 3, "direct", { checking: true }), ["Checking your network…", "Finding the fastest way to reach your players"]],
    ["the network is not known", game(0, 3, "checking"), ["Checking your network…", "Finding the fastest way to reach your players"]],
    ["some links are up", game(1, 3), ["Connected to 1 of 3", "Connecting to the others…"]],
    ["no link is up after the check", game(0, 3), ["Connected to 0 of 3", "Connecting to the others…"]],
    ["the links are on a relay", game(2, 3, "relay"), ["Connected to 2 of 3", "On a relay: this network blocks direct connection"]],
    ["every link is up", game(3, 3), ["You’re connected to everyone", null]],
  ] as const)("on /game when %s", (_, room, line) => {
    expect(words(waitingFooter({ restart: null, unreachable: false, room }))).toEqual(line)
  })

  it("reads the network and the quality once through, and none while checking", () => {
    expect(waitingFooter({ restart: null, unreachable: false, room: game(2, 3, "relay", { quality: 3 }) })).toMatchObject({ network: "relay", quality: 3 })
    expect(waitingFooter({ restart: null, unreachable: false, room: game(0, 3, "checking", { quality: 4 }) })).toMatchObject({ network: "checking", quality: null })
  })

  it.each([
    ["live", LIVE, "ok"],
    ["not subscribed yet", { storeLive: true, subActive: false, lastError: "" }, "connecting"],
    ["failing to submit", { storeLive: true, subActive: false, lastError: "rejected" }, "failing"],
    ["not read yet", undefined, "connecting"],
  ] as const)("reads the chain from a store %s", (_, store, chain) => {
    expect(waitingFooter({ restart: null, unreachable: false, room: game(1, 3, "direct", { store }) }).chain).toBe(chain)
  })
})

describe("howToPlay", () => {
  it("reads the clock page for another game", () => {
    howToPlay.set(1_000, 1)
    expect(howToPlay.get(1_000)).toBe(1)
    expect(howToPlay.get(2_000)).toBe(-1)
  })

  it("tells its listeners about a change", () => {
    const listener = vi.fn()
    const stop = howToPlay.subscribe(listener)
    howToPlay.set(3_000, 0)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    howToPlay.set(3_000, -1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("swipeStep", () => {
  it("opens the next page on a left swipe and stops at the last step", () => {
    expect(swipeStep(-1, -60, 5)).toBe(0)
    expect(swipeStep(0, -60, 5)).toBe(1)
    expect(swipeStep(1, -60, 5)).toBe(1)
  })

  it("opens the page before on a right swipe and stops at the clock page", () => {
    expect(swipeStep(1, 60, -5)).toBe(0)
    expect(swipeStep(0, 60, -5)).toBe(-1)
    expect(swipeStep(-1, 60, -5)).toBe(-1)
  })

  it("keeps the page on a short or mostly vertical move", () => {
    expect(swipeStep(0, -(SWIPE_MIN_PX - 1), 0)).toBe(0)
    expect(swipeStep(0, SWIPE_MIN_PX - 1, 0)).toBe(0)
    expect(swipeStep(0, -SWIPE_MIN_PX, 0)).toBe(1)
    expect(swipeStep(0, -80, 80)).toBe(0)
    expect(swipeStep(0, 80, -120)).toBe(0)
  })
})
