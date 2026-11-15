// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * #1583 item l, the network-all stall the two-phone explorer confirmed on real
 * Mesh (mesh-pair, anchor network-all, no fault): after a network change on
 * both phones, the polite side answers the initiator's lane offer and at once
 * sends its own (its ICE restart, held while the answer was being made). The
 * two lane frames arrive back to back, so the initiator is still applying the
 * answer when the offer lands: its PC reads have-local-offer, Mesh calls that
 * a collision (onLane: makingOffer || have-local-offer), and the impolite
 * side ignores the offer. Perfect negotiation's isSettingRemoteAnswerPending
 * is the missing case. Nothing answers the polite side's lane offer after
 * that (a lane offer has no answer deadline, ICE stays up, frames flow), so
 * the pair stays connected with an offer pending for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, decodeChannelMessage, decodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import { FakeChannel, sdp, setupMesh } from "./test-pc"

const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never

const sendLane = (channel: FakeChannel, tag: "Offer" | "Answer", value: string) => {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}

/** the renegotiation frames `channel` sent, by tag */
const laneSent = (channel: FakeChannel): string[] => channel.send.mock.calls.flatMap(([data]) => {
  try {
    const message = decodeChannelMessage(new Uint8Array(data as ArrayBuffer))
    return message.id === USE_CASE_RENEGOTIATION ? [decodePeerConnectionSignal(message.data).tag] : []
  } catch {
    return []
  }
})

describe("a lane offer that lands while our lane answer is still being applied (#1583)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // Seed 28's failure: the impolite initiator ignores the offer and never answers it.
  it("#1695 seed 28: the impolite initiator answers it once the answer is applied", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", answer(sdp("222")))
    const channel = pc.channels[0]!
    channel.readyState = "open"
    ;(channel.onopen as () => void)()
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    await vi.waitFor(() => expect(pc.signalingState).toBe("stable"))

    // our network changed: the ICE restart goes out as a lane offer
    mesh.networkChanged()
    await pc.onnegotiationneeded!()
    await vi.waitFor(() => expect(laneSent(channel)).toContain("Offer"))
    expect(pc.signalingState).toBe("have-local-offer")

    // b's answer is applied slowly: the browser holds the SRD
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const apply = pc.setRemoteDescription.bind(pc)
    let operations = Promise.resolve()
    vi.spyOn(pc, "setRemoteDescription").mockImplementation((desc) => {
      const operation = operations.then(async () => {
        if (desc.type === "answer") await held
        return apply(desc)
      })
      operations = operation.catch(() => {})
      return operation
    })
    // b answers, then offers its own restart, back to back on the lane
    sendLane(channel, "Answer", sdp("222", { ufrag: "u2" }))
    sendLane(channel, "Offer", sdp("222", { ufrag: "u3" }))
    release()

    // our answer to b's offer goes back on the lane, and both ends settle
    await vi.waitFor(() => expect(laneSent(channel).filter((tag) => tag === "Answer")).toHaveLength(1))
    expect(pc.remoteDescription?.sdp).toContain("a=ice-ufrag:u3")
    expect(pc.signalingState).toBe("stable")
    mesh.close()
  })
})
