// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Step 4.3, the last legacy-owned paths (PR 2), with the peer actor driving
 * (step 9; until then these were shadow comparisons): a new signalling
 * session on a connection that negotiated nothing, a kick with no visibility
 * change, and a peer coming back (setAway(null)).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeAway } from "./away-frame"
import { monoNow } from "./mesh"
import { SUPERVISOR_TIMING } from "./supervisor-timing"
import { actorEvents, FakeChannel, FakePC, sdp, setupMesh, actorTakesMeshTimes } from "./test-pc"

type Internals = {
  conns: Map<string, { pc: FakePC; channel: FakeChannel | null; away: "said" | "timeout" | null; lastSignalAt: number; downAt: number; disconnectedAt: number }>
  supervise: () => void
  setAway(peer: string, connection: unknown, away: "said" | "timeout" | null): void
}

async function driven(myId = "a", peerId = "b") {
  const away = vi.fn()
  const made = await setupMesh(myId, peerId, {
    decisionRoom: "g7",
    decisionRoomEpoch: 3,
    onAway: away,
  })
  const internals = made.mesh as unknown as Internals
  // these scenarios back-date Mesh's times by hand: the actor takes them
  actorTakesMeshTimes(made.mesh)
  const conn = () => internals.conns.get(peerId)!
  const events = actorEvents(made.mesh)
  /** the types of the events the actor stepped on */
  const inputs = () => events.map(({ event }) => event.type)
  return { ...made, internals, conn, inputs, away }
}

const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
/** the initiator's link up with its lane open */
async function up() {
  const made = await driven()
  const channel = made.pc.channels[0]!
  channel.readyState = "open"
  ;(channel.onopen as () => void)()
  state(made.pc, "connected")
  return { ...made, channel }
}
const say = (channel: FakeChannel, away: boolean) =>
  (channel.onmessage as (event: { data: unknown }) => void)({ data: encodeAway(away).buffer })

describe("the last legacy-owned paths, decided by the peer actor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("leaves a connection that negotiated nothing alone on a new signalling session", async () => {
    const { mesh, inputs } = await driven("b", "a")
    mesh.onPeerSession("a")
    expect(FakePC.last).toHaveLength(1)
    expect(inputs()).toContain("peer-session-changed")
    mesh.close()
  })

  it("still rebuilds a connection that negotiated", async () => {
    const { mesh } = await driven("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    mesh.onPeerSession("a")
    expect(FakePC.last).toHaveLength(2)
    mesh.close()
  })

  it("sweeps every link when a page never told it was away comes back after a long absence", async () => {
    const { mesh, internals, conn, away } = await up()
    state(conn().pc, "disconnected")
    conn().downAt = monoNow() - (SUPERVISOR_TIMING.awayAfterMs + 1)
    conn().disconnectedAt = conn().downAt
    conn().lastSignalAt = monoNow()
    internals.supervise() // marked away, and recovered
    expect(conn().away).toBe("timeout")
    mesh.setSelfAway(false, 20_000) // never told it was away: the same-state kick
    expect(away).toHaveBeenLastCalledWith("b", null)
    expect(conn().away).toBeNull()
    mesh.close()
  })

  it("takes a peer back from its word, and a link that comes back", async () => {
    const { mesh, conn, channel, away } = await up()
    say(channel, true)
    expect(conn().away).toBe("said")
    say(channel, false)
    expect(conn().away).toBeNull()
    expect(away.mock.calls).toEqual([["b", "said"], ["b", null]])
    mesh.close()
  })

  it("brings an away peer back with the rebuild for a new session's offer", async () => {
    const { mesh, internals, conn, away } = await driven("b", "a")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
    internals.setAway("a", conn(), "timeout")
    await mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("999") }, gen: "B.1" } }) // the peer reloaded while away
    expect(FakePC.last).toHaveLength(2)
    expect(conn().away).toBeNull()
    expect(away).toHaveBeenLastCalledWith("a", null)
    mesh.close()
  })

  it("brings an away peer back with the rebuild for a new session's answer", async () => {
    const { mesh, internals, pc, conn, away } = await driven("a", "b")
    await pc.onnegotiationneeded!()
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: sdp("111") } } })
    internals.setAway("b", conn(), "timeout")
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: sdp("999") } } }) // an answer from the peer's next boot
    expect(FakePC.last).toHaveLength(2)
    expect(conn().away).toBeNull()
    expect(away).toHaveBeenLastCalledWith("b", null)
    mesh.close()
  })

  it("clears a removed peer's away", async () => {
    const { mesh, conn, channel, away } = await up()
    say(channel, true)
    expect(conn().away).toBe("said")
    mesh.removePeer("b")
    expect(away).toHaveBeenLastCalledWith("b", null)
    mesh.close()
  })
})
