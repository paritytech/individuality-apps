// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * An offer from a peer's new remote connection, read while the answer from
 * its old one is still being set (#1615, #1499 from the answer side). The
 * new-session check looked at the PC's remote description (none yet: the
 * answer's setRemoteDescription is pending) and at the answering entry (an
 * OFFER being answered only), saw no session, and put the new offer onto the
 * same PC behind the old answer, so the pair never rebuilt. The check now
 * also reads the session of the answer being set: the offer takes the
 * new-session rebuild, and the old answer settling late changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, sdp, setupMesh } from "./test-pc"

type Sent = { rtc: { desc?: { type: string; sdp?: string }; gen?: string } }
const descriptions = (signals: unknown[]) => (signals as Sent[]).filter((s) => s.rtc.desc).map((s) => ({ type: s.rtc.desc!.type, gen: s.rtc.gen }))

/** our offer to b, made and sent; then b's answer, whose setRemoteDescription waits for `release` */
async function offeredWithAnswerPending(answerSdp: string) {
  const made = await setupMesh("a", "b")
  const { mesh, pc, signals } = made
  await pc.onnegotiationneeded?.()
  expect(pc.signalingState).toBe("have-local-offer")
  signals.length = 0
  let release!: () => void
  const apply = pc.setRemoteDescription.bind(pc)
  vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce((desc) => new Promise<void>((resolve, reject) => {
    release = () => apply(desc).then(resolve, reject)
  }))
  void mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: answerSdp }, gen: "B.1" } })
  await vi.advanceTimersByTimeAsync(0)
  expect(pc.remoteDescription).toBeNull() // the answer is still being set
  return { ...made, release: () => release() }
}

describe("an offer from a new remote connection while the old one's answer is being set", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("rebuilds and answers the new offer on the fresh connection; the old answer settling late changes nothing", async () => {
    const { mesh, pc, signals, release } = await offeredWithAnswerPending(sdp("111"))
    void mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: sdp("222") }, gen: "B.2" } })
    await vi.advanceTimersByTimeAsync(2_000)

    expect(FakePC.last).toHaveLength(2)
    expect(pc.close).toHaveBeenCalled()
    const fresh = FakePC.last[1]
    expect(fresh.remoteDescription?.sdp).toBe(sdp("222"))
    expect(fresh.localDescription?.type).toBe("answer")
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "B.2" }])

    release() // the old connection's answer settles on the replaced PC
    // (within the fresh PC's connect-by deadline: FakePC never connects, so that rebuilds it later anyway)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakePC.last).toHaveLength(2)
    expect(fresh.remoteDescription?.sdp).toBe(sdp("222"))
    expect(descriptions(signals)).toEqual([{ type: "answer", gen: "B.2" }])
    mesh.close()
  })

  it("does not rebuild for an offer of the same remote connection as the answer being set", async () => {
    const { mesh, pc, release } = await offeredWithAnswerPending(sdp("111"))
    void mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: sdp("111", { ufrag: "u2" }) }, gen: "B.2" } })
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakePC.last).toHaveLength(1)
    expect(pc.close).not.toHaveBeenCalled()
    mesh.close()
  })

  it("applies a plain answer to our offer on the same connection, as before", async () => {
    const { mesh, pc, signals } = await setupMesh("a", "b")
    await pc.onnegotiationneeded?.()
    signals.length = 0
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: sdp("111") }, gen: "B.1" } })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(FakePC.last).toHaveLength(1)
    expect(pc.remoteDescription?.sdp).toBe(sdp("111"))
    expect(pc.signalingState).toBe("stable")
    expect(pc.close).not.toHaveBeenCalled()
    expect(descriptions(signals)).toEqual([])
    mesh.close()
  })
})
