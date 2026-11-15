// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * P1, answer correctness (#1385). A frame Mesh sent down its
 * answer path (wire.ts `answerPath`) and that reached the wire must
 * (1) be an answer by the SDP identity ControlledPC wrote (`x-role`), and
 * (2) on the statement wire, carry the gen of the delivery that handed this
 * side the offer its `x-answers` names. Oracles: the wire log, the delivery
 * log; never Mesh's maps.
 */
import { answeredOffer, answerPath, offerDelivery, onWire, sender, type Monitor } from "./wire"
import type { Violation, WireLogEntry } from "../room"

export const P1: Monitor = {
  id: "P1",
  // Reads only this side's projected wire and delivery history.
  closed: true,
  afterStep(room, record) {
    const frames = (record.frames as WireLogEntry[]).filter((entry) => answerPath(entry) && onWire(entry))
    if (frames.length === 0) return []
    const found: Violation[] = []
    const { deliveries } = room.logs()
    for (const entry of frames) {
      const from = sender(entry) ?? entry.from
      if (entry.xRole !== "answer") {
        found.push({ property: "P1", atStep: record.index, detail: `${from} sent an ${entry.xRole ?? "unidentified"} description as its answer on the ${entry.channel} wire` })
        continue
      }
      if (entry.channel !== "statement") continue
      const offer = answeredOffer(entry.xAnswers)
      const delivery = offerDelivery(deliveries, entry.from, offer, entry.step)
      if (delivery?.gen !== entry.meshGen) {
        found.push({ property: "P1", atStep: record.index, detail: `${from}'s answer to ${offer ?? "?"} carries gen ${entry.meshGen} but that offer was delivered with gen ${delivery ? (delivery.gen ?? "none") : "(never delivered)"}` })
      }
    }
    return found
  },
}
