// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Mesh replaces a peer's connection outside any actor command (rebuildAll and
 * the departed-session initiate) and tells the actor so with a
 * `connection-replaced-externally` fact. Each scenario runs the real Mesh on
 * the fake RTCPeerConnection with the peer actor driving, and checks that the
 * actor adopts the connection Mesh holds, through a supervisor sweep after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import type { PeerActorEvent } from "../state-machines/peer-actor"
import type { PeerRoomRunner } from "../state-machines/peer-runner"
import { actorEvents, FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

type Inputs = { peer: string; event: PeerActorEvent }[]

async function driven(myId: string, peerId: string, opts: Record<string, unknown> = {}) {
  const made = await setupMesh(myId, peerId, {
    decisionRoom: "g7",
    decisionRoomEpoch: 3,
    ...opts,
  })
  const internals = made.mesh as unknown as { runner: PeerRoomRunner; conns: Map<string, { decisionConnectionEpoch: number }> }
  /** the actor holds the connection Mesh holds */
  const owned = () => expect(internals.runner.state(peerId)!.connectionEpoch).toBe(internals.conns.get(peerId)!.decisionConnectionEpoch)
  return { ...made, inputs: actorEvents(made.mesh), owned }
}

/** the replacements Mesh reported to the actor, as the epochs they adopt */
const replacedExternally = (inputs: Inputs) =>
  inputs.flatMap(({ event }) => event.type === "connection-replaced-externally" ? [event.connectionEpoch] : [])

/** one supervisor sweep */
const sweep = (mesh: unknown) => (mesh as { supervise(): void }).supervise()
const offer = (body: string) => ({ rtc: { desc: { type: "offer", sdp: body } } }) as never
const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
async function lane(channel: FakeChannel, tag: "Offer" | "Answer", value: string) {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
  await vi.advanceTimersByTimeAsync(0)
}

describe("a connection Mesh replaces outside an actor command reaches the peer actor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("rebuildAll (an ICE policy change) of a link that is not up", async () => {
    const { mesh, inputs, owned } = await driven("a", "b")
    mesh.rebuildAll()
    expect(FakePC.last).toHaveLength(2)
    expect(replacedExternally(inputs)).toEqual([2])
    await vi.advanceTimersByTimeAsync(0)
    sweep(mesh)
    owned()
    mesh.close()
  })

  it("the departed-session initiate on first contact", async () => {
    const { mesh, pc, inputs, owned } = await driven("b", "a")
    await mesh.onRtc("a", offer(sdp("111")))
    const channel = new FakeChannel()
    channel.readyState = "open"
    ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
    await lane(channel, "Offer", sdp("111", { media: ["audio", "video"] }))
    state(pc, "connected")
    await mesh.onRtc("a", offer(sdp("222")))
    mesh.removePeer("a")

    await mesh.onRtc("a", offer(sdp("111")))

    expect(FakePC.last).toHaveLength(4)
    expect(FakePC.last[3]!.channels).toHaveLength(1)
    expect(replacedExternally(inputs).at(-1)).toBe(FakePC.last.length)
    await vi.advanceTimersByTimeAsync(0)
    sweep(mesh)
    owned()
    mesh.close()
  })
})
