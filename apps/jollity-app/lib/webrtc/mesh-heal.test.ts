// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Each self-heal attempt of the Mesh (#261): its trigger, attempt number and
 * outcome, driven through the fake RTCPeerConnection of test-pc.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { FakePC, setupMesh } from "./test-pc"
import type { HealEpisodeEvent, HealEvent, HealTracker } from "./heal"
import { LINK_TORN_DOWN_MS, type HealCohortEvent, type LinkFailure } from "./heal-cohort"

async function setup(myId = "a", peerId = "b", local?: unknown) {
  const heals: Array<[string, HealEvent]> = []
  const episodes: Array<[string, HealEpisodeEvent]> = []
  const cohorts: HealCohortEvent[] = []
  const failures: Array<[string, LinkFailure]> = []
  const made = await setupMesh(myId, peerId, { onRtcEvent: (peer, { kind, ...event }) => {
    if (kind === "heal") heals.push([peer, event as HealEvent])
    if (kind === "heal_episode") episodes.push([peer, event as HealEpisodeEvent])
    if (kind === "heal_cohort") cohorts.push(event as unknown as HealCohortEvent)
    if (kind === "link_failed") failures.push([peer, event as unknown as LinkFailure])
  } }, local)
  return { ...made, heals, episodes, cohorts, failures }
}
const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const ice = (pc: FakePC, next: RTCIceConnectionState) => {
  pc.iceConnectionState = next
  pc.oniceconnectionstatechange!()
}

