// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PeerActorCommand } from "../state-machines/peer-actor"
import { remoteSessionOf } from "./mesh"
import { FakeChannel, FakePC, setupMesh } from "./test-pc"

// These tests deliberately inspect the host seam: the surviving mutants were
// in Mesh's execution of actor decisions, not in the actor reducer itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internals = any

const cameraTrack = { kind: "video", readyState: "live", enabled: true, muted: false }
const camera = { getVideoTracks: () => [cameraTrack], getTracks: () => [cameraTrack] }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe("Mesh mutation gaps (its execution of the peer actor's commands)", () => {
  const meshes: Array<{ close(): void }> = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    for (const mesh of meshes.splice(0)) mesh.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const made = async (myId = "a", peerId = "b", opts: Record<string, unknown> = {}, local: unknown = camera) => {
    const value = await setupMesh(myId, peerId, opts, local)
    meshes.push(value.mesh)
    return { ...value, internals: value.mesh as Internals, conn: () => (value.mesh as Internals).conns.get(peerId) }
  }

  it("identifies a remote session from either identity field and rejects an SDP with neither", () => {
    expect(remoteSessionOf("o=- 42 2 IN IP4 0.0.0.0\r\n")).toBe("42|")
    expect(remoteSessionOf("a=fingerprint:sha-256 aa:bb\r\n")).toBe("|SHA-256 AA:BB")
    expect(remoteSessionOf("v=0\r\ns=-\r\n")).toBeNull()
  })

  it("keeps a tracked actor promise until it settles, then removes only that work set", async () => {
    const { internals } = await made()
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    expect(internals.track("b", pending)).toBe(pending)
    const set = internals.actorWork.get("b")
    expect(set).toEqual(new Set([pending]))
    const settled = internals.settleActorWork("b")
    expect(internals.actorWork.get("b")).toBe(set)
    resolve()
    await settled
    expect(internals.actorWork.has("b")).toBe(false)
  })

  it("does not let an old tracked promise delete a replacement work set", async () => {
    const { internals } = await made()
    let resolve!: () => void
    const pending = new Promise<void>((done) => { resolve = done })
    internals.track("b", pending)
    const replacement = new Set<Promise<unknown>>()
    internals.actorWork.set("b", replacement)
    resolve()
    await flush()
    expect(internals.actorWork.get("b")).toBe(replacement)
  })

  it("keeps a stash replacement installed by the dispatched effect", async () => {
    const { internals } = await made()
    const map = new Map<string, object>()
    const first = {}
    const replacement = {}
    internals.withStash(map, "b", first, () => map.set("b", replacement))
    expect(map.get("b")).toBe(replacement)

    internals.withStash(map, "b", first, () => {})
    expect(map.has("b")).toBe(false)
  })

  it("treats ICE policy and relay transports together as the idempotency key", async () => {
    const { mesh, pc } = await made("a", "b", { relayProtocols: ["udp"] })
    pc.setConfiguration.mockClear()

    mesh.setIcePolicy("all", ["udp"])
    expect(pc.setConfiguration).not.toHaveBeenCalled()

    mesh.setIcePolicy("all", ["tcp"])
    expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
  })

  it("uses an empty relay-protocol list when setIcePolicy omits it", async () => {
    const { mesh, internals } = await made("a", "b", { relayProtocols: ["udp"] })
    mesh.setIcePolicy("relay")
    expect(internals.relayProtocols).toEqual([])
  })

  it("holds makingOffer across a pending statement offer and treats the presence boundary as absent", async () => {
    const { internals, conn, pc } = await made()
    let resolve!: () => void
    pc.setLocalDescription = vi.fn(() => new Promise<void>((done) => { resolve = () => {
      pc.localDescription = { type: "offer", sdp: "v=0" }
      pc.signalingState = "have-local-offer"
      done()
    } }))
    conn().lastSignalAt = performance.now() - 30_000
    const sent = vi.spyOn(conn().offer, "sent")
    const work = internals.makeStatementOffer("b", conn())
    expect(conn().makingOffer).toBe(true)
    resolve()
    await work
    expect(conn().makingOffer).toBe(false)
    expect(sent).toHaveBeenCalledWith("statement", expect.any(Number), false)
  })

  it("returns the rollback refusal and succeeds only while the stripped offer is still current", async () => {
    const { internals, pc } = await made()
    const refusal = new DOMException("no", "InvalidStateError")
    pc.setLocalDescription = vi.fn().mockRejectedValueOnce(refusal)
    await expect(internals.rollbackLocal(pc, 7)).resolves.toMatchObject({ outcome: "rejected", site: "lane", roundGeneration: 7, error: refusal })

    pc.signalingState = "stable"
    Object.assign(pc, { createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "v=0" }) })
    pc.setLocalDescription = vi.fn(async (desc) => {
      pc.localDescription = desc
      pc.signalingState = "have-local-offer"
    })
    await expect(internals.stripAndSetOffer("b", pc, 8)).resolves.toEqual({ outcome: "resolved" })

    pc.signalingState = "have-remote-offer"
    await expect(internals.stripAndSetOffer("b", pc, 9)).resolves.toEqual({ outcome: "stale", site: "lane" })
  })

  it("changes standby once in each direction and sends the corresponding camera choice", async () => {
    const { mesh, internals, conn } = await made()
    const execute = vi.spyOn(internals, "executePeerCommand")

    mesh.setStandby("b", true)
    expect(internals.standbyPeers.has("b")).toBe(true)
    expect(conn().standby).toBe(true)
    expect(execute).toHaveBeenLastCalledWith("b", expect.objectContaining({ kind: "replace-video-track", track: null }))
    const calls = execute.mock.calls.length

    mesh.setStandby("b", true)
    expect(execute).toHaveBeenCalledTimes(calls)

    mesh.setStandby("b", false)
    expect(internals.standbyPeers.has("b")).toBe(false)
    expect(execute).toHaveBeenLastCalledWith("b", expect.objectContaining({ kind: "replace-video-track", track: "camera" }))
  })

  it("does not repair or rebuild links after the room has closed", async () => {
    const { mesh, internals, pc } = await made()
    internals.closed = true
    const before = FakePC.last.length

    mesh.networkChanged()
    mesh.rebuildAll()

    expect(pc.restartIce).not.toHaveBeenCalled()
    expect(FakePC.last).toHaveLength(before)
  })

  it("marks a said-away peer back with the said-return hold and restarts a down clock", async () => {
    const onAway = vi.fn()
    const { internals, conn } = await made("a", "b", { onAway })
    conn().away = "said"
    conn().downAt = 1
    const resume = vi.spyOn(internals, "startResume")

    internals.markBack("b", conn(), "said_back", "answerer")

    expect(conn().away).toBeNull()
    expect(conn().downAt).toBeGreaterThanOrEqual(60_000)
    expect(conn().healHoldUntil).toBeGreaterThan(60_000)
    expect(resume).toHaveBeenCalledWith(conn(), "peer", conn().downAt)
    expect(onAway).toHaveBeenCalledWith("b", null)
  })

  it("does not apply said-return bookkeeping to a timeout-away peer", async () => {
    const { internals, conn } = await made()
    conn().away = "timeout"
    conn().downAt = 0
    const resume = vi.spyOn(internals, "startResume")
    internals.markBack("b", conn(), "heard_again")
    expect(resume).not.toHaveBeenCalled()
    expect(conn().downAt).toBe(0)
  })

  it("carries hidden duration to the actor, writes only open lanes, and never sweeps a closed room", async () => {
    const { mesh, internals, conn } = await made()
    const channel = new FakeChannel()
    channel.readyState = "open"
    conn().channel = channel
    const reduce = vi.spyOn(internals.runner, "dispatch")
    const supervise = vi.spyOn(internals, "supervise")

    mesh.setSelfAway(true, 123)
    expect(reduce).toHaveBeenCalledWith("b", expect.objectContaining({ type: "visibility-changed", hidden: true, hiddenForMs: 123 }))
    expect(channel.send).toHaveBeenCalledOnce()

    internals.closed = true
    internals.sweepAfterKick()
    expect(supervise).not.toHaveBeenCalled()
  })

  it("rebuildAll leaves a connected link intact and externally replaces a down link", async () => {
    const connected = await made("a", "b")
    connected.pc.connectionState = "connected"
    const first = FakePC.last.length
    connected.mesh.rebuildAll()
    expect(FakePC.last).toHaveLength(first)

    connected.pc.connectionState = "failed"
    connected.mesh.rebuildAll()
    expect(FakePC.last).toHaveLength(first + 1)
    expect(connected.internals.runner.state("b").connectionEpoch).toBe(connected.conn().decisionConnectionEpoch)
  })

  it("a stale actor command cannot touch the current connection", async () => {
    const { internals, conn, pc } = await made()
    const result = internals.executePeerCommand("b", {
      kind: "restart-ice",
      cause: "network-change",
      commandEpoch: 1,
      connectionEpoch: conn().decisionConnectionEpoch + 1,
    } satisfies PeerActorCommand)

    expect(result).toEqual({ outcome: "stale" })
    expect(pc.restartIce).not.toHaveBeenCalled()
  })

  it.each([[null, true], ["camera", false]] as const)("maps replace-video-track %s to standby=%s", async (track, standby) => {
    const { internals, conn } = await made()
    const apply = vi.spyOn(internals, "applyStandby").mockImplementation(() => {})
    internals.executePeerCommand("b", {
      kind: "replace-video-track",
      track,
      commandEpoch: 1,
      connectionEpoch: conn().decisionConnectionEpoch,
    })
    expect(apply).toHaveBeenCalledWith("b", conn(), standby)
  })

  it("marks back only a timeout-away peer during an actor sweep", async () => {
    const { internals, conn } = await made()
    const mark = vi.spyOn(internals, "markBack").mockImplementation(() => {})
    const command = { kind: "sweep", commandEpoch: 1, connectionEpoch: conn().decisionConnectionEpoch }
    conn().away = "said"
    internals.executePeerCommand("b", command)
    expect(mark).not.toHaveBeenCalled()
    conn().away = "timeout"
    internals.executePeerCommand("b", command)
    expect(mark).toHaveBeenCalledWith("b", conn(), "own_absence_sweep")
  })

  it("uses the stored return cause and offerer for an actor mark-back", async () => {
    const { internals, conn } = await made()
    internals.awayReturns.set("b", { cause: "session_rejoin", offerer: "answerer" })
    const mark = vi.spyOn(internals, "markBack").mockImplementation(() => {})
    internals.executePeerCommand("b", { kind: "mark-back", commandEpoch: 1, connectionEpoch: conn().decisionConnectionEpoch })
    expect(mark).toHaveBeenCalledWith("b", conn(), "session_rejoin", "answerer")
  })

  it("the close command closes the channel and PC through the room-close path", async () => {
    const { internals, conn, pc } = await made()
    const channel = new FakeChannel()
    conn().channel = channel
    internals.closed = true

    internals.executePeerCommand("b", {
      kind: "close-connection",
      commandEpoch: 1,
      connectionEpoch: conn().decisionConnectionEpoch,
    } satisfies PeerActorCommand)

    expect(channel.close).toHaveBeenCalledOnce()
    expect(pc.close).toHaveBeenCalledOnce()
    expect(internals.closedByActor.has(conn())).toBe(true)
  })

  it("the remove command drops the peer rather than taking the room-close path", async () => {
    const { internals, conn, pc } = await made()
    const current = conn()

    internals.executePeerCommand("b", {
      kind: "close-connection",
      commandEpoch: 1,
      connectionEpoch: current.decisionConnectionEpoch,
    } satisfies PeerActorCommand)

    expect(pc.close).toHaveBeenCalledOnce()
    expect(internals.conns.has("b")).toBe(false)
    expect(internals.closedByActor.has(current)).toBe(false)
  })

  it.each([
    ["failed", "beginRecoveryRebuild"],
    ["soft-disconnect", "beginRecoveryRebuild"],
    ["connect-by-deadline", "beginRecoveryRebuild"],
    ["channel-never-opened", "beginChannelStallRebuild"],
    ["connected-no-video", "beginNoVideoRebuild"],
    ["media-stall", "beginStallHeal"],
    ["supervisor-recovery-restart-failed", "beginRecoveryRebuild"],
    ["stranded-yield-unanswered", "beginStrandedInitiate"],
    ["stranded-offer-refused", "beginStrandedInitiate"],
    ["description-session-rejoin", "beginRejoin"],
    ["signalling-session-rejoin", "beginRejoin"],
    ["offer-refused-rejoin", "beginRejoin"],
    ["hard-sdp-immediate", "beginNegotiationRebuild"],
    ["hard-sdp-unseen", "beginNegotiationRebuild"],
    ["peer-no-video-hard-sdp", "beginNegotiationRebuild"],
    ["lane-glare-video", "beginGlareRebuild"],
    ["network-change", "beginNetworkRepair"],
    ["network-change-restart-failed", "beginNetworkRebuild"],
  ] as const)("runs the %s replacement's cause-specific host step", async (cause, expected) => {
    const { internals, conn } = await made("b", "a")
    const current = conn()
    const watched = [
      "beginRecoveryRebuild",
      "beginChannelStallRebuild",
      "beginNoVideoRebuild",
      "beginStallHeal",
      "beginStrandedInitiate",
      "beginRejoin",
      "beginNegotiationRebuild",
      "beginGlareRebuild",
      "beginNetworkRepair",
      "beginNetworkRebuild",
    ]
    const spies = Object.fromEntries(watched.map((name) => [name, vi.spyOn(internals, name)])) as Record<string, ReturnType<typeof vi.spyOn>>
    vi.spyOn(internals, "rebuildPeer").mockImplementation(() => {})
    vi.spyOn(internals, "heardOnFresh").mockImplementation(() => {})

    const command = {
      kind: "replace-connection",
      cause,
      initiate: true,
      answererMayOffer: cause === "signalling-session-rejoin" ? true : undefined,
      heal: 3,
      attempt: 2,
      at: 50_000,
      commandEpoch: 9,
      connectionEpoch: current.decisionConnectionEpoch + 1,
    }
    internals.replaceForActor("a", current, command, command.answererMayOffer === true)

    expect(spies[expected], `${cause} → ${expected}`).toHaveBeenCalled()
    expect(internals.rebuildPeer).toHaveBeenCalledWith("a", true)
    const rejoin = ["description-session-rejoin", "signalling-session-rejoin", "offer-refused-rejoin"].includes(cause)
    const stranded = ["stranded-yield-unanswered", "stranded-offer-refused"].includes(cause)
    expect(internals.heardOnFresh).toHaveBeenCalledTimes(rejoin || stranded ? 1 : 0)
    if (cause === "description-session-rejoin") expect(spies.beginRejoin).toHaveBeenCalledWith("a", "session_rejoin")
    if (cause === "offer-refused-rejoin") expect(spies.beginRejoin).toHaveBeenCalledWith("a", "offer_refused_rejoin")
    if (cause === "signalling-session-rejoin") expect(internals.answererMayOffer.has("a")).toBe(true)
  })

  it("an answer-timeout replacement has no second cause-specific host step", async () => {
    const { internals, conn } = await made()
    const current = conn()
    const begin = vi.spyOn(internals, "beginYield")
    vi.spyOn(internals, "rebuildPeer").mockImplementation(() => {})
    vi.spyOn(internals, "heardOnFresh").mockImplementation(() => {})

    internals.replaceForActor("b", current, {
      kind: "replace-connection",
      cause: "answer-timeout-yield",
      initiate: false,
      commandEpoch: 2,
      connectionEpoch: current.decisionConnectionEpoch + 1,
    })

    expect(begin).not.toHaveBeenCalled()
    expect(internals.heardOnFresh).not.toHaveBeenCalled()
    expect(internals.rebuildPeer).toHaveBeenCalledWith("b", false)
  })

  it.each([
    ["soft-disconnect", "letAnswererRecover", "beginRecoveryRestart"],
    ["network-change", "beginNetworkRepair", "networkRestarted"],
    ["media-stall", "beginStallHeal", "heal"],
    ["peer-no-video", "beginUnseenRestart", "heal"],
  ] as const)("runs the %s restart's host steps", async (cause, before, after) => {
    const { internals, conn, pc } = await made()
    const current = conn()
    const beforeSpy = vi.spyOn(internals, before)
    const network = vi.spyOn(internals, "networkRestarted")
    const heal = vi.spyOn(internals.heal, "begin")

    const result = internals.restartForActor("b", current, {
      kind: "restart-ice",
      cause,
      heal: 2,
      attempt: 3,
      at: 50_000,
      commandEpoch: 4,
      connectionEpoch: current.decisionConnectionEpoch,
    })

    expect(beforeSpy).toHaveBeenCalled()
    expect(pc.restartIce).toHaveBeenCalledOnce()
    const site = cause === "soft-disconnect" ? "supervisor-recovery" : cause
    expect(result).toEqual({ outcome: "resolved", site })
    if (after === "networkRestarted") expect(network).toHaveBeenCalled()
    else expect(heal).toHaveBeenCalled()
  })

  it("rejects a restart when the browser exposes no restartIce function", async () => {
    const { internals, conn } = await made()
    const current = conn()
    current.pc.restartIce = undefined

    const recover = vi.spyOn(internals, "letAnswererRecover")

    expect(internals.restartForActor("b", current, {
      kind: "restart-ice",
      cause: "soft-disconnect",
      commandEpoch: 1,
      connectionEpoch: current.decisionConnectionEpoch,
    })).toEqual({ outcome: "rejected", site: "supervisor-recovery" })
    expect(recover).toHaveBeenCalledWith("b")
  })

  it("records the precise recovery permissions and bookkeeping boundaries", async () => {
    const answerer = await made("b", "a")
    answerer.internals.letAnswererRecover("a")
    expect(answerer.internals.answererMayOffer.has("a")).toBe(true)

    const initiator = await made("a", "b")
    initiator.internals.letAnswererRecover("b")
    expect(initiator.internals.answererMayOffer.has("b")).toBe(false)

    const current = answerer.conn()
    current.framesStalls = 3
    answerer.internals.beginStallHeal("a", current, 55_000, false, 1)
    expect(current.lastMediaHealAt).toBe(55_000)
    expect(current.framesStalls).toBe(0)
    expect(answerer.internals.answererMayOffer.has("a")).toBe(true)

    answerer.internals.beginNoVideoRebuild("a", current, 56_000)
    expect(current.lastMediaHealAt).toBe(56_000)
  })

  it("stamps a fresh rejoin connection as heard and endpoint-bearing", async () => {
    const onLinkChange = vi.fn()
    const { internals, conn } = await made("a", "b", { onLinkChange })
    conn().lastSignalAt = 1
    conn().gaveEndpoint = false
    internals.heardOnFresh("b", conn())
    expect(conn().lastSignalAt).toBeGreaterThanOrEqual(60_000)
    expect(conn().gaveEndpoint).toBe(true)
    expect(onLinkChange).toHaveBeenCalledWith("b")
  })

  it("keeps only eight departed sessions and evicts the oldest at nine", async () => {
    const { internals } = await made()
    for (let i = 1; i <= 9; i++) internals.leaveSession("b", `session-${i}`)
    expect([...internals.leftSessions.get("b")]).toEqual([
      "session-2", "session-3", "session-4", "session-5", "session-6", "session-7", "session-8", "session-9",
    ])
  })

  it("a rebuild ends answering, closes the old channel, and preserves peer clocks", async () => {
    const { internals, conn, pc } = await made()
    const old = conn()
    old.lastSignalAt = 123
    old.downAt = 456
    old.away = "timeout"
    old.channel = new FakeChannel()
    const end = vi.spyOn(internals, "endAnswering")
    const close = vi.spyOn(internals, "closeChannel")
    internals.rebuildPeer("b", true, true)
    expect(end).toHaveBeenCalledWith("b")
    expect(close).toHaveBeenCalledWith(old)
    expect(pc.close).toHaveBeenCalledOnce()
    expect(conn()).toMatchObject({ lastSignalAt: 123, downAt: 456, away: "timeout" })
  })

  it("a departed-session stranded rebuild is external and stamps the fresh endpoint", async () => {
    const { internals, conn } = await made()
    const current = conn()
    vi.spyOn(internals, "strandedEligible").mockReturnValue(true)
    vi.spyOn(internals, "offerOnStatement").mockResolvedValue(undefined)
    const rebuild = vi.spyOn(internals, "rebuildPeer").mockImplementation(() => {})
    const fresh = { ...current }
    internals.conns.set("b", fresh)
    const heard = vi.spyOn(internals, "heardOnFresh").mockImplementation(() => {})
    const channel = vi.spyOn(internals, "createOfferChannel").mockImplementation(() => {})

    await expect(internals.initiateStrandedPeer("b", current, "late", "departed-session-offer")).resolves.toBe(true)
    expect(rebuild).toHaveBeenCalledWith("b", false, true)
    expect(heard).toHaveBeenCalledWith("b", fresh)
    expect(channel).toHaveBeenCalledWith("b", fresh)
  })

  it("ends only the answering entry that still owns the peer", async () => {
    const { internals, conn } = await made()
    const first = internals.beginAnswering("b", conn(), "one")
    const second = internals.beginAnswering("b", conn(), "two")
    const settle = vi.spyOn(second, "settle")
    internals.endAnswering("b", first)
    expect(internals.answering.get("b")).toBe(second)
    expect(settle).not.toHaveBeenCalled()
    internals.endAnswering("b", second)
    expect(internals.answering.has("b")).toBe(false)
    expect(settle).toHaveBeenCalledOnce()
  })

  it("applies lane answers and records only resolved lane offers for answering", async () => {
    const { internals, conn } = await made()
    internals.laneInbound.set("b", { type: "answer", sdp: "answer", generation: 2 })
    const answer = vi.spyOn(internals, "applyLaneAnswer").mockResolvedValue({ outcome: "resolved" })
    await expect(internals.applyRemoteForActor("b", conn(), true)).resolves.toEqual({ outcome: "resolved" })
    expect(answer).toHaveBeenCalledWith("b", conn(), "answer", 2)

    const offer = { type: "offer", sdp: "offer", generation: 3 }
    internals.laneInbound.set("b", offer)
    vi.spyOn(internals, "applyLaneOffer").mockResolvedValue({ outcome: "resolved" })
    await expect(internals.applyRemoteForActor("b", conn(), true)).resolves.toEqual({ outcome: "resolved" })
    expect(internals.laneAnswering.get("b")).toBe(offer)
  })

  it("consumes refused and answering entries exactly once", async () => {
    const { internals, conn } = await made()
    const refused = { entry: { desc: { type: "offer", sdp: "x" }, gen: "g" }, epoch: conn().decisionConnectionEpoch - 1 }
    internals.refusedOffers.set("b", refused)
    const apply = vi.spyOn(internals, "applyStatementOffer").mockResolvedValue({ outcome: "resolved" })
    await internals.applyRemoteForActor("b", conn(), false)
    expect(internals.refusedOffers.has("b")).toBe(false)
    expect(apply).toHaveBeenCalledWith("b", conn(), refused.entry, true)

    const lane = { type: "offer", generation: 4 }
    internals.laneAnswering.set("b", lane)
    vi.spyOn(internals, "answerLane").mockResolvedValue({ outcome: "resolved" })
    await internals.answerForActor("b", conn(), true)
    expect(internals.laneAnswering.has("b")).toBe(false)

    internals.statementAnswering.set("b", { applied: 1, gen: "g" })
    const send = vi.spyOn(internals, "sendStatementAnswer").mockResolvedValue("stale")
    await expect(internals.answerForActor("b", conn(), false)).resolves.toEqual({ outcome: "stale", site: "statement-answer" })
    expect(internals.statementAnswering.has("b")).toBe(false)
    // our own offer took the answer's place: stamped for the actor (#1606)
    internals.statementAnswering.set("b", { applied: 1, gen: "g" })
    send.mockResolvedValue("displaced")
    await expect(internals.answerForActor("b", conn(), false)).resolves.toEqual({ outcome: "stale", site: "statement-answer", displaced: true })
  })

  it("selects codec-guard, glare, stale-guard and superseded rollback paths precisely", async () => {
    const { internals, conn } = await made()
    const guard = { pc: conn().pc, generation: 1, offered: false, rollback: Promise.resolve({ outcome: "resolved" }), done: vi.fn() }
    internals.codecGuards.set("b", guard)
    const guarded = vi.spyOn(internals, "guardOfferForActor").mockResolvedValue({ outcome: "resolved" })
    await internals.offerForActor("b", conn(), true)
    expect(guard.offered).toBe(true)
    expect(guarded).toHaveBeenCalledWith("b", conn(), guard)

    expect(internals.rollbackForActor("b", conn(), "glare")).toEqual({ outcome: "resolved" })
    internals.codecGuards.set("b", { ...guard, pc: {}, rollback: undefined })
    expect(internals.rollbackForActor("b", conn(), "codec-guard")).toEqual({ outcome: "stale", site: "lane" })

    // Mesh never reports a superseded offer, so it has none to roll back
    const rollback = vi.spyOn(internals, "rollbackLocal")
    expect(internals.rollbackForActor("b", conn(), "superseded")).toEqual({ outcome: "stale", site: "lane" })
    expect(rollback).not.toHaveBeenCalled()
  })

  it("a codec guard reports whether the actor offered and resolves current only for a resolved replacement", async () => {
    const { internals, conn } = await made()
    vi.spyOn(internals, "codecGuardNeeded").mockReturnValue(true)
    vi.spyOn(internals, "observePeerInput").mockImplementation((_peer, _site, _conn, _event) => {})
    await expect(internals.guardOfferRtxByActor("b", conn(), 1)).resolves.toBe(false)

    const done = vi.fn()
    vi.spyOn(internals, "stripAndSetOffer").mockResolvedValue({ outcome: "resolved" })
    const resolvedGuard = { pc: conn().pc, generation: 1, offered: true, rollback: Promise.resolve({ outcome: "resolved" }), done }
    await expect(internals.guardOfferForActor("b", conn(), resolvedGuard)).resolves.toEqual({ outcome: "resolved" })
    expect(done).toHaveBeenCalledWith(true)

    const staleDone = vi.fn()
    const staleGuard = { ...resolvedGuard, rollback: Promise.resolve({ outcome: "stale", site: "lane" }), done: staleDone }
    await expect(internals.guardOfferForActor("b", conn(), staleGuard)).resolves.toEqual({ outcome: "stale", site: "lane" })
    expect(staleDone).toHaveBeenCalledWith(false)
  })
})
