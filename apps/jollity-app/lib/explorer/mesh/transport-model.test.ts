// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { RtcPayload } from "@jollity/statement-core"
import { createTransportModel, type TransportModel, type WireFrame } from "./transport-model"

const offer = (sdp: string): RtcPayload => ({ rtc: { desc: { type: "offer", sdp } } })
const answer = (gen: string, sdp: string): RtcPayload => ({ rtc: { desc: { type: "answer", sdp }, gen } })
const cand = (gen: string, candidate: string): RtcPayload => ({ rtc: { cand: { candidate }, gen } })

function takeHello(model: TransportModel, from: "a" | "b", sid: string) {
  model.hello(from, sid)
  const frame = model
    .deliverable()
    .find((candidate) => candidate.kind === "hello" && candidate.from === from && candidate.sid === sid)
  if (!frame) throw new Error(`missing hello from ${from}`)
  return model.take(frame.id)
}

function establish(model: TransportModel, aSid = "a-boot", bSid = "b-boot") {
  takeHello(model, "a", aSid)
  takeHello(model, "b", bSid)
}

const ids = (frames: WireFrame[]) => frames.map((frame) => frame.id)

describe("transport model", () => {
  it("mints gen <sid>.<n> for each offer and keeps the echoed gen on an answer", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")

    const first = model.publish("a", "b", offer("offer-1"))
    const second = model.publish("a", "b", offer("offer-2"))
    const echoed = model.publish("b", "a", answer(second.gen!, "answer-2"))

    expect(first.gen).toBe("a1.1")
    expect(first.payload.rtc.gen).toBe("a1.1")
    expect(second.gen).toBe("a1.2")
    expect(second.payload.rtc.gen).toBe("a1.2")
    expect(echoed.gen).toBe("a1.2")
    expect(echoed.payload.rtc.gen).toBe("a1.2")
  })

  it("keeps only the newest description per directed pair", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")

    const first = model.publish("a", "b", offer("offer-1"))
    const second = model.publish("a", "b", offer("offer-2"))

    expect(ids(model.deliverable())).not.toContain(first.id)
    expect(ids(model.deliverable())).toContain(second.id)
  })

  it("uses one description slot per pair across sid and offer or answer", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    const answerToA = model.publish("b", "a", answer(aOffer.gen!, "b-answer"))
    takeHello(model, "b", "b2")
    const bOffer = model.publish("b", "a", offer("b-offer"))

    expect(ids(model.deliverable())).not.toContain(answerToA.id)
    expect(ids(model.deliverable())).toContain(bOffer.id)
  })

  it("drops an offer whose counter is below the last adopted in the current sid", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")

    const first = model.publish("a", "b", offer("offer-1"))
    model.capture(first.id)
    const second = model.publish("a", "b", offer("offer-2"))
    model.take(second.id)

    expect(ids(model.deliverable())).not.toContain(first.id)
  })

  it("drops an answer or candidate whose gen is not the receiver's current one", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")

    const first = model.publish("a", "b", offer("offer-1"))
    model.publish("a", "b", offer("offer-2"))
    const wrongAnswer = model.publish("b", "a", answer(first.gen!, "superseded-answer"))
    const wrongCandidate = model.publish("b", "a", cand(first.gen!, "superseded-candidate"))

    expect(ids(model.deliverable())).not.toContain(wrongAnswer.id)
    expect(ids(model.deliverable())).not.toContain(wrongCandidate.id)
  })

  it("drops a frame of a sid the receiver left", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const oldOffer = model.publish("a", "b", offer("old-offer"))
    model.capture(oldOffer.id)

    const switched = takeHello(model, "a", "a2")

    expect(switched.newSession).toBe(true)
    expect(ids(model.deliverable())).not.toContain(oldOffer.id)
  })

  it("switches sid only through a hello and reports newSession on the first frame after it", () => {
    const model = createTransportModel()
    const firstHello = takeHello(model, "a", "a1")
    model.hello("a", "a2")
    const freshOffer = model.publish("a", "b", offer("fresh-offer"))

    expect(firstHello.newSession).toBe(false)
    expect(ids(model.deliverable())).not.toContain(freshOffer.id)

    const hello = model.deliverable().find((frame) => frame.kind === "hello" && frame.sid === "a2")!
    const switched = model.take(hello.id)
    expect(switched.newSession).toBe(true)
    expect(ids(model.deliverable())).toContain(freshOffer.id)
  })

  it("refuses an older hello while the current sid is live and never returns to a sid it left", () => {
    const model = createTransportModel()
    takeHello(model, "a", "200-live")

    model.hello("a", "100-old")
    expect(model.deliverable().some((frame) => frame.kind === "hello" && frame.sid === "100-old")).toBe(false)

    takeHello(model, "a", "300-new")
    model.hello("a", "200-live")
    expect(model.deliverable().some((frame) => frame.kind === "hello" && frame.sid === "200-live")).toBe(false)
  })

  it("does not re-deliver a duplicate offer with the same generation and SDP", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const frame = model.publish("a", "b", offer("offer"))

    model.take(frame.id)
    expect(ids(model.deliverable())).not.toContain(frame.id)
    model.drop(frame.id)
    expect(ids(model.deliverable())).not.toContain(frame.id)
  })

  it("consumes a captured copy once while keeping its stored candidate for a reset", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    model.take(aOffer.id)
    const frame = model.publish("a", "b", cand(aOffer.gen!, "candidate"))

    model.capture(frame.id)
    expect(ids(model.inFlight("b"))).toEqual([frame.id])
    model.take(frame.id)
    expect(model.inFlight("b")).toEqual([])
    expect(ids(model.deliverable())).not.toContain(frame.id)

    model.hello("b", "b2")
    model.take(aOffer.id)

    expect(ids(model.deliverable())).toContain(frame.id)
    model.take(frame.id)
    expect(ids(model.deliverable())).not.toContain(frame.id)
  })

  it("keeps a heard hello stored for a reloaded receiver without repeating it before reset", () => {
    const model = createTransportModel()
    model.hello("a", "a1")
    const hello = model.deliverable().find((frame) => frame.kind === "hello" && frame.from === "a")!

    model.take(hello.id)
    expect(ids(model.deliverable())).not.toContain(hello.id)

    model.hello("b", "b1")
    model.hello("b", "b2")

    expect(ids(model.deliverable())).toContain(hello.id)
    model.take(hello.id)
    expect(ids(model.deliverable())).not.toContain(hello.id)
  })

  it("keeps frames to a reloaded side's old session deliverable to its new session", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const stored = model.publish("a", "b", offer("stored-for-b"))

    model.hello("b", "b2")

    expect(ids(model.deliverable())).toContain(stored.id)
  })

  it("lets a reloaded receiver read the same stored offer again without a duplicate fault", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const stored = model.publish("a", "b", offer("stored-for-b"))

    model.take(stored.id)
    expect(ids(model.deliverable())).not.toContain(stored.id)

    model.hello("b", "b2")

    expect(ids(model.deliverable())).toContain(stored.id)
    expect(model.take(stored.id).frame).toBe(stored)
  })

  it("clears a reloaded side's receive state", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    model.hello("a", "a2")
    const beforeReload = model.publish("a", "b", offer("from-new-a"))
    expect(ids(model.deliverable())).not.toContain(beforeReload.id)

    model.hello("b", "b2")

    expect(ids(model.deliverable())).toContain(beforeReload.id)
    expect(model.take(beforeReload.id).newSession).toBe(false)
  })

  it("admits a description before hello and adopts its sid", () => {
    const model = createTransportModel()
    model.hello("a", "a1")
    const pendingHello = model.deliverable().find((frame) => frame.kind === "hello")!
    const earlyOffer = model.publish("a", "b", offer("early-offer"))
    model.drop(pendingHello.id)

    expect(ids(model.deliverable())).toContain(earlyOffer.id)
    expect(model.take(earlyOffer.id).newSession).toBe(false)
  })

  it("admits a generation-matched candidate before hello and adopts its sid", () => {
    const model = createTransportModel()
    model.hello("a", "a1")
    const localOffer = model.publish("a", "b", offer("local-offer"))
    model.hello("b", "b1")
    const pendingHello = model
      .deliverable()
      .find((frame) => frame.kind === "hello" && frame.from === "b")!
    const earlyCandidate = model.publish("b", "a", cand(localOffer.gen!, "early-candidate"))
    model.drop(pendingHello.id)

    expect(ids(model.deliverable())).toContain(earlyCandidate.id)
    expect(model.take(earlyCandidate.id).newSession).toBe(false)
  })

  it("does not re-deliver a candidate already seen in the current generation", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    model.take(aOffer.id)
    const first = model.publish("a", "b", cand(aOffer.gen!, "candidate"))
    model.take(first.id)

    const duplicate = model.publish("a", "b", cand(aOffer.gen!, "candidate"))
    expect(ids(model.deliverable())).not.toContain(duplicate.id)
  })

  it("gates an answer on outgoing gen even after glare adopts the peer's offer", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    const bOffer = model.publish("b", "a", offer("b-offer"))
    model.take(bOffer.id)
    const answerToA = model.publish("b", "a", answer(aOffer.gen!, "answer-to-a"))

    expect(ids(model.deliverable())).toContain(answerToA.id)
    model.take(answerToA.id)
    const candidateToA = model.publish("b", "a", cand(aOffer.gen!, "candidate-to-a"))
    expect(ids(model.deliverable())).toContain(candidateToA.id)
  })

  it("drops the peer's answer to our old offer after we answer its glare offer", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    const bOffer = model.publish("b", "a", offer("b-offer"))
    model.publish("a", "b", answer(bOffer.gen!, "answer-to-b"))
    const staleAnswerToA = model.publish("b", "a", answer(aOffer.gen!, "answer-to-a"))

    expect(ids(model.deliverable())).not.toContain(staleAnswerToA.id)
  })

  it("skips a stale answer without replacing the live description or outgoing generation", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const first = model.publish("a", "b", offer("offer-one"))
    model.take(first.id)
    const second = model.publish("a", "b", offer("offer-two"))
    model.take(second.id)

    const liveAnswer = model.publish("b", "a", answer(second.gen!, "live-answer"))
    const staleAnswer = model.publish("b", "a", answer(first.gen!, "stale-answer"))
    const answerBack = model.publish("a", "b", answer(second.gen!, "answer-back"))

    expect(model.stored(liveAnswer.id)).toBe(true)
    expect(model.stored(staleAnswer.id)).toBe(false)
    expect(ids(model.deliverable())).toContain(liveAnswer.id)
    expect(ids(model.deliverable())).not.toContain(staleAnswer.id)
    expect(ids(model.deliverable())).toContain(answerBack.id)
  })

  it("admits an answer re-read after a different description from that peer", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    const first = model.publish("b", "a", answer(aOffer.gen!, "answer-one"))
    model.take(first.id)

    const unchanged = model.publish("b", "a", answer(aOffer.gen!, "answer-one"))
    expect(ids(model.deliverable())).not.toContain(unchanged.id)

    const different = model.publish("b", "a", answer(aOffer.gen!, "answer-two"))
    model.take(different.id)
    const reRead = model.publish("b", "a", answer(aOffer.gen!, "answer-one"))
    expect(ids(model.deliverable())).toContain(reRead.id)
  })

  it("drops an equal offer replay after the receiver's generation moved", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const aOffer = model.publish("a", "b", offer("a-offer"))
    model.take(aOffer.id)
    model.publish("b", "a", offer("b-glare-offer"))

    expect(ids(model.deliverable())).not.toContain(aOffer.id)
  })

  it("captures a stored frame into the receiver's in-flight queue, separately from the store's newest slot", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const captured = model.publish("a", "b", offer("offer-1"))
    model.capture(captured.id)
    const newest = model.publish("a", "b", offer("offer-2"))

    expect(ids(model.inFlight("b"))).toEqual([captured.id])
    expect(ids(model.deliverable())).toEqual([captured.id, newest.id])
  })

  it("never holds two stored frames for one key", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const first = model.publish("a", "b", offer("offer-1"))
    const second = model.publish("a", "b", offer("offer-2"))

    expect(ids(model.deliverable()).filter((id) => id === first.id || id === second.id)).toEqual([second.id])
  })

  it("reproduces the 1565 shape: a/1's offer captured by the reloaded b, then a/2's offer overwriting the stored slot, both deliverable at once", () => {
    const model = createTransportModel()
    establish(model, "a1", "b1")
    const fromA1 = model.publish("a", "b", offer("offer-from-a-1"))

    model.hello("b", "b2")
    model.capture(fromA1.id)
    const reloadHello = model.deliverable().find((frame) => frame.kind === "hello" && frame.from === "b")!
    model.take(reloadHello.id)
    const fromA2 = model.publish("a", "b", offer("offer-from-a-2"))

    expect(ids(model.inFlight("b"))).toEqual([fromA1.id])
    expect(ids(model.deliverable().filter((frame) => frame.kind !== "hello"))).toEqual([fromA1.id, fromA2.id])
  })

  describe("the heartbeat (re-announce and hello)", () => {
    it("puts a dropped description back with the same gen and SDP under a new id, once", () => {
      const model = createTransportModel()
      establish(model, "a1", "b1")
      const sent = model.publish("a", "b", offer("offer-1"))
      expect(model.reannounce("a", "b")).toBeNull() // still stored
      model.drop(sent.id)
      const again = model.reannounce("a", "b")!
      expect(again).toMatchObject({ from: "a", to: "b", kind: "offer", sid: "a1", gen: sent.gen, payload: sent.payload })
      expect(again.id).not.toBe(sent.id)
      expect(ids(model.deliverable())).toContain(again.id)
      expect(model.reannounce("a", "b")).toBeNull()
      // the receiver takes it once (gen|sdp dedupe), and it stays in the slot
      model.take(again.id)
      expect(ids(model.deliverable())).not.toContain(again.id)
      expect(model.reannounce("a", "b")).toBeNull()
    })

    it("re-announces an answer with its echoed gen, and never re-mints an offer counter", () => {
      const model = createTransportModel()
      establish(model, "a1", "b1")
      const aOffer = model.publish("a", "b", offer("offer-1"))
      model.take(aOffer.id)
      const sent = model.publish("b", "a", answer(aOffer.gen!, "answer-1"))
      model.drop(sent.id)
      expect(model.reannounce("b", "a")).toMatchObject({ kind: "answer", gen: aOffer.gen })
      expect(model.publish("a", "b", offer("offer-2")).gen).toBe("a1.2")
    })

    it("forgets the description when its sender starts a new session, or adopts the receiver's new one", () => {
      const model = createTransportModel()
      establish(model, "a1", "b1")
      model.drop(model.publish("a", "b", offer("offer-1")).id)
      takeHello(model, "b", "b2") // a adopts b's new session: resetNegotiation
      expect(model.reannounce("a", "b")).toBeNull()
      model.drop(model.publish("b", "a", offer("b-offer")).id)
      model.hello("b", "b3") // b's own new session
      expect(model.reannounce("b", "a")).toBeNull()
    })

    it("puts a lost first hello back, and only while it is lost", () => {
      const model = createTransportModel()
      establish(model, "a1", "b1")
      expect(model.heard("a", "b")).toBe(true)
      model.hello("b", "b2")
      const hello = model.deliverable().find((frame) => frame.kind === "hello" && frame.sid === "b2")!
      expect(model.helloLost("b")).toBe(false)
      expect(model.rehello("b")).toBeNull()
      expect(model.heard("a", "b")).toBe(false)
      model.drop(hello.id)
      expect(model.helloLost("b")).toBe(true)
      const again = model.rehello("b")!
      expect(again).toMatchObject({ kind: "hello", from: "b", sid: "b2" })
      expect(model.helloLost("b")).toBe(false)
      expect(model.take(again.id).newSession).toBe(true)
      expect(model.heard("a", "b")).toBe(true)
    })
  })
})
