// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The facts Mesh hands the peer actor, and what the actor then has Mesh do,
 * with the actor driving (step 9). Until then these ran against legacy Mesh
 * with its decision capture and the shadow; the capture-record assertions
 * went with the legacy path, and the behaviour ones stay here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PeerRoomRunner } from "../state-machines/peer-runner"
import { remoteSessionOf } from "./mesh"
import { chromeStats } from "./test-stats"
import { actorCommands, actorEvents, FakePC, sdp, setupMesh } from "./test-pc"

const runnerOf = (mesh: unknown) => (mesh as { runner: PeerRoomRunner }).runner

describe("the facts Mesh hands the peer actor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("restarts, configures, holds back video and removes without a rebuild", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    pc.channels[0]!.readyState = "open"
    pc.channels[0]!.onopen?.()
    const commands = actorCommands(mesh)

    mesh.setStandby("b", true)
    mesh.setStandby("b", false)
    mesh.setPeers(["b"], [])
    mesh.setIcePolicy("relay", ["tcp"])
    mesh.networkChanged()
    mesh.removePeer("b")

    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(FakePC.last).toHaveLength(1)
    expect(commands.map(({ command }) => command.kind)).toEqual(expect.arrayContaining([
      "replace-video-track", "configure-ice", "restart-ice", "close-connection",
    ]))
    expect(pc.close).toHaveBeenCalledTimes(1)
    mesh.close()
  })

  it("tells the actor about the page hiding and coming back, which asks for a keyframe and sweeps", async () => {
    const { mesh } = await setupMesh("a", "b", { decisionRoom: "game-1", decisionRoomEpoch: 7 })
    const events = actorEvents(mesh)
    const commands = actorCommands(mesh)

    mesh.setSelfAway(true)
    mesh.setSelfAway(false, 9_000)

    expect(events.flatMap(({ event }) => event.type === "visibility-changed" ? [[event.hidden, event.hiddenForMs]] : [])).toEqual([[true, undefined], [false, 9_000]])
    expect(commands.map(({ command }) => command.kind).filter((kind) => kind === "request-keyframe" || kind === "sweep")).toEqual(["request-keyframe", "sweep"])
    mesh.close()
  })

  it("sweeps on coming back only after more than eight seconds hidden", async () => {
    const { mesh } = await setupMesh("a", "b", { decisionRoom: "game-1", decisionRoomEpoch: 7 })
    const commands = actorCommands(mesh)

    mesh.setSelfAway(true)
    mesh.setSelfAway(false, 3_000)

    expect(commands.map(({ command }) => command.kind).filter((kind) => kind === "request-keyframe" || kind === "sweep")).toEqual(["request-keyframe"])
    mesh.close()
  })

  it("still sweeps after a long absence when the mesh was never told it was away", async () => {
    const { mesh } = await setupMesh("a", "b", { decisionRoom: "game-1", decisionRoomEpoch: 7 })
    const commands = actorCommands(mesh)

    mesh.setSelfAway(false, 9_000)

    expect(commands.map(({ command }) => command.kind).filter((kind) => kind === "request-keyframe" || kind === "sweep")).toEqual(["sweep"])
    mesh.close()
  })

  it("starts a peer met while the page is hidden with a hidden actor", async () => {
    const { mesh } = await setupMesh("a", "b", { decisionRoom: "game-1", decisionRoomEpoch: 7 })

    mesh.setSelfAway(true)
    mesh.addPeer("c")

    expect(runnerOf(mesh).state("b")!.hidden).toBe(true)
    expect(runnerOf(mesh).state("c")!.hidden).toBe(true)
    mesh.close()
  })

  it("tells the actor when a peer is heard, and nothing when its presence goes stale: the actor reads its own last signal (design B, B2)", async () => {
    const { mesh } = await setupMesh("a", "b", { decisionRoom: "game-1", decisionRoomEpoch: 7 })
    const events = actorEvents(mesh)
    const count = (type: string) => events.filter(({ event }) => event.type === type).length
    mesh.markSeen("b")
    expect(count("peer-heard")).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(count("peer-heard")).toBe(2)
    mesh.close()
  })

  it("stamps a statement offer from a new remote session for the actor, never as glare", async () => {
    const { mesh, pc } = await setupMesh("a", "b", { decisionRoom: "game-1", decisionRoomEpoch: 7 })
    const events = actorEvents(mesh)
    await pc.onnegotiationneeded?.()
    await mesh.onRtc("b", { rtc: { desc: { type: "answer", sdp: sdp("remote-1") } } })
    const described = () => events.flatMap(({ event }) => event.type === "description-observed" ? [event] : [])
    expect(described().find((event) => event.description === "answer")?.newRemoteSession).toBeUndefined()

    pc.signalingState = "have-local-offer"
    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: sdp("remote-2") } } })

    expect(events.some(({ event }) => event.type === "glare-observed")).toBe(false)
    expect(described().find((event) => event.description === "offer")).toMatchObject({
      type: "description-observed",
      description: "offer",
      newRemoteSession: { at: expect.any(Number) },
    })
    mesh.close()
  })

  it("keeps a colliding offer from a departed session out of the statement glare", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    const internals = mesh as unknown as { leftSessions: Map<string, Set<string>> }
    const events = actorEvents(mesh)
    const gone = sdp("remote-gone")
    internals.leftSessions.set("b", new Set([remoteSessionOf(gone)!]))

    pc.signalingState = "have-local-offer"
    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: gone } } })

    expect(events.map(({ event }) => event.type)).not.toContain("glare-observed")
    expect(events.find(({ event }) => event.type === "description-observed")?.event).toMatchObject({ type: "description-observed", departedSession: true })
    mesh.close()
  })

  it("tells the actor about a media sweep it holds, so its stall count restarts", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    const events = actorEvents(mesh)
    pc.connectionState = "disconnected" // set without the state event: only the sweep sees it
    await vi.advanceTimersByTimeAsync(4100)

    const sweeps = events.flatMap(({ event }) => event.type === "stats-observed" ? [event] : [])
    expect(sweeps.length).toBeGreaterThan(0)
    expect(sweeps[0]).toMatchObject({ browserConnectionState: "disconnected" })
    mesh.close()
  })

  it("heals a stall with the connection state the media check saw, not a drop during the stats await", async () => {
    const { mesh, pc } = await setupMesh("a", "b", {}, { getVideoTracks: () => [{ readyState: "live" }], getTracks: () => [] })
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    const report = () => chromeStats({ t: 1, decoded: 10, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 }) as unknown as RTCStatsReport
    pc.getStats = vi.fn(async () => report())
    await vi.advanceTimersByTimeAsync(4000) // frames first seen
    const next = (decoded: number) => chromeStats({ t: 1, decoded, lost: 0, received: decoded, bytesSent: 0, freezes: 0, cpu: 0 }) as unknown as RTCStatsReport
    pc.getStats = vi.fn(async () => next(20))
    await vi.advanceTimersByTimeAsync(4000) // frames advance
    pc.getStats = vi.fn(async () => next(20))
    await vi.advanceTimersByTimeAsync(4000) // one stalled sweep
    expect(pc.restartIce).not.toHaveBeenCalled()

    // the link drops while getStats is awaited: the media check ran before it
    pc.getStats = vi.fn(async () => {
      pc.connectionState = "disconnected"
      return next(20)
    })
    await vi.advanceTimersByTimeAsync(4000)

    expect(pc.restartIce).toHaveBeenCalled()
    mesh.close()
  })

  it("gives the actor the state a frames probe's gate saw", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(0) // the path read on connect (Mesh.readPath) lands first
    const events = actorEvents(mesh)
    pc.getStats = vi.fn(async () => {
      pc.connectionState = "disconnected" // the link drops while the probe awaits
      return chromeStats({ t: 1, decoded: 10, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 }) as unknown as RTCStatsReport
    })
    await vi.advanceTimersByTimeAsync(1500) // the probe after the link came up, before the first sweep

    const probe = events.flatMap(({ event }) => event.type === "stats-observed" ? [event] : [])
    expect(probe.length).toBeGreaterThan(0)
    expect(probe[0]).toMatchObject({ browserConnectionState: "connected" })
    mesh.close()
  })

  it("stops the media sweep when the mesh closes while an earlier peer's stats are awaited", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    mesh.addPeer("c") // never connects: the sweep's held-skip branch
    let release!: (report: RTCStatsReport) => void
    pc.getStats = vi.fn(() => new Promise<RTCStatsReport>((resolve) => { release = resolve }))
    pc.connectionState = "connected"
    pc.onconnectionstatechange!()
    await vi.advanceTimersByTimeAsync(4000) // the sweep reaches b and waits on its stats
    const events = actorEvents(mesh)

    mesh.close()
    release(chromeStats({ t: 1, decoded: 1, lost: 0, received: 1, bytesSent: 0, freezes: 0, cpu: 0 }) as unknown as RTCStatsReport)
    await vi.advanceTimersByTimeAsync(0)

    expect(events.map(({ event }) => event.type)).not.toContain("stats-observed")
  })
})
