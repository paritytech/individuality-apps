// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Hard in-band SDP failures are evidence from the browser, not a peer's
 * claim. They get one immediate peer-connection rebuild per round (#485). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import type { NegotiationErrorEvent } from "./rtc-events"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

const sendLane = (pc: FakePC, tag: "Offer" | "Answer", value: string) => {
  const channel = pc.channels[0]!
  const frame = encodeChannelMessage({
    id: USE_CASE_RENEGOTIATION,
    data: encodePeerConnectionSignal({ tag, value }),
  })
  ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}

const laneAnswer = async (pc: FakePC, answer = sdp("222", { media: ["video"] })) => {
  sendLane(pc, "Answer", answer)
  await Promise.resolve()
  await Promise.resolve()
}

const openLaneOffer = async (pc: FakePC) => {
  pc.channels[0]!.readyState = "open"
  await pc.onnegotiationneeded!()
}

describe("lane negotiation recovery (#485)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("rebuilds once when a lane answer cannot be applied, then the fresh link can carry video", async () => {
    const errors: NegotiationErrorEvent[] = []
    const streams: MediaStream[] = []
    const { mesh, pc } = await setupMesh(
      "a",
      "b",
      { onRtcEvent: (_peer, event) => event.kind === "negotiation_error" && errors.push(event) },
      undefined,
      (_peer, stream) => streams.push(stream),
    )
    mesh.setRound(1)
    await openLaneOffer(pc)
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(
      new DOMException("Failed to add remote stream ssrc: 4041477088 to mid 1", "InvalidAccessError"),
    )

    await laneAnswer(pc)
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
    expect(pc.close).toHaveBeenCalledOnce()
    expect(errors).toEqual([
      { kind: "negotiation_error", name: "InvalidAccessError", stage: "answer", operation: "set-remote", reason: "ssrc-collision" },
    ])

    const fresh = FakePC.last[1]!
    await openLaneOffer(fresh)
    await laneAnswer(fresh)
    const stream = {} as MediaStream
    fresh.ontrack!({ track: { kind: "video", addEventListener: () => {} }, streams: [stream] })
    expect(streams).toEqual([stream])
    mesh.close()
  })

  it("records a second hard failure in the round without rebuilding in a loop", async () => {
    const errors: NegotiationErrorEvent[] = []
    const { mesh, pc } = await setupMesh("a", "b", {
      onRtcEvent: (_peer, event) => event.kind === "negotiation_error" && errors.push(event),
    })
    mesh.setRound(1)
    await openLaneOffer(pc)
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("first", "InvalidAccessError"))
    await laneAnswer(pc)
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))

    const fresh = FakePC.last[1]!
    await openLaneOffer(fresh)
    vi.spyOn(fresh, "setRemoteDescription").mockRejectedValueOnce(new DOMException("second", "OperationError"))
    await laneAnswer(fresh)
    await Promise.resolve()

    expect(FakePC.last).toHaveLength(2)
    expect(errors.map(({ name }) => name)).toEqual(["InvalidAccessError", "OperationError"])
    mesh.close()
  })

  it.each([
    ["offer", "set-remote"],
    ["answer", "set-local"],
  ] as const)("rebuilds the deterministic answerer after a lane %s %s failure and lets its fresh PC offer", async (stage, operation) => {
    const errors: NegotiationErrorEvent[] = []
    const { mesh, pc } = await setupMesh("b", "a", {
      onRtcEvent: (_peer, event) => event.kind === "negotiation_error" && errors.push(event),
    })
    mesh.setRound(1)
    const channel = new FakeChannel()
    channel.readyState = "open"
    pc.channels.push(channel)
    ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
    if (operation === "set-remote")
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("offer refused", "InvalidAccessError"))
    else vi.spyOn(pc, "setLocalDescription").mockRejectedValueOnce(new DOMException("answer refused", "OperationError"))

    sendLane(pc, "Offer", sdp("111", { media: ["video"] }))
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))

    const fresh = FakePC.last[1]!
    expect(fresh.channels).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: "negotiation_error", stage, operation })
    mesh.close()
  })

  it("claims the budget before two concurrent rejections from the old connection can rebuild twice", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    await openLaneOffer(pc)
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValue(new DOMException("refused", "InvalidAccessError"))
    sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
    sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
    await Promise.resolve()
    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })

  it("does not let a rejection from an old round rebuild or spend the new round's budget", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    await openLaneOffer(pc)
    let reject!: (error: unknown) => void
    vi.spyOn(pc, "setRemoteDescription").mockImplementationOnce(
      () => new Promise<void>((_resolve, rejectPromise) => (reject = rejectPromise)),
    )
    sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
    mesh.setRound(2)
    reject(new DOMException("late", "InvalidAccessError"))
    await Promise.resolve()
    await Promise.resolve()
    expect(FakePC.last).toHaveLength(1)

    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("current", "InvalidAccessError"))
    sendLane(pc, "Answer", sdp("222", { media: ["video"] }))
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
    mesh.close()
  })

  it("keeps a spent budget across remove and re-add in the same round", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    await openLaneOffer(pc)
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("first", "InvalidAccessError"))
    await laneAnswer(pc)
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))

    mesh.removePeer("b")
    mesh.addPeer("b")
    const rejoined = FakePC.last[2]!
    await openLaneOffer(rejoined)
    vi.spyOn(rejoined, "setRemoteDescription").mockRejectedValueOnce(new DOMException("again", "InvalidAccessError"))
    await laneAnswer(rejoined)
    await Promise.resolve()
    expect(FakePC.last).toHaveLength(3)
    mesh.close()
  })

  it("does not rebuild for a non-qualifying lane error", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    await openLaneOffer(pc)
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new TypeError("bad test input"))
    await laneAnswer(pc)
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })

  it("renews the one-rebuild budget when the same mesh enters another round", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setRound(1)
    await openLaneOffer(pc)
    vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("round one", "InvalidStateError"))
    await laneAnswer(pc)
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))

    mesh.setRound(2)
    const second = FakePC.last[1]!
    await openLaneOffer(second)
    vi.spyOn(second, "setRemoteDescription").mockRejectedValueOnce(new DOMException("round two", "InvalidStateError"))
    await laneAnswer(second)
    await vi.waitFor(() => expect(FakePC.last).toHaveLength(3))
    mesh.close()
  })
})
