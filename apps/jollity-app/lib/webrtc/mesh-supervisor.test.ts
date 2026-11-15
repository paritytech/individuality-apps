// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The supervisor's due logic, with the peer actor driving (step 9; until then
 * these were the shadow comparisons of step 4.3 stage 3b, step 4). Each sweep
 * feeds the actor one clock fact per peer with the raw facts Mesh reads
 * there, and the actor decides each cause itself. Each scenario runs the real
 * Mesh on the fake RTCPeerConnection and checks what Mesh then does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PeerRoomRunner } from "../state-machines/peer-runner"
import { monoNow } from "./mesh"
import { backoffMs, SUPERVISOR_TIMING } from "./supervisor-timing"
import { actorEvents, FakeChannel, FakePC, setupMesh, actorTakesMeshTimes } from "./test-pc"

type Internals = {
  conns: Map<string, {
    pc: FakePC
    channel: FakeChannel | null
    away: "said" | "timeout" | null
    everConnected: boolean
    lastSignalAt: number
    firstHeardAt: number
    lastRecvDescAt: number
    offerSentAt: number
    yieldedAt: number
    upAt: number
    downAt: number
    disconnectedAt: number
  }>
  runner: PeerRoomRunner
  supervise: () => void
}

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
/** Mesh stamps its own clock on these fields: compare on it */
const now = () => monoNow()
/** Wait out the actor's backoff after `failures` failures, with the peer
 *  still heard. */
const outwait = (failures: number, conn: () => { lastSignalAt: number }) => {
  vi.advanceTimersByTime(backoffMs(failures))
  conn().lastSignalAt = now()
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
  return { ...made, internals, conn, events, inputs, away }
}

/** A link that was up with its lane open, and has now dropped. */
async function dropped(state: RTCPeerConnectionState = "disconnected") {
  const made = await driven()
  const { pc } = made
  pc.channels[0]!.readyState = "open"
  ;(pc.channels[0]!.onopen as () => void)()
  pc.connectionState = "connected"
  pc.onconnectionstatechange!()
  pc.connectionState = state
  pc.onconnectionstatechange!()
  made.conn().lastSignalAt = now()
  made.events.length = 0
  return made
}

