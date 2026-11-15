// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { monoNow } from "./mesh"
import { SUPERVISOR_TIMING } from "./supervisor-timing"
import { FakePC, sdp, setupMesh, actorTakesMeshTimes } from "./test-pc"

interface AwayPeriodEvent {
  kind: "away_period"
  reason: "said" | "timeout"
  return: string
  lastAttempt: string
  attempts: number
  offerer: "self" | "peer" | "none"
  offererRole?: "initiator" | "answerer"
  ms: number
}

type Conn = {
  pc: FakePC
  away: "said" | "timeout" | null
  lastSignalAt: number
  disconnectedAt: number
}

type Internals = {
  conns: Map<string, Conn>
  setAway(peerId: string, conn: Conn, away: "said" | "timeout"): void
  setAway(peerId: string, conn: Conn, away: null, cause: string): void
  supervise(): void
}

async function setup(myId = "a", peerId = "b") {
  const periods: AwayPeriodEvent[] = []
  const made = await setupMesh(myId, peerId, {
    onRtcEvent: (_peer, event) => {
      if ((event as { kind: string }).kind === "away_period") periods.push(event as AwayPeriodEvent)
    },
  })
  const internals = made.mesh as unknown as Internals
  // these scenarios back-date Mesh's times by hand: the actor takes them
  actorTakesMeshTimes(made.mesh)
  return { ...made, internals, conn: () => internals.conns.get(peerId)!, periods }
}

describe("the away-period record", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    ["offer", "peer", "answerer"],
    ["answer", "self", "initiator"],
  ] as const)("stamps a rebuild return from the closing statement %s", async (type, offerer, offererRole) => {
    const { mesh, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "timeout")
    conn().pc.connectionState = "failed"
    // a peer still heard: the actor's sweep rebuilds the failed link
    conn().lastSignalAt = monoNow()
    internals.supervise()
    expect(FakePC.last).toHaveLength(2)

    await mesh.onRtc("b", { rtc: { desc: { type, sdp: "v=0" } } } as never)

    expect(periods).toEqual([
      expect.objectContaining({
        reason: "timeout",
        return: "statement_description",
        lastAttempt: "rebuild",
        attempts: 1,
        offerer,
        offererRole,
      }),
    ])
    mesh.close()
  })

  it(
    "records a held remote session as session_rejoin before the actor closes the period",
    async () => {
      const { mesh, internals, conn, periods } = await setup()
      conn().pc.remoteDescription = { type: "offer", sdp: sdp("held-session") }
      internals.setAway("b", conn(), "timeout")

      await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: sdp("new-session") } } } as never)

      expect(periods).toEqual([
        expect.objectContaining({
          reason: "timeout",
          return: "session_rejoin",
        }),
      ])
      mesh.close()
    },
  )

  it("counts a restart that throws and falls through to rebuild as one recovery attempt", async () => {
    const { mesh, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "timeout")
    conn().pc.connectionState = "disconnected"
    const channel = conn().pc.channels[0]!
    channel.readyState = "open"
    ;(channel.onopen as () => void)()
    conn().pc.restartIce.mockImplementation(() => { throw new DOMException("closed", "InvalidStateError") })
    // a peer still heard, its link down past the grace: the actor's sweep
    // restarts ICE, and the throw falls through to its rebuild
    conn().lastSignalAt = monoNow()
    conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
    internals.supervise()
    expect(FakePC.last).toHaveLength(2)
    internals.setAway("b", conn(), null, "link_connected")

    expect(periods).toEqual([
      expect.objectContaining({
        lastAttempt: "rebuild",
        attempts: 1,
      }),
    ])
    mesh.close()
  })

  it("names a peer heard after a silence as heard_again", async () => {
    const { mesh, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "said")
    conn().lastSignalAt = monoNow() - 20_001

    mesh.markSeen("b")

    expect(periods).toEqual([expect.objectContaining({ reason: "said", return: "heard_again", offerer: "none" })])
    mesh.close()
  })

  it("uses the current local description only for link_connected", async () => {
    const { mesh, pc, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "timeout")
    pc.localDescription = { type: "offer", sdp: "old-pending-offer" }
    ;(pc as unknown as { currentLocalDescription: { type: string; sdp: string } }).currentLocalDescription = {
      type: "answer",
      sdp: "connected-answer",
    }

    pc.connectionState = "connected"
    pc.onconnectionstatechange!()

    expect(periods).toEqual([expect.objectContaining({
      return: "link_connected",
      offerer: "peer",
      offererRole: "answerer",
    })])
    mesh.close()
  })

  it("closes an open period once when removePeer is followed by mesh close", async () => {
    const { mesh, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "timeout")

    mesh.removePeer("b")
    mesh.close()

    expect(periods).toEqual([expect.objectContaining({ return: "peer_left" })])
  })

  it("closes an open period once when the mesh closes twice", async () => {
    const { mesh, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "timeout")

    mesh.close()
    mesh.close()

    expect(periods).toEqual([expect.objectContaining({ return: "mesh_closed" })])
  })

  it("emits one row for each period, not for repeated marks or returns", async () => {
    const { mesh, internals, conn, periods } = await setup()
    internals.setAway("b", conn(), "said")
    internals.setAway("b", conn(), "said")
    internals.setAway("b", conn(), null, "said_back")
    internals.setAway("b", conn(), null, "said_back")
    internals.setAway("b", conn(), "timeout")
    internals.setAway("b", conn(), null, "link_connected")

    expect(periods.map((period) => period.return)).toEqual(["said_back", "link_connected"])
    mesh.close()
  })
})
