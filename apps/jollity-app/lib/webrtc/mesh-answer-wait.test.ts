// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * AN OFFER NOBODY ANSWERS (#1020, game 270): after the far end reloaded, this
 * side rebuilt its link and offered on a fresh connection, and the answer
 * never arrived. The fresh connection restores `everConnected` from the link
 * that had worked, so the never-connected answer wait did not apply, and as
 * the impolite side it ignored every recovery offer the far end sent: a
 * deadlock for both rounds. An offer left unanswered for ANSWER_WAIT_MS is
 * recovered whatever `everConnected` says, and the record names it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, sdp, setupMesh } from "./test-pc"
import type { HealEvent } from "./heal"

const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const offer = (body: string) => ({ rtc: { desc: { type: "offer", sdp: body } } }) as never
const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never

describe("an offer left unanswered on a link that had connected", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** As a browser does: a connection that gets its first data channel fires
   *  negotiationneeded on its own, so a fresh PC that may offer DOES offer. */
  const browserNegotiation = () => {
    const create = FakePC.prototype.createDataChannel
    vi.spyOn(FakePC.prototype, "createDataChannel").mockImplementation(function (this: FakePC, label: string, options?: RTCDataChannelInit) {
      const channel = create.call(this, label, options)
      if (this.channels.length === 1) queueMicrotask(() => void this.onnegotiationneeded?.())
      return channel
    })
  }

  /** "a" (the initiator, so impolite) connected to "b", then the link failed
   *  when b reloaded, and a's rebuilt PC offered on its own: the answer to
   *  that offer never comes */
  async function stuckOffer() {
    browserNegotiation()
    const heals: HealEvent[] = []
    const made = await setupMesh("a", "b", { onRtcEvent: (_peer, { kind, ...event }) => kind === "heal" && heals.push(event as HealEvent) })
    const { mesh, pc } = made
    await vi.advanceTimersByTimeAsync(0)
    expect(pc.signalingState).toBe("have-local-offer")
    await mesh.onRtc("b", answer(sdp("111")))
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100)
    expect(FakePC.last).toHaveLength(2)
    expect(FakePC.last[1]!.signalingState).toBe("have-local-offer") // it offered by itself
    return { ...made, heals }
  }

  it("is recovered after the answer wait, even while the far end keeps offering, and the pair connects", async () => {
    const { mesh, heals } = await stuckOffer()
    // the reloaded far end offers again and again; each is glare to the impolite side
    for (let i = 0; i < 6; i++) {
      await mesh.onRtc("b", offer(sdp("222")))
      await vi.advanceTimersByTimeAsync(5000)
    }
    // ConnectBy wins over the unanswered-offer yield: rebuild as offerer.
    expect(FakePC.last).toHaveLength(3)
    const third = FakePC.last[2]!
    expect(third.channels).toHaveLength(1)
    expect(third.signalingState).toBe("have-local-offer")
    state(third, "connected")
    expect(FakePC.last).toHaveLength(3)
    expect(heals.map((event) => [event.trigger, event.action, event.healed, event.end])).toEqual([
      ["failed", "rebuild", false, "next_attempt"],
      ["never_connected", "rebuild", true, "connected"],
    ])
    mesh.close()
  })

  it("offers again itself when, after yielding, no offer of the far end's comes within the answer wait", async () => {
    const { mesh } = await stuckOffer()
    for (let i = 0; i < 7; i++) {
      await mesh.onRtc("b", { rtc: { cand: { candidate: "" } } } as never) // here, but sending no offer
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(FakePC.last).toHaveLength(3) // yielded
    for (let i = 0; i < 7; i++) {
      await mesh.onRtc("b", { rtc: { cand: { candidate: "" } } } as never)
      await vi.advanceTimersByTimeAsync(5000)
    }
    const last = FakePC.last.at(-1)!
    expect(FakePC.last.length).toBeGreaterThanOrEqual(4)
    expect(last.channels).toHaveLength(1)
    expect(last.signalingState).toBe("have-local-offer")
    mesh.close()
  })

  it("leaves a network change's in-place ICE restart alone: its offer rides the open channel, not the statement wire (#1069)", async () => {
    const heals: HealEvent[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onRtcEvent: (_peer, { kind, ...event }) => kind === "heal" && heals.push(event as HealEvent) })
    await pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(35_000) // the statement offer is past the answer wait by the time the restart goes out
    await mesh.onRtc("b", answer(sdp("111")))
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    state(pc, "connected")
    mesh.networkChanged()
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    pc.signalingState = "have-local-offer" // the restart's offer, out over the lane
    state(pc, "disconnected")
    // past the restart's backoff and onto a sweep
    await vi.advanceTimersByTimeAsync(6100)
    // no second recovery on top of the network change's: the restart keeps its chance
    expect(FakePC.last).toHaveLength(1)
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    state(pc, "connected")
    expect(heals.map((event) => [event.trigger, event.healed])).toEqual([["network_change", true]])
    mesh.close()
  })

  it("does not judge a lane offer by the statement answer wait when the channel then closes", async () => {
    const heals: HealEvent[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onRtcEvent: (_peer, { kind, ...event }) => kind === "heal" && heals.push(event as HealEvent) })
    await pc.onnegotiationneeded!()
    await vi.advanceTimersByTimeAsync(35_000) // the statement offer is past the answer wait
    await mesh.onRtc("b", answer(sdp("111")))
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    state(pc, "connected")
    await pc.onnegotiationneeded!() // a renegotiation: its offer rides the lane
    expect(pc.signalingState).toBe("have-local-offer")
    pc.channels[0]!.readyState = "closed"
    ;(pc.channels[0]!.onclose as () => void)()
    state(pc, "disconnected")
    await vi.advanceTimersByTimeAsync(3500) // one sweep, inside the disconnect grace
    expect(FakePC.last).toHaveLength(1)
    expect(heals.map((event) => event.trigger)).not.toContain("answer_timeout")
    mesh.close()
  })

  it("is left alone while the answer wait has not passed", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", answer(sdp("111")))
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100)
    const fresh = FakePC.last[1]!
    if (fresh.signalingState === "stable") await fresh.onnegotiationneeded!()
    for (let i = 0; i < 4; i++) {
      await mesh.onRtc("b", offer(sdp("222")))
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })
})
