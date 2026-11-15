// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A NETWORK CHANGE repairs every link in place, never the room (#1020): a link
 * whose data channel is open restarts ICE over it, one whose channel is down
 * gets a fresh connection that offers whatever this side's role, and the
 * policy a network check picks (relay only) reaches every connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakePC, setupMesh } from "./test-pc"
import type { HealEvent } from "./heal"

const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const healsOf = (heals: HealEvent[]) => (_peer: string, { kind, ...event }: { kind: string }) => {
  if (kind === "heal") heals.push(event as unknown as HealEvent)
}

const open = (pc: FakePC) => {
  pc.channels[0]!.readyState = "open"
  ;(pc.channels[0]!.onopen as () => void)()
}

/** One finished gathering on `address`, the way the browser reports it. */
const gatherOn = (pc: FakePC, address: string) => {
  pc.iceGatheringState = "gathering"
  pc.onicegatheringstatechange!()
  pc.onicecandidate!({ candidate: { type: "host", address, candidate: `candidate:1 1 udp 1 ${address} 5000 typ host`, toJSON: () => ({}) } } as unknown as RTCPeerConnectionIceEvent)
  pc.iceGatheringState = "complete"
  pc.onicegatheringstatechange!()
}

describe("a network change", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("restarts ICE on a link whose channel is open, keeping the connection", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    open(pc)
    mesh.networkChanged()
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(FakePC.last).toHaveLength(1)
    mesh.close()
  })

  it("rebuilds a link whose channel is down, and the fresh one offers even from the answering side", async () => {
    // b answers a: without the network change it would wait for a's offer
    const { mesh, pc } = await setupMesh("b", "a")
    mesh.networkChanged()
    expect(FakePC.last).toHaveLength(2)
    const fresh = FakePC.last[1]!
    expect(fresh).not.toBe(pc)
    expect(fresh.channels).toHaveLength(1) // it opened the channel the offer carries
    mesh.close()
  })

  it("records the in-place repair as a network_change heal, healed when the link connects (#1020)", async () => {
    const heals: HealEvent[] = []
    const { mesh, pc } = await setupMesh("a", "b", { onRtcEvent: healsOf(heals) })
    open(pc)
    state(pc, "connected")
    mesh.networkChanged()
    await vi.advanceTimersByTimeAsync(1500)
    state(pc, "disconnected")
    state(pc, "connected")
    expect(heals).toHaveLength(1)
    expect(heals[0]).toMatchObject({ trigger: "network_change", action: "ice_restart", attempt: 1, healed: true, end: "connected" })
    expect(heals[0]!.healMs).toBeGreaterThanOrEqual(1500)
    mesh.close()
  })

  it("records a rebuilt link's network_change heal as not healed when the mesh closes first", async () => {
    const heals: HealEvent[] = []
    const { mesh } = await setupMesh("b", "a", { onRtcEvent: healsOf(heals) })
    mesh.networkChanged()
    mesh.close()
    expect(heals).toEqual([expect.objectContaining({ trigger: "network_change", action: "rebuild", healed: false, end: "mesh_closed" })])
  })

  // #1608, paseo g300 (two players, so this link was the game's whole video):
  // the connect-by rebuild came up on the phone's new address, and the first
  // gathering to report it was that link's own, the moment it connected. The
  // inferred repair rebuilt it, and video never came back.
  it("leaves a link that gathered on the new address alone when the change is inferred from it", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.addPeer("c")
    const other = FakePC.last[1]!
    gatherOn(other, "10.0.0.4") // the old network, never connected
    gatherOn(pc, "10.0.0.77") // the rebuilt link, on the new network
    // ICE connected, DTLS not yet: only its own address protects it
    state(pc, "connecting")
    mesh.networkChanged("10.0.0.77")
    expect(pc.restartIce).not.toHaveBeenCalled()
    expect(pc.close).not.toHaveBeenCalled()
    // the link still on the old address is repaired as before
    expect(FakePC.last).toHaveLength(3)
    expect(FakePC.last[2]).not.toBe(other)
    mesh.close()
  })

  // #1608, paseo g298: three links had reconnected after the drop when a
  // fourth found the new address; each was ICE-restarted back to checking.
  it("leaves a connected link alone on an inferred change, and restarts it on an announced one", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    open(pc)
    gatherOn(pc, "10.0.0.4")
    state(pc, "connected")
    mesh.networkChanged("10.0.0.77")
    expect(pc.restartIce).not.toHaveBeenCalled()
    mesh.networkChanged()
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    mesh.close()
  })

  // the control, paseo g303: a link that dropped on the old address is still
  // repaired when a new address shows up
  it("still restarts a disconnected link on the old address when the change is inferred", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    open(pc)
    gatherOn(pc, "10.0.0.4")
    state(pc, "connected")
    state(pc, "disconnected")
    mesh.networkChanged("10.0.0.77")
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    mesh.close()
  })

  it("puts every connection on relay only when the network check says so", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.setIcePolicy("relay")
    expect(pc.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceTransportPolicy: "relay" }))
    mesh.addPeer("c")
    // a link made after it takes the same policy
    mesh.setIcePolicy("relay")
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
    mesh.close()
  })
})
