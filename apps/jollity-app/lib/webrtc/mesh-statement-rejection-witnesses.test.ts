// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Witness tests for the statement `set-remote-description` catch branches that
 * the reachability analysis in `parity-reach-b1` proved REACHABLE but no test
 * named: rows 30, 31, 32 and 34 of its `RESULT.md` (the Z3 model of mesh.ts's
 * statement signalling, the traces in its `run.log`).
 *
 * Each test runs the real Mesh on the fake RTCPeerConnection, forces the
 * rejection its witness names, and asserts the classification the real code
 * emits on the actor's completion — the `site` and `reason` of
 * `applyStatementOffer` (mesh.ts, the `set-remote-description` catch), never a
 * mock's echo.
 *
 * Row 33 (the refused offer's retry resolving) is walked end to end by
 * mesh-answer.test.ts, "after an offer refused with InvalidAccessError, …";
 * that test asserts the retry's classification too, so it is not repeated
 * here. Rows 35 and 37 are excluded: the analysis leaves them UNDECIDED
 * (browser-dependent), since a conforming browser cannot reject with an error
 * name outside `HARD_NEGOTIATION_ERRORS`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PeerActorEvent } from "../state-machines/peer-actor"
import { actorEvents, FakePC, sdp, setupMesh } from "./test-pc"

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

type Inputs = readonly { peer: string; event: PeerActorEvent }[]

async function driven(myId: string, peerId: string) {
  const made = await setupMesh(myId, peerId, { decisionRoom: "g7", decisionRoomEpoch: 3 })
  /** the events the actor stepped on, completions included */
  return { ...made, inputs: actorEvents(made.mesh) }
}

/** the set-remote-description completions the actor took, in order */
const applies = (inputs: Inputs) =>
  inputs.flatMap(({ event }) => event.type === "command-completed" && event.commandKind === "set-remote-description" ? [event] : [])

describe("the statement offer catch's classifications, as the reachability witnesses give them", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("row 30: an offer refused with OperationError on a virgin connection is classified virgin-pc", async () => {
    // the witness: a fresh responder-only PC (no channel, no local, no remote
    // description) and a same-session offer the apply fails on with
    // OperationError — WebRTC 1.0 §4.4.1.4's "all other errors"
    const { mesh, pc, inputs } = await driven("b", "a")
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("unusable offer", "OperationError"))
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
    await settle()
    expect(pc.remoteDescription, "row 30: the refused offer left the connection holding no remote description").toBeNull()
    expect(applies(inputs), "row 30: a refused first offer on a virgin PC is classified virgin-pc at statement-offer-received").toEqual([
      expect.objectContaining({ outcome: "rejected", site: "statement-offer-received", reason: "virgin-pc" }),
    ])
    mesh.close()
  })

  it("row 31: an offer refused with OperationError while a remote description is held is classified other", async () => {
    // the witness: a connection that already applied one offer, then a
    // same-session offer whose apply fails with OperationError — held remote
    // description and not InvalidAccessError, so neither virgin-pc nor
    // invalid-access
    const { mesh, pc, inputs } = await driven("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
    await settle()
    expect(pc.remoteDescription, "row 31: the first offer is applied, so the connection holds a remote description").not.toBeNull()
    inputs.length = 0
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("unusable offer", "OperationError"))
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
    await settle()
    expect(pc.remoteDescription, "row 31: the refused offer leaves the held remote description in place").not.toBeNull()
    expect(applies(inputs), "row 31: an OperationError refusal over a held remote description is classified other").toEqual([
      expect.objectContaining({ outcome: "rejected", site: "statement-offer-received", reason: "other" }),
    ])
    mesh.close()
  })

  it("row 32: an offer refused with InvalidAccessError on a negotiated connection is classified invalid-access", async () => {
    // the witness: a negotiated connection (local and remote description
    // held) and a same-session offer with fewer m-lines, which Chrome refuses
    // with InvalidAccessError (the fake applies libwebrtc's m-line rule)
    const { mesh, pc, inputs } = await driven("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
    await settle()
    expect(pc.localDescription, "row 32: the answered connection holds a local description, so the refusal is not the virgin case").not.toBeNull()
    inputs.length = 0
    // same session, fewer m-lines than were negotiated: refused as Chrome does
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
    await settle()
    expect(applies(inputs)[0], "row 32: an InvalidAccessError refusal on a negotiated connection is classified invalid-access").toMatchObject({
      outcome: "rejected",
      site: "statement-offer-received",
      reason: "invalid-access",
    })
    mesh.close()
  })

  it("row 34: the retried offer refused with OperationError is classified hard-sdp at statement-offer-retried", async () => {
    // the witness: row 32's refusal, the rebuilt responder, then the retry of
    // the same offer refused with OperationError — the retry site classifies
    // through sdpRejection, so the spec's own error names are hard-sdp
    const { mesh, inputs } = await driven("b", "a")
    const apply = FakePC.prototype.setRemoteDescription
    // 1: the negotiation's offer applies; 2: the second offer is refused
    // InvalidAccessError (row 32); 3: the retry on the rebuilt responder is
    // refused OperationError (row 34)
    const outcomes = [undefined, "InvalidAccessError", "OperationError"] as const
    let call = 0
    vi.spyOn(FakePC.prototype, "setRemoteDescription").mockImplementation(function (this: FakePC, desc) {
      const name = outcomes[call++]
      return name ? Promise.reject(new DOMException("refused", name)) : apply.call(this, desc)
    })
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1", { media: ["video"] }) } } })
    await settle()
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("remote-1") } } })
    await settle()
    expect(applies(inputs).at(-1), "row 34: the retried offer refused with OperationError is hard-sdp at statement-offer-retried").toMatchObject({
      outcome: "rejected",
      site: "statement-offer-retried",
      reason: "hard-sdp",
    })
    // the retry ran on the rebuilt responder, and its refusal rebuilt nothing
    expect(FakePC.last, "row 34: the retry applied to the one rebuilt responder and did not rebuild again").toHaveLength(2)
    mesh.close()
  })
})