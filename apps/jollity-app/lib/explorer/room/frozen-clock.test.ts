// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { roomBfs } from "./bfs"
import { roomAnchor, steadyAnchor } from "./checks"
import { fullRoomKey } from "./key"
import { candidateLabels, initialRoom, localNow, step, walkRoom, type Room } from "./model"

/**
 * The frozen page clock (model.ts, ROOM_FROZEN) is off by default, and off it
 * changes nothing: a tiled path is a label's position in candidateLabels, and
 * a resumed run replays its anchor, so the labels, the anchors, their keys and
 * a short search are pinned here at values taken before the frozen clock.
 */
const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

describe("the room with the frozen page clock off", () => {
  it("keeps labels, anchors, keys and a short search byte-identical", () => {
    const labels = (n: number) => { const all = candidateLabels(initialRoom(n, 1, false)); return [all.length, sha(all.join("\n"))] }
    const steady2 = steadyAnchor(2)
    const steady3 = steadyAnchor(3)
    const reload = roomAnchor(3, "reload", 1)
    const search = roomBfs(roomAnchor(2, "reload", 1).room, { depth: 3, maxStates: 1_000_000, heapStopMb: 100_000 })
    // the heartbeat model the network runs use (ROOM_BEAT=1, read where a room is made)
    process.env.ROOM_BEAT = "1"
    const beatAnchor = roomAnchor(2, "network-all", 1)
    const beatSearch = roomBfs(beatAnchor.room, { depth: 3, maxStates: 1_000_000, heapStopMb: 100_000 })
    delete process.env.ROOM_BEAT
    const got = {
      labels2: labels(2),
      labels3: labels(3),
      steady2: [steady2.labels.length, sha(steady2.labels.join("\n")), sha(fullRoomKey(steady2.room))],
      steady3: [steady3.labels.length, sha(steady3.labels.join("\n")), sha(fullRoomKey(steady3.room))],
      reload3: [reload.labels.length, sha(reload.labels.join("\n")), sha(fullRoomKey(reload.room)), sha(candidateLabels(reload.room).join("\n"))],
      search: { states: search.states, layers: search.layers.map((layer) => layer.states), findings: search.findingCounts },
      beat: [beatAnchor.labels.length, sha(beatAnchor.labels.join("\n")), sha(fullRoomKey(beatAnchor.room)), beatSearch.states, beatSearch.layers.map((layer) => layer.states), beatSearch.findingCounts],
    }
    expect(got).toEqual(PIN)
  }, 600_000)
})

// taken on origin/main before the frozen clock (a7f96482); the label pins re-taken for #1786's
// statement-answer outcomes and #1797's distinct displaced key
const PIN = {
  labels2: [121, "3844cde08d225469"],
  labels3: [348, "b6c2e05ffa4d61e5"],
  steady2: [22, "c3a36d79dbdb1dcb", "d308efbe67c56f62"],
  steady3: [66, "48f755a68141da74", "b67dd149f7dba272"],
  reload3: [67, "07ac3eb2e51b2ca6", "25712515e252af3d", "b6c2e05ffa4d61e5"],
  search: { states: 914, layers: [17, 151, 914], findings: {} },
  beat: [25, "b69982da0cbdb098", "8c2edf13295e26c5", 228, [3, 32, 228], {}],
}

describe("the room with the frozen page clock on (ROOM_FROZEN)", () => {
  const frozenSteady = (): Room => {
    process.env.ROOM_BEAT = "1"
    process.env.ROOM_FROZEN = "1"
    try {
      return steadyAnchor(2).room
    } finally {
      delete process.env.ROOM_BEAT
      delete process.env.ROOM_FROZEN
    }
  }

  it("adds its labels after every other, for the freezable phone only", () => {
    const off = candidateLabels(initialRoom(2, 1, true))
    const on = candidateLabels(initialRoom(2, 1, true, [], [1]))
    expect(on.slice(0, off.length)).toEqual(off)
    expect(on.slice(off.length)).toEqual(["vis:1:hide", "vis:1:hide-quiet", "vis:1:freeze", "vis:1:show", "ice:0>1:silent"])
  })

  it("stands the frozen phone's clock still while the other's runs, and resumes it where it stopped", () => {
    const start = frozenSteady()
    const frozen = walkRoom(start, ["vis:1:hide", "vis:1:freeze"])
    expect(frozen.halves[1]![0]!.actor.hidden).toBe(true)
    // the peer read the away frame
    expect(frozen.halves[0]![1]!.facts.away).toBe("said")
    let room = frozen
    while (room.now < start.now + 30_000) room = step(room, step(room, "tick:0") ? "tick:0" : step(room, "beat:0") ? "beat:0" : "advance:0")!.room
    expect(localNow(room, 1)).toBe(start.now)
    expect(localNow(room, 0)).toBe(room.now)
    // a frozen phone takes nothing: no timer, no read, no browser report
    for (const label of candidateLabels(room)) if (/^(h:1>|tick:1|advance:1|beat:1|hello:\d@1|w:0>1|ice:0-1|chan:)/.test(label)) expect(step(room, label)).toBeNull()
    // its peer's connection loses consent
    expect(step(room, "ice:0>1:silent")).not.toBeNull()
    const shown = step(room, "vis:1:show")!
    const back = shown.edge.steps.find((s) => s.phone === 1 && s.event.type === "visibility-changed")!
    expect(back.event).toMatchObject({ hidden: false, hiddenForMs: 0, now: start.now })
    expect(localNow(shown.room, 1)).toBe(start.now)
    expect(shown.room.phones[1]!.lag).toBe(room.now - start.now)
    expect(shown.room.halves[0]![1]!.facts.away).toBeNull()
  })

  it("keeps a consent-expired link down until an ICE restart or a new connection", () => {
    // the away frame read: the peer holds the link (said) instead of rebuilding
    let room = walkRoom(frozenSteady(), ["vis:1:hide", "vis:1:freeze"])
    const start = room.now
    const silent = () => step(room, "ice:0>1:silent", { noFaults: true })
    while (room.halves[0]![1]!.facts.browserConnectionState !== "failed" && room.now < start + 120_000) {
      const next = silent() ?? ["choice:0:resolved", "tick:0", "beat:0", "advance:0"].map((label) => step(room, label, { noFaults: true })).find((s) => s)
      room = next!.room
    }
    expect(room.halves[0]![1]!.facts.browserConnectionState).toBe("failed")
    expect(room.now - start).toBeGreaterThanOrEqual(30_000)
    const back = walkRoom(room, ["vis:1:show"])
    // same connection, consent expired: no ice:up by itself
    expect(back.halves[0]![1]!.meshConnectionEpoch).toBe(room.halves[0]![1]!.meshConnectionEpoch)
    expect(back.extras[0]![1]!.consentLost).toBe(true)
    expect(step(back, "ice:0-1:up")).toBeNull()
  })

  it("keys the page state: hidden, then frozen", () => {
    const start = frozenSteady()
    const hidden = walkRoom(start, ["vis:1:hide"])
    const frozen = walkRoom(hidden, ["vis:1:freeze"])
    expect(new Set([fullRoomKey(start), fullRoomKey(hidden), fullRoomKey(frozen)]).size).toBe(3)
  })
})