describe("the supervisor's causes, decided by the peer actor from each sweep", () => {
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

  it("feeds the actor one clock fact per peer per sweep", async () => {
    const { mesh, internals, conn, inputs } = await dropped()
    conn().disconnectedAt = now() - 5_000
    internals.supervise()
    expect(inputs().filter((type) => type === "clock")).toHaveLength(1)
    mesh.close()
  })

  describe("recovery of a link that is not connected", () => {
    it("restarts ICE on a disconnected link past its grace, with the lane open", async () => {
      const { mesh, pc, internals, conn } = await dropped()
      conn().disconnectedAt = now() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })

    it("leaves a disconnected link alone inside its grace", async () => {
      const { mesh, pc, internals, conn } = await dropped()
      conn().disconnectedAt = now() - SUPERVISOR_TIMING.disconnectGraceMs
      internals.supervise()
      expect(pc.restartIce).not.toHaveBeenCalled()
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })

    it("rebuilds a disconnected link once its ICE restarts are spent", async () => {
      const { mesh, pc, internals, conn } = await dropped()
      conn().disconnectedAt = now() - 5_000
      for (let attempt = 0; attempt < SUPERVISOR_TIMING.restartTries; attempt++) {
        outwait(attempt, conn)
        internals.supervise()
      }
      expect(pc.restartIce).toHaveBeenCalledTimes(SUPERVISOR_TIMING.restartTries)
      outwait(SUPERVISOR_TIMING.restartTries, conn)
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(SUPERVISOR_TIMING.restartTries)
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("rebuilds a failed link", async () => {
      const { mesh, internals } = await dropped("failed")
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("waits out the backoff after an attempt, then acts", async () => {
      const { mesh, pc, internals, conn } = await dropped()
      conn().disconnectedAt = now() - 5_000
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      // one failure: the next attempt waits twice the base
      const attempted = internals.runner.state("b")!.lastAttemptAt!
      vi.advanceTimersByTime(SUPERVISOR_TIMING.backoffBaseMs * 2 - 1)
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(FakePC.last).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(now() - attempted).toBe(SUPERVISOR_TIMING.backoffBaseMs * 2)
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("does nothing in the background, and sends the actor no sweep", async () => {
      const { mesh, internals, inputs } = await dropped("failed")
      vi.stubGlobal("document", { visibilityState: "hidden" })
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      // a failed link the actor would rebuild: a sweep sent from the background would show here
      expect(inputs()).not.toContain("clock")
      mesh.close()
    })

    it("leaves a peer who said it left", async () => {
      const { mesh, internals, conn } = await dropped("failed")
      conn().away = "said"
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })

    it("stops chasing a peer not heard for a while whose link dropped long ago", async () => {
      const { mesh, internals, conn } = await dropped("failed")
      conn().lastSignalAt = now() - SUPERVISOR_TIMING.presenceFreshMs
      conn().downAt = now() - SUPERVISOR_TIMING.dropChaseMs
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      mesh.close()
    })

    it("rebuilds a link the initiator offered on that never connected, once it was heard long enough ago", async () => {
      const { mesh, internals, conn } = await driven("a", "b")
      conn().lastSignalAt = now()
      conn().firstHeardAt = now() - (SUPERVISOR_TIMING.initialTimeoutMs + 1)
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      vi.advanceTimersByTime(SUPERVISOR_TIMING.initialTimeoutMs)
      conn().lastSignalAt = now()
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("an answerer that heard the initiator's offer leaves the link to it", async () => {
      const { mesh, internals, conn } = await driven("b", "a")
      conn().lastSignalAt = now()
      conn().firstHeardAt = now() - 60_000
      conn().lastRecvDescAt = now() - 20_000
      vi.advanceTimersByTime(SUPERVISOR_TIMING.initialTimeoutMs)
      conn().lastSignalAt = now()
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      conn().lastRecvDescAt = -Infinity
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })
  })

  describe("a connected link whose channel never opened", () => {
    it("is rebuilt once a round, even for a peer who said it left", async () => {
      const { mesh, pc, internals, conn } = await driven()
      mesh.setRound(1)
      pc.connectionState = "connected"
      pc.onconnectionstatechange!()
      conn().away = "said"
      conn().upAt = now() - (SUPERVISOR_TIMING.connectedWithoutChannelMs - 1)
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      conn().upAt = now() - SUPERVISOR_TIMING.connectedWithoutChannelMs
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      const rebuilt = FakePC.last[1]!
      rebuilt.connectionState = "connected"
      rebuilt.onconnectionstatechange!()
      conn().upAt = now() - 60_000
      outwait(1, conn)
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })
  })

  describe("an unanswered statement offer, and the yield after it", () => {
    const overdue = async () => {
      const made = await driven("a", "b")
      await made.pc.onnegotiationneeded!()
      const conn = made.conn()
      conn.everConnected = true
      conn.lastSignalAt = now()
      made.pc.signalingState = "have-local-offer"
      return made
    }

    it("yields to the peer once the answer is overdue", async () => {
      const { mesh, internals, conn } = await overdue()
      conn().offerSentAt = now() - (SUPERVISOR_TIMING.answerWaitMs - 1)
      internals.supervise()
      expect(FakePC.last).toHaveLength(1)
      conn().offerSentAt = now() - SUPERVISOR_TIMING.answerWaitMs
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      expect(FakePC.last[1]!.channels).toHaveLength(0)
      mesh.close()
    })

    it("offers again when no offer came after the yield", async () => {
      const { mesh, internals, conn } = await overdue()
      conn().offerSentAt = now() - SUPERVISOR_TIMING.answerWaitMs
      internals.supervise()
      conn().lastSignalAt = now()
      conn().yieldedAt = now() - (SUPERVISOR_TIMING.answerWaitMs - 1)
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      conn().yieldedAt = now() - SUPERVISOR_TIMING.answerWaitMs
      internals.supervise()
      await settle()
      expect(FakePC.last).toHaveLength(3)
      expect(FakePC.last[2]!.channels).toHaveLength(1)
      mesh.close()
    })

    it("makes no offer after the yield when the connection already has a channel", async () => {
      const { mesh, internals, conn } = await overdue()
      conn().offerSentAt = now() - SUPERVISOR_TIMING.answerWaitMs
      internals.supervise()
      conn().lastSignalAt = now()
      conn().yieldedAt = now() - SUPERVISOR_TIMING.answerWaitMs
      conn().channel = new FakeChannel()
      internals.supervise()
      await settle()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })
  })

  describe("the actor's budgets on Mesh's sweeps (3c step 5)", () => {
    /** the answerer of a connected link */
    const healthy = async () => {
      const made = await driven("b", "a")
      made.pc.connectionState = "connected"
      made.pc.onconnectionstatechange!()
      return made
    }

    it("restart, wait out the backoff, then rebuild", async () => {
      const { mesh, pc, conn, internals } = await healthy()
      const channel = new FakeChannel()
      ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
      channel.readyState = "open"
      channel.onopen!()
      pc.connectionState = "disconnected"
      pc.onconnectionstatechange!()
      conn().lastSignalAt = now()
      conn().disconnectedAt = now() - 5_000
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      outwait(1, conn)
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })

    it("count every backoff from the instant the attempt was stamped, however long Mesh takes between its clock reads", async () => {
      const { mesh, pc, conn, internals, events } = await healthy()
      pc.connectionState = "failed"
      pc.onconnectionstatechange!()
      conn().lastSignalAt = now()
      // live, each clock read comes a little later than the one before: the
      // sweep's now, then the rebuild reading the clock again
      const read = performance.now.bind(performance)
      let drift = 0
      let step = 40
      vi.spyOn(performance, "now").mockImplementation(() => read() + (drift += step))
      internals.supervise()
      step = 0
      const actor = internals.runner.state("a")!
      // the attempt is the sweep's instant, which its tick carries
      const ticks = events.filter(({ event }) => event.type === "clock")
      expect(actor.lastAttemptAt).toBe(ticks.at(-1)!.event.now)
      // the next sweep lands exactly where the backoff after one failure ends
      conn().pc.connectionState = "failed"
      vi.advanceTimersByTime(actor.lastAttemptAt! + backoffMs(1) - now())
      conn().lastSignalAt = now()
      internals.supervise()
      expect(FakePC.last).toHaveLength(3)
      mesh.close()
    })

    it("reset when a page never marked away sweeps after a long absence (setSelfAway's kick)", async () => {
      const { mesh, pc, conn, internals } = await healthy()
      pc.connectionState = "failed"
      pc.onconnectionstatechange!()
      conn().lastSignalAt = now()
      internals.supervise()
      expect(internals.runner.state("a")!.budgets.failCount).toBe(1)
      mesh.setSelfAway(false, 9_000)
      expect(internals.runner.state("a")!.budgets.failCount).toBe(0)
      internals.supervise()
      mesh.close()
    })
  })

  describe("a link that stays down marks the peer away", () => {
    it("after AWAY_AFTER_MS, and keeps healing a peer still heard", async () => {
      const { mesh, pc, internals, conn, away } = await dropped()
      conn().disconnectedAt = now() - SUPERVISOR_TIMING.awayAfterMs
      conn().downAt = now() - SUPERVISOR_TIMING.awayAfterMs
      internals.supervise()
      expect(away).not.toHaveBeenCalled()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      outwait(1, conn)
      conn().downAt = now() - (SUPERVISOR_TIMING.awayAfterMs + 1)
      internals.supervise()
      expect(away).toHaveBeenCalledWith("b", "timeout")
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(FakePC.last).toHaveLength(2)
      mesh.close()
    })
  })

  it("rebuilds a connected link whose open lane brought no video with our camera off", async () => {
    const { mesh, pc, inputs } = await driven()
    // the no-video rebuild does not wait for our own camera
    const local = (mesh as unknown as { local: MediaStream }).local
    expect(local.getVideoTracks().some((track) => track.readyState === "live")).toBe(false)
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(8_000)
    pc.channels[0]!.readyState = "open"
    ;(pc.channels[0]!.onopen as () => void)()
    pc.stats = new Map() as never
    await vi.advanceTimersByTimeAsync(16_000)
    expect(FakePC.last).toHaveLength(2)
    expect(inputs()).toContain("stats-observed")
    mesh.close()
  })
})
