// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import type { GestureTag } from "./webrtc/gesture"

vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))
const mocks = vi.hoisted(() => ({
  metrics: [] as Array<{ name: string; value: number; attrs: Record<string, string> }>,
}))
vi.mock("./telemetry", () => ({
  recordCount: (name: string, value: number, attrs: Record<string, string>) => mocks.metrics.push({ name, value, attrs: { ...attrs } }),
}))

const { acceptKey, newTapLedger, receiveTap, recordTapReceived, nextSentSeq, recordTapSent, recordNewTaps } = await import("./tap-receipt")
const { devLog } = await import("./debug/log-store")

type Tap = { peerId: string; tag: GestureTag; round: number }
type ArrivedTap = Tap & { turn: number | null }

const STRIDE = 6

function receivedCtx(tap: Tap, receiverRound: number | null, self = "A") {
  return { gameIndex: 330, self, peerId: tap.peerId, tag: tap.tag, round: tap.round, receiverRound, turn: 2, stride: STRIDE, hidden: false }
}

function receive(ledger: ReturnType<typeof newTapLedger>, tap: Tap, receiverRound: number | null, self = "A", arrivalTurn: number | null = 6) {
  recordTapReceived(receivedCtx(tap, receiverRound, self), receiveTap(ledger, tap, acceptKey(tap.round, arrivalTurn, STRIDE), receiverRound))
  return mocks.metrics.at(-1)!
}

afterEach(() => {
  mocks.metrics.length = 0
  vi.mocked(devLog).mockClear()
})

describe("a co-player tap that arrives", () => {
  it("records one game.tap_received row that says it showed", () => {
    // Given
    const ledger = newTapLedger()

    // When
    recordTapReceived(
      receivedCtx({ peerId: "B", tag: "Accept", round: 1 }, 1),
      receiveTap(ledger, { peerId: "B", tag: "Accept", round: 1 }, "1:6", 1),
    )

    // Then
    expect(mocks.metrics).toEqual([
      {
        name: "game.tap_received",
        value: 1,
        attrs: {
          round: "2",
          "rtc.pair": "g330:r2:83897bfe4160",
          outcome: "shown",
          "tap.tag": "accept",
          "tap.seq": "1",
          "tap.accepted": "1",
          "tap.receiver_round": "2",
          "tap.turn": "2",
          "tap.hidden": "false",
        },
      },
    ])
  })

  it("names a tap from an earlier round as round-closed", () => {
    expect(receive(newTapLedger(), { peerId: "B", tag: "Accept", round: 1 }, 2).attrs.outcome).toBe("round-closed")
  })

  it("names a tap from a later round as round-not-open", () => {
    expect(receive(newTapLedger(), { peerId: "B", tag: "Accept", round: 1 }, 0).attrs.outcome).toBe("round-not-open")
  })

  it("names a tap that lands outside any round as no-round", () => {
    const row = receive(newTapLedger(), { peerId: "B", tag: "Accept", round: 1 }, null)
    expect(row.attrs.outcome).toBe("no-round")
    expect(row.attrs["tap.receiver_round"]).toBe("none")
  })

  it("names a second accept from the same peer, round and turn as already-accepted, with the next seq", () => {
    // Given
    const ledger = newTapLedger()
    receive(ledger, { peerId: "B", tag: "Accept", round: 1 }, 1)

    // When
    const row = receive(ledger, { peerId: "B", tag: "Accept", round: 1 }, 1)

    // Then
    expect(row.attrs.outcome).toBe("already-accepted")
    expect(row.attrs["tap.seq"]).toBe("2")
    expect(row.attrs["tap.accepted"]).toBe("1")
  })

  it("shows an accept from the same peer and round again on a later turn, with the next seq", () => {
    // Given
    const ledger = newTapLedger()
    receive(ledger, { peerId: "B", tag: "Accept", round: 1 }, 1, "A", 7)

    // When
    const row = receive(ledger, { peerId: "B", tag: "Accept", round: 1 }, 1, "A", 8)

    // Then
    expect(row.attrs).toMatchObject({ outcome: "shown", "tap.seq": "2", "tap.accepted": "1", "tap.turn": "2" })
  })

  it("names an unaccept as unaccept, and an accept after it shows again", () => {
    // Given
    const ledger = newTapLedger()
    receive(ledger, { peerId: "B", tag: "Accept", round: 1 }, 1)

    // When
    const unaccept = receive(ledger, { peerId: "B", tag: "Unaccept", round: 1 }, 1)
    const again = receive(ledger, { peerId: "B", tag: "Accept", round: 1 }, 1)

    // Then
    expect(unaccept.attrs).toMatchObject({ outcome: "unaccept", "tap.tag": "unaccept", "tap.seq": "2", "tap.accepted": "0" })
    expect(again.attrs).toMatchObject({ outcome: "shown", "tap.seq": "3", "tap.accepted": "1" })
  })

  it("writes one devLog line per received tap", () => {
    receive(newTapLedger(), { peerId: "B", tag: "Accept", round: 1 }, 1)

    expect(devLog).toHaveBeenCalledTimes(1)
    expect(devLog).toHaveBeenCalledWith("vote", "tap received", expect.objectContaining({ round: 1, from: "B", tag: "Accept", outcome: "shown", seq: 1 }))
  })

  it("files each tap in the accepter set of its round and arrival turn", () => {
    // Given
    const taps: ArrivedTap[] = [
      { peerId: "B", tag: "Accept", round: 0, turn: 0 },
      { peerId: "C", tag: "Accept", round: 0, turn: 0 },
      { peerId: "B", tag: "Unaccept", round: 0, turn: 0 },
      { peerId: "B", tag: "Accept", round: 0, turn: 1 },
      { peerId: "B", tag: "Accept", round: 1, turn: 4 },
      { peerId: "C", tag: "Accept", round: 1, turn: null },
      { peerId: "B", tag: "Accept", round: 1, turn: 7 },
      { peerId: "B", tag: "Accept", round: 1, turn: 7 },
      { peerId: "D", tag: "Unaccept", round: 1, turn: 7 },
      { peerId: "C", tag: "Unaccept", round: 0, turn: 0 },
      { peerId: "C", tag: "Accept", round: 0, turn: 0 },
    ]

    // When
    const ledger = newTapLedger()
    recordNewTaps(ledger, taps, { gameIndex: 330, self: "A", receiverRound: 0, turn: 0, stride: STRIDE, hidden: false })

    // Then
    expect(ledger.accepted).toEqual(
      new Map([
        ["0:0", new Set(["C"])],
        ["0:1", new Set(["B"])],
        ["1:6", new Set(["B", "C"])],
        ["1:7", new Set(["B"])],
      ]),
    )
  })

  it("records each gesture of the list once, and counts again after the room closes", () => {
    // Given
    const ledger = newTapLedger()
    const ctx = { gameIndex: 330, self: "A", receiverRound: 1, turn: 2, stride: STRIDE, hidden: false }
    const gestures: ArrivedTap[] = [
      { peerId: "B", tag: "Accept", round: 1, turn: 6 },
      { peerId: "C", tag: "Accept", round: 1, turn: 6 },
    ]

    // When
    recordNewTaps(ledger, gestures, ctx)
    recordNewTaps(ledger, gestures, ctx)
    recordNewTaps(ledger, [...gestures, { peerId: "B", tag: "Unaccept", round: 1, turn: 6 }], ctx)
    recordNewTaps(ledger, [{ peerId: "B", tag: "Accept", round: 1, turn: 6 }], ctx)

    // Then
    expect(mocks.metrics.map((m) => [m.attrs["rtc.pair"], m.attrs["tap.tag"], m.attrs["tap.seq"], m.attrs.outcome])).toEqual([
      ["g330:r2:83897bfe4160", "accept", "1", "shown"],
      ["g330:r2:d1361a2530ea", "accept", "1", "shown"],
      ["g330:r2:83897bfe4160", "unaccept", "2", "unaccept"],
      ["g330:r2:83897bfe4160", "accept", "1", "shown"],
    ])
  })
})