describe("the self-heal record", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("#1203 reports a connected ICE transport while the overall peer connection settles", async () => {
    const { mesh, pc } = await setup()
    pc.connectionState = "connecting"
    pc.iceConnectionState = "connected"
    expect(mesh.health().get("b")).toMatchObject({
      conn: "connecting",
      ice: "connected",
    })
    mesh.close()
  })

  it("records an ICE restart after a disconnect, healed when the link connects again", async () => {
    const { mesh, pc, heals } = await setup()
    pc.channels[0].readyState = "open"
    state(pc, "connected")
    state(pc, "disconnected")
    await vi.advanceTimersByTimeAsync(9000) // past the grace, onto a supervisor sweep
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(heals).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    state(pc, "connected")
    expect(heals).toHaveLength(1)
    expect(heals[0][0]).toBe("b")
    expect(heals[0][1]).toMatchObject({ trigger: "disconnected", action: "ice_restart", attempt: 1, healed: true, end: "connected" })
    expect(heals[0][1].healMs).toBeGreaterThanOrEqual(2000)
    mesh.close()
  })

  it("records a rebuild after a failure, healed on the fresh connection", async () => {
    const { mesh, pc, heals } = await setup()
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100) // one sweep
    expect(FakePC.last).toHaveLength(2) // rebuilt
    state(FakePC.last[1], "connected")
    expect(heals.map(([, event]) => [event.trigger, event.action, event.attempt, event.healed])).toEqual([["failed", "rebuild", 1, true]])
    mesh.close()
  })

  it("keeps one recovery episode through restart, rebuild and peer back, then clears it on connect", async () => {
    const { mesh, pc } = await setup()
    pc.channels[0].readyState = "open"
    await vi.advanceTimersByTimeAsync(1000)
    state(pc, "connected")
    state(pc, "disconnected")

    const first = mesh.health().get("b")!
    expect(first.recovering).toBe(true) // initial downAt grace, before the supervisor's first attempt
    expect(first.recoveryStartedAt).toBeTypeOf("number")

    await vi.advanceTimersByTimeAsync(9000)
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(mesh.health().get("b")).toMatchObject({
      recovering: true,
      recoveryStartedAt: first.recoveryStartedAt,
    })

    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3000)
    const rebuilt = FakePC.last[1]
    expect(mesh.health().get("b")).toMatchObject({
      recovering: true,
      recoveryStartedAt: first.recoveryStartedAt,
    })

    const internals = mesh as unknown as {
      conns: Map<string, unknown>
      setAway: (peerId: string, conn: unknown, away: "said" | "timeout" | null) => void
    }
    const conn = internals.conns.get("b")!
    internals.setAway("b", conn, "timeout")
    internals.setAway("b", conn, null)
    expect(mesh.health().get("b")?.recoveryStartedAt).toBe(first.recoveryStartedAt)

    internals.setAway("b", conn, "said")
    expect(mesh.health().get("b")?.recovering).toBe(false)
    internals.setAway("b", conn, null)
    state(rebuilt, "connected")
    expect(mesh.health().get("b")).toMatchObject({ recovering: false })
    expect(mesh.health().get("b")?.recoveryStartedAt).toBeUndefined()
    mesh.close()
  })

  it("records one three-link relay cohort without changing the normal heal path", async () => {
    const { mesh, pc, heals, cohorts } = await setup()
    mesh.addPeer("c")
    mesh.addPeer("d")
    const originals = [pc, FakePC.last[1], FakePC.last[2]]
    for (const original of originals) state(original, "connected")
    await mesh.report() // retain each link's sanitized selected relay path

    state(originals[0], "failed")
    await vi.advanceTimersByTimeAsync(20)
    state(originals[1], "failed")
    await vi.advanceTimersByTimeAsync(25)
    state(originals[2], "failed") // all three failures landed within 45 ms
    await vi.advanceTimersByTimeAsync(3055) // the ordinary 3 s supervisor sweep

    expect(FakePC.last).toHaveLength(6)
    expect(cohorts).toEqual([]) // waits for per-link recovery evidence
    for (const replacement of FakePC.last.slice(3)) {
      await vi.advanceTimersByTimeAsync(100)
      state(replacement, "connected")
    }

    expect(heals).toHaveLength(3)
    expect(heals.every(([, event]) => event.trigger === "failed" && event.action === "rebuild" && event.healed)).toBe(true)
    expect(cohorts).toHaveLength(1)
    expect(cohorts[0]).toMatchObject({
      size: 3,
      windowMs: 45,
      relayProtocol: "tls",
      turnEndpointHost: "turn.example.org",
      // `failed` with no ICE `disconnected` before it: the transport closed under each link
      failKind: "torn-down",
      quietMs: [0, 0, 0],
      pageHidden: false,
      unrecovered: 0,
    })
    expect(cohorts[0].recoveryMs).toHaveLength(3)
    expect(cohorts[0].recoveryMs.every((duration) => typeof duration === "number" && duration > 3000)).toBe(true)
    expect(JSON.stringify(cohorts[0])).not.toContain("user")
    expect(JSON.stringify(cohorts[0])).not.toContain("secret")
    mesh.close()
  })

  it("says a link whose transport closed under it was torn down (#944: ICE disconnected and failed in one millisecond)", async () => {
    const { mesh, pc, failures } = await setup()
    state(pc, "connected")
    await mesh.report() // the link's selected relay path
    await vi.advanceTimersByTimeAsync(28_000)
    ice(pc, "disconnected")
    state(pc, "failed")

    expect(failures).toHaveLength(1)
    expect(failures[0][0]).toBe("b")
    expect(failures[0][1]).toEqual({
      failKind: "torn-down",
      quietMs: 0,
      upMs: 28_000,
      path: "relay",
      relayProtocol: "tls",
      relayProtocolSource: "stats",
      turnEndpointHost: "turn.example.org",
      pageHidden: false,
    })
    mesh.close()
  })

  it("says a link that went quiet before it failed timed out, and counts from the drop through an ICE restart", async () => {
    const { mesh, pc, failures } = await setup()
    state(pc, "connected")
    ice(pc, "disconnected")
    state(pc, "disconnected")
    await vi.advanceTimersByTimeAsync(LINK_TORN_DOWN_MS + 500)
    ice(pc, "checking") // a restart's checks do not restart the quiet clock
    state(pc, "failed")

    expect(failures).toHaveLength(1)
    expect(failures[0][1]).toMatchObject({ failKind: "timed-out", quietMs: LINK_TORN_DOWN_MS + 500 })
    mesh.close()
  })

  it("reports one failure per outage, and none for a rebuilt connection that never came up", async () => {
    const { mesh, pc, failures } = await setup()
    state(pc, "connected")
    state(pc, "failed")
    state(pc, "failed") // a connectionState callback can repeat
    expect(failures).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3100) // the supervisor rebuilds
    const rebuilt = FakePC.last.at(-1)!
    expect(rebuilt).not.toBe(pc)
    state(rebuilt, "failed") // a failed reconnect, not a link that died
    expect(failures).toHaveLength(1)
    state(rebuilt, "connected")
    state(rebuilt, "failed") // up again, then down: a new outage
    expect(failures).toHaveLength(2)
    mesh.close()
  })

  it("notes a hidden page and the time since the last network change", async () => {
    const { mesh, pc, failures } = await setup()
    state(pc, "connected")
    mesh.networkChanged()
    await vi.advanceTimersByTimeAsync(2_000)
    vi.stubGlobal("document", { visibilityState: "hidden" })
    state(pc, "failed")

    expect(failures).toHaveLength(1)
    expect(failures[0][1]).toMatchObject({ pageHidden: true, sinceNetChangeMs: 2_000 })
    mesh.close()
  })

  it("does not record a cohort for one failed established link", async () => {
    const { mesh, pc, heals, cohorts } = await setup()
    state(pc, "connected")
    await mesh.report()
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100)
    state(FakePC.last[1], "connected")

    expect(heals).toHaveLength(1)
    expect(cohorts).toEqual([])
    mesh.close()
  })

  it("names a link that never connected for too long as never_connected", async () => {
    const { mesh, heals } = await setup()
    await mesh.onRtc("b", { rtc: { cand: { candidate: "candidate:1 1 udp 1 1.1.1.1 1 typ host" } } } as never) // b is here (signalling)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(FakePC.last.length).toBeGreaterThan(1)
    state(FakePC.last.at(-1)!, "connected")
    expect(heals[0][1]).toMatchObject({ trigger: "never_connected", action: "rebuild", attempt: 1, healed: true })
    mesh.close()
  })

  it("leaves a roster peer it has never heard from alone, even in the first seconds of the page (#319)", async () => {
    const { mesh, heals } = await setup() // fake clock at 0: the monotonic clock of a page that just loaded
    await vi.advanceTimersByTimeAsync(25_000) // past the initial timeout, inside PRESENT_WINDOW_MS of load
    expect(FakePC.last).toHaveLength(1) // no rebuild: nothing says the peer is here
    expect(heals).toEqual([])
    mesh.close()
  })

  it("a closed mesh schedules no later self-heals", async () => {
    const { mesh, heals } = await setup()
    mesh.markSeen("b")
    mesh.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakePC.last).toHaveLength(1)
    expect(heals).toEqual([])
  })

  it("finishes closing every peer when one peer connection close throws", async () => {
    const { mesh, pc, heals } = await setup()
    mesh.addPeer("c")
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100) // opens a heal and rebuilds b
    const throwing = FakePC.last[1]
    const remaining = FakePC.last[2]
    throwing.close.mockImplementationOnce(() => {
      throw new TypeError("Invalid RTCPeerConnection receiver")
    })

    expect(() => mesh.close()).not.toThrow()
    expect(throwing.close).toHaveBeenCalledTimes(1)
    expect(remaining.close).toHaveBeenCalledTimes(1)
    expect((mesh as unknown as { conns: Map<string, unknown> }).conns.size).toBe(0)
    expect(heals[0][1]).toMatchObject({ healed: false, end: "mesh_closed" })
    expect(() => mesh.close()).not.toThrow()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(FakePC.last).toHaveLength(3)
  })

  it("counts attempt 2 and closes attempt 1 as not healed when the next one starts first", async () => {
    const { mesh, heals } = await setup()
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(21_000) // never connected: attempt 1, a rebuild
    expect(FakePC.last).toHaveLength(2)
    mesh.markSeen("b")
    await vi.advanceTimersByTimeAsync(18_000) // each fresh connection gets the full connect-by floor
    expect(FakePC.last).toHaveLength(3)
    expect(heals).toHaveLength(1)
    expect(heals[0][1]).toMatchObject({ attempt: 1, healed: false, end: "next_attempt" })
    state(FakePC.last[2], "connected")
    expect(heals[1][1]).toMatchObject({ attempt: 2, healed: true })
    mesh.close()
  })

  it("records a media stall as an ICE restart that heals only when frames flow again", async () => {
    const live = { readyState: "live" }
    const { mesh, pc, heals } = await setup("a", "b", { getVideoTracks: () => [live], getTracks: () => [] })
    state(pc, "connected")
    pc.stats = chromeStats({ t: 1000, decoded: 50, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
    await vi.advanceTimersByTimeAsync(4000) // frames seen
    await vi.advanceTimersByTimeAsync(8000) // two sweeps with no new frames
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(heals).toEqual([])
    pc.stats = chromeStats({ t: 2000, decoded: 80, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
    await vi.advanceTimersByTimeAsync(4000)
    expect(heals).toHaveLength(1)
    expect(heals[0][1]).toMatchObject({ trigger: "media_stall", action: "ice_restart", attempt: 1, healed: true, end: "media_flowing" })
    mesh.close()
  })

  it("records an offer that arrives on a link that was up and is down as a rejoin_offer, answered", async () => {
    const { mesh, pc, heals } = await setup()
    state(pc, "connected")
    state(pc, "disconnected")
    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    state(pc, "connected")
    expect(heals[0][1]).toMatchObject({ trigger: "rejoin_offer", action: "answer", attempt: 1, healed: true })
    mesh.close()
  })

  it("does not count the first offer of a link, or an offer on a link that is up, as a heal", async () => {
    const { mesh, pc, heals } = await setup()
    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never)
    state(pc, "connected")
    pc.signalingState = "stable"
    await mesh.onRtc("b", { rtc: { desc: { type: "offer", sdp: "v=0" } } } as never) // a renegotiation while connected
    state(pc, "connected")
    expect(heals).toEqual([])
    mesh.close()
  })

  it("ends an open attempt as not healed when the peer is removed", async () => {
    const { mesh, pc, heals } = await setup()
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100)
    mesh.removePeer("b")
    expect(heals[0][1]).toMatchObject({ healed: false, end: "peer_left" })
    mesh.close()
  })

  it("ends an open attempt as not healed when the mesh closes", async () => {
    const { mesh, pc, heals } = await setup()
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100)
    mesh.close()
    expect(heals[0][1]).toMatchObject({ healed: false, end: "mesh_closed" })
  })

  it("classifies connected attempts as healed at close while genuinely unhealed links close once", async () => {
    const { mesh, episodes } = await setup()
    mesh.addPeer("c")
    const internals = mesh as unknown as {
      conns: Map<string, { pc: FakePC }>
      heal: HealTracker
    }
    const connected = internals.conns.get("b")!.pc
    const unhealed = internals.conns.get("c")!.pc
    connected.connectionState = "connected"
    unhealed.connectionState = "failed"
    internals.heal.begin("b", "disconnected", "ice_restart", 0)
    internals.heal.begin("c", "failed", "rebuild", 0)

    mesh.close()
    mesh.close()

    expect(episodes).toEqual([
      ["b", expect.objectContaining({ healed: true, end: "connected" })],
      ["c", expect.objectContaining({ healed: false, end: "mesh_closed" })],
    ])
  })
})