describe("the accepter set a tap files under", () => {
  it("is the turn it arrived on, or the first turn of its round when it arrived before that round opened", () => {
    expect([
      acceptKey(0, null, STRIDE),
      acceptKey(1, null, STRIDE),
      acceptKey(1, 5, STRIDE),
      acceptKey(1, 7, STRIDE),
      acceptKey(0, 7, STRIDE),
    ]).toEqual(["0:0", "1:6", "1:6", "1:7", "0:7"])
  })
})

describe("a co-player tap that is cast", () => {
  it("records one game.tap_sent row that says it was handed to the mesh", () => {
    // Given
    const seq = nextSentSeq(new Map(), "B", 1)

    // When
    recordTapSent({ gameIndex: 330, self: "A", peerId: "B", tag: "Accept", round: 1, turn: 2, handed: true, link: "connected", seq })

    // Then
    expect(mocks.metrics).toEqual([
      {
        name: "game.tap_sent",
        value: 1,
        attrs: {
          round: "2",
          "rtc.pair": "g330:r2:83897bfe4160",
          outcome: "handed",
          "tap.tag": "accept",
          "tap.seq": "1",
          "tap.turn": "2",
          "tap.link": "connected",
        },
      },
    ])
  })

  it("names a tap on someone who is not a mesh peer as not-a-peer", () => {
    recordTapSent({ gameIndex: 330, self: "A", peerId: "B", tag: "Unaccept", round: 1, turn: null, handed: false, link: "none", seq: 1 })

    expect(mocks.metrics[0]!.attrs).toMatchObject({ outcome: "not-a-peer", "tap.tag": "unaccept", "tap.turn": "none", "tap.link": "none" })
  })

  it("counts the sent seq per peer and round", () => {
    const seq = new Map<string, number>()

    expect([
      nextSentSeq(seq, "B", 1),
      nextSentSeq(seq, "B", 1),
      nextSentSeq(seq, "C", 1),
      nextSentSeq(seq, "B", 0),
      nextSentSeq(seq, "B", 1),
    ]).toEqual([1, 2, 1, 1, 3])
  })
})

describe("a tap seen on both phones", () => {
  it("gives the sent row and the received row the same rtc.pair, tap.tag and tap.seq", () => {
    // Given
    const sentSeq = new Map<string, number>()
    const ledgerOfB = newTapLedger()
    const key = (m: { attrs: Record<string, string> }) => [m.attrs["rtc.pair"], m.attrs["tap.tag"], m.attrs["tap.seq"]]

    // When
    const pairs = (["Accept", "Unaccept"] as const).map((tag) => {
      recordTapSent({ gameIndex: 330, self: "A", peerId: "B", tag, round: 1, turn: 2, handed: true, link: "connected", seq: nextSentSeq(sentSeq, "B", 1) })
      const sent = mocks.metrics.at(-1)!
      const received = receive(ledgerOfB, { peerId: "A", tag, round: 1 }, 1, "B")
      return { sent, received }
    })

    // Then
    for (const { sent, received } of pairs) {
      expect(sent.name).toBe("game.tap_sent")
      expect(received.name).toBe("game.tap_received")
      expect(key(received)).toEqual(key(sent))
    }
    expect(pairs.map(({ sent }) => sent.attrs["tap.seq"])).toEqual(["1", "2"])
  })
})
