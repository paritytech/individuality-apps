// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Step 4.3 stage 3c: the peer actor drives the mesh (the only path since
 * step 9). Each scenario runs the real Mesh on the fake RTCPeerConnection,
 * one witness per family: every browser effect comes from an actor command
 * (executePeerCommand, recorded here), Mesh's own re-initiate does not run
 * (it is spied on), and the actor's connection epoch is the one Mesh stamps
 * on the connection it holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal, USE_CASE_RENEGOTIATION } from "@jollity/statement-core"
import type { PeerActorCommand, PeerActorEvent } from "../state-machines/peer-actor"
import type { PeerRoomRunner } from "../state-machines/peer-runner"
import { monoNow } from "./mesh"
import { backoffMs, SUPERVISOR_TIMING } from "./supervisor-timing"
import { chromeStats } from "./test-stats"
import { encodeView, encodeViewFrame } from "./link-view"
import { encodeAway } from "./away-frame"
import { FakeChannel, FakePC, sdp, setupMesh, actorEvents, actorTakesMeshTimes } from "./test-pc"

type Conn = {
  pc: FakePC
  channel: FakeChannel | null
  decisionConnectionEpoch: number
  away: "said" | "timeout" | null
  everConnected: boolean
  lastSignalAt: number
  offerSentAt: number
  yieldedAt: number
  disconnectedAt: number
  downAt: number
  ignoreOffer: boolean
  standby: boolean
  healHoldUntil: number
}

type Internals = {
  conns: Map<string, Conn>
  runner: PeerRoomRunner | null
  setAway(peerId: string, conn: Conn, away: "said" | "timeout"): void
  supervise(): void
  executePeerCommand(peerId: string, command: PeerActorCommand): unknown
}

/** Mesh's own re-initiate, which runs only for a departed session's offer:
 *  the actor decides every other path. (Legacy's decision paths went in step 9.) */
const LEGACY_DECISIONS = [
  "initiateStrandedPeer",
] as const

const live = { readyState: "live" }
const camera = { getVideoTracks: () => [live], getTracks: () => [] }
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const offer = (body: string, gen?: string) => ({ rtc: { desc: { type: "offer", sdp: body }, ...(gen ? { gen } : {}) } }) as never
const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never
const descriptions = (signals: unknown[]) => signals.flatMap((signal) => {
  const desc = (signal as { rtc: { desc?: { type: string }; gen?: string } }).rtc
  return desc.desc ? [{ type: desc.desc.type, gen: desc.gen }] : []
})

const sendLane = (channel: FakeChannel, tag: "Offer" | "Answer", value: string) => {
  const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal({ tag, value }) })
  ;(channel.onmessage as (event: { data: unknown }) => void)({ data: new Uint8Array(frame).buffer })
}
/** what went down the lane, as text */
const laneFrames = (channel: FakeChannel) => (channel.send.mock.calls as unknown[][]).map(([bytes]) => new TextDecoder("latin1").decode(bytes as Uint8Array))

const state = (pc: FakePC, value: RTCPeerConnectionState) => {
  pc.connectionState = value
  pc.onconnectionstatechange!()
}
const openOwnChannel = (pc: FakePC) => {
  const channel = pc.channels[0]!
  channel.readyState = "open"
  ;(channel.onopen as () => void)()
  return channel
}
/** the far end's channel arriving, open */
const openTheirChannel = (pc: FakePC) => {
  const channel = new FakeChannel()
  channel.readyState = "open"
  ;(pc.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
  return channel
}
const frames = (pc: FakePC, decoded: number) => {
  pc.stats = chromeStats({ t: 1000 + decoded, decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
}

/** A Mesh for `myId` with `peerId` added, the peer actor driving it. */
async function driven(myId = "a", peerId = "b", opts: Record<string, unknown> = {}, local: unknown = undefined) {
  const made = await setupMesh(myId, peerId, opts, local)
  const internals = made.mesh as unknown as Internals
  // these scenarios back-date Mesh's times by hand: the actor takes them
  actorTakesMeshTimes(made.mesh)
  const commands: PeerActorCommand[] = []
  const execute = internals.executePeerCommand.bind(internals)
  vi.spyOn(internals, "executePeerCommand").mockImplementation((peer, command) => {
    commands.push(command)
    return execute(peer, command)
  })
  const legacy = Object.fromEntries(LEGACY_DECISIONS.map((name) => [name, vi.spyOn(internals as never, name)])) as unknown as Record<(typeof LEGACY_DECISIONS)[number], ReturnType<typeof vi.spyOn>>
  const conn = () => internals.conns.get(peerId)!
  const actor = () => internals.runner!.state(peerId)!
  /** the actor's commands so far, as kind or kind:cause */
  const program = () => commands.map((command) => "cause" in command ? `${command.kind}:${command.cause}` : command.kind)
  /** no legacy decision ran, and the actor holds the connection Mesh holds */
  const owned = () => {
    for (const name of LEGACY_DECISIONS) expect(legacy[name], name).not.toHaveBeenCalled()
    if (internals.conns.has(peerId)) expect(actor().connectionEpoch).toBe(conn().decisionConnectionEpoch)
  }
  return { ...made, internals, commands, program, legacy, conn, actor, owned }
}

/** an initiator whose link came up, its lane open, and then dropped */
async function dropped(value: RTCPeerConnectionState = "disconnected", opts: Record<string, unknown> = {}) {
  const made = await driven("a", "b", opts)
  openOwnChannel(made.pc)
  state(made.pc, "connected")
  state(made.pc, value)
  made.conn().lastSignalAt = monoNow()
  made.commands.length = 0
  return made
}

describe("the peer actor drives the mesh", () => {
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

  describe("the runner", () => {
    it("drives each peer's actor at Mesh's connection", async () => {
      const { mesh, actor, conn } = await driven()
      expect(actor().connectionEpoch).toBe(conn().decisionConnectionEpoch)
      expect(actor().initiator).toBe(true)
      mesh.close()
    })
  })

  describe("negotiation", () => {
    it("makes the initiator's statement offer, applies the answer, then offers and applies on the lane", async () => {
      const { mesh, pc, signals, program, owned } = await driven()
      await pc.onnegotiationneeded!()
      expect(descriptions(signals)).toEqual([{ type: "offer", gen: undefined }])
      await mesh.onRtc("b", answer(sdp("222")))
      expect(pc.remoteDescription?.type).toBe("answer")
      state(pc, "connected")
      const lane = openOwnChannel(pc)
      await pc.onnegotiationneeded!() // media: our lane offer
      expect(laneFrames(lane).some((frame) => frame.includes("v=0"))).toBe(true)
      const video = sdp("222", { media: ["video"] })
      sendLane(lane, "Answer", video)
      await vi.waitFor(() => expect(pc.remoteDescription?.sdp).toBe(video))
      expect(program()).toEqual(["send-offer", "set-remote-description", "send-offer", "set-remote-description"])
      owned()
      mesh.close()
    })

    it("answers the initiator's statement offer with its gen, and its lane offer down the lane", async () => {
      const { mesh, pc, signals, program, owned } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      expect(pc.localDescription?.type).toBe("answer")
      expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.1" }])
      const lane = openTheirChannel(pc)
      sendLane(lane, "Offer", sdp("111", { media: ["video"] }))
      await vi.waitFor(() => expect(laneFrames(lane).length).toBeGreaterThan(0))
      expect(pc.signalingState).toBe("stable")
      expect(program()).toEqual(["set-remote-description", "send-answer", "set-remote-description", "send-answer"])
      owned()
      mesh.close()
    })

    it("drops an answer whose offer a newer one overtook during its gather, and sends the newer one's", async () => {
      const { mesh, pc, signals, program, owned } = await driven("b", "a")
      pc.iceGatheringState = "gathering" // the answer waits out its gather budget
      const first = mesh.onRtc("a", offer(sdp("111"), "A.1"))
      await settle()
      const second = mesh.onRtc("a", offer(sdp("111", { ufrag: "u2" }), "A.2"))
      await vi.advanceTimersByTimeAsync(5_000)
      await Promise.all([first, second])
      expect(descriptions(signals)).toEqual([{ type: "answer", gen: "A.2" }])
      expect(program().filter((kind) => kind === "send-answer")).toHaveLength(2)
      owned()
      mesh.close()
    })

    it("ignores the peer's statement offer while its own is out, as the impolite end", async () => {
      const { mesh, pc, program, conn, owned } = await driven()
      await pc.onnegotiationneeded!()
      const applied = vi.spyOn(pc, "setRemoteDescription")
      await mesh.onRtc("b", offer(sdp("222")))
      expect(applied).not.toHaveBeenCalled()
      expect(conn().ignoreOffer).toBe(true)
      expect(program()).toEqual(["send-offer", "ignore-offer"])
      owned()
      mesh.close()
    })

    it("rebuilds for a new remote session and answers its offer on the fresh connection", async () => {
      const { mesh, pc, signals, program, owned } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      await mesh.onRtc("a", offer(sdp("999"), "B.1")) // the peer restarted its app
      expect(FakePC.last).toHaveLength(2)
      expect(pc.close).toHaveBeenCalled()
      expect(FakePC.last[1]!.remoteDescription?.sdp).toBe(sdp("999"))
      expect(descriptions(signals).map(({ gen }) => gen)).toEqual(["A.1", "B.1"])
      expect(program()).toEqual(["set-remote-description", "send-answer", "replace-connection:description-session-rejoin", "set-remote-description", "send-answer"])
      owned()
      mesh.close()
    })

    it("re-initiates when the first-contact offer cannot be applied to its connection", async () => {
      const { mesh, pc, signals, program, owned } = await driven("b", "a")
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("bad offer", "OperationError"))
      await mesh.onRtc("a", offer(sdp("111")))
      await settle()
      expect(FakePC.last).toHaveLength(2)
      const fresh = FakePC.last[1]!
      expect(fresh.channels).toHaveLength(1) // this side offers on it
      expect(descriptions(signals)).toEqual([{ type: "offer", gen: undefined }])
      expect(program()).toEqual(["set-remote-description", "replace-connection:stranded-offer-refused", "create-channel", "send-offer"])
      owned()
      mesh.close()
    })
  })

  describe("glare on the lane", () => {
    async function politeWithVideo() {
      const made = await driven("b", "a")
      made.mesh.setRound(1)
      await made.mesh.onRtc("a", offer(sdp("111")))
      const lane = openTheirChannel(made.pc)
      const video = sdp("111", { media: ["video"] })
      sendLane(lane, "Offer", video)
      await vi.waitFor(() => expect(made.pc.signalingState).toBe("stable"))
      await vi.waitFor(() => expect(laneFrames(lane).length).toBeGreaterThan(0))
      return { ...made, lane }
    }

    it("rebuilds instead of rolling back once video is negotiated (game 1331), and the fresh link offers", async () => {
      const { mesh, pc, lane, program, owned } = await politeWithVideo()
      mesh.networkChanged() // our own ICE restart: the answerer may offer
      await pc.onnegotiationneeded!()
      expect(pc.signalingState).toBe("have-local-offer")
      const applied = vi.spyOn(pc, "setRemoteDescription")
      sendLane(lane, "Offer", sdp("111", { ufrag: "u2", media: ["video"] }))
      await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
      expect(applied).not.toHaveBeenCalled()
      expect(FakePC.last[1]!.channelCreations).toHaveLength(1)
      expect(program()).toContain("replace-connection:lane-glare-video")
      owned()
      mesh.close()
    })

    it("rolls back and answers a crossing offer before any video, and ignores one as the impolite end", async () => {
      const polite = await driven("b", "a")
      await polite.mesh.onRtc("a", offer(sdp("111")))
      const lane = openTheirChannel(polite.pc)
      polite.mesh.networkChanged()
      await polite.pc.onnegotiationneeded!()
      sendLane(lane, "Offer", sdp("111", { ufrag: "u2" }))
      await vi.waitFor(() => expect(polite.pc.localDescription?.type).toBe("answer"))
      expect(polite.program().slice(-3)).toEqual(["rollback:glare", "set-remote-description", "send-answer"])
      expect(FakePC.last).toHaveLength(1)
      polite.owned()
      polite.mesh.close()

      const impolite = await driven("a", "b")
      await impolite.pc.onnegotiationneeded!()
      await impolite.mesh.onRtc("b", answer(sdp("222")))
      state(impolite.pc, "connected")
      const own = openOwnChannel(impolite.pc)
      await impolite.pc.onnegotiationneeded!() // our lane offer, unanswered
      const applied = vi.spyOn(impolite.pc, "setRemoteDescription")
      sendLane(own, "Offer", sdp("222", { ufrag: "u3" }))
      await settle()
      expect(applied).not.toHaveBeenCalled()
      expect(impolite.program().at(-1)).toBe("ignore-offer")
      impolite.owned()
      impolite.mesh.close()
    })
  })

  describe("commands of several awaits: one promise, a stale bail with no effect", () => {
    const UNSAFE_RTX_ENGINE = "Mozilla/5.0 (Linux; Android 12; wv) Chrome/120.0 Mobile"
    const rtxOffer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\n"

    /** an initiator with its lane open on an engine whose offers must not carry RTX */
    async function guarded(opts: Record<string, unknown> = {}) {
      vi.stubGlobal("navigator", { userAgent: UNSAFE_RTX_ENGINE, onLine: true })
      const made = await driven("a", "b", opts)
      made.mesh.setRound(1)
      made.pc.connectionState = "connected"
      const lane = made.pc.channels[0]!
      lane.readyState = "open"
      Object.assign(made.pc, { createOffer: vi.fn(async () => ({ type: "offer", sdp: rtxOffer })) })
      const calls: string[] = []
      const setLocal = made.pc.setLocalDescription.bind(made.pc)
      const local = vi.spyOn(made.pc, "setLocalDescription")
      const record = (desc?: { type: string; sdp?: string }) => calls.push(desc?.type ?? "implicit")
      return { ...made, lane, calls, setLocal, local, record }
    }

    it("runs the codec guard as the actor's rollback and send-offer, and sends the stripped offer once", async () => {
      const { mesh, pc, lane, calls, setLocal, local, record, program, owned } = await guarded()
      local
        .mockImplementationOnce(async (desc) => { record(desc); pc.localDescription = { type: "offer", sdp: rtxOffer }; pc.signalingState = "have-local-offer" })
        .mockImplementation(async (desc) => { record(desc); await setLocal(desc) })
      await pc.onnegotiationneeded!()
      await settle()
      expect(calls).toEqual(["implicit", "rollback", "offer"])
      expect(pc.signalingState).toBe("have-local-offer")
      const frames = laneFrames(lane)
      expect(frames).toHaveLength(1)
      expect(frames[0]).toContain("m=video")
      expect(frames[0]).not.toContain("rtx/90000")
      expect(program()).toEqual(["send-offer", "rollback:codec-guard", "send-offer"])
      owned()
      mesh.close()
    })

    it("completes the guard stale and sends nothing when its connection is replaced during the rollback", async () => {
      const { mesh, pc, lane, conn, setLocal, local, program, owned } = await guarded()
      local
        .mockImplementationOnce(async () => { pc.localDescription = { type: "offer", sdp: rtxOffer }; pc.signalingState = "have-local-offer" })
        .mockImplementationOnce(async (desc) => {
          await setLocal(desc)
          // Mesh replaces the connection itself (as rebuildAll does)
          ;(mesh as unknown as { rebuildPeer(peer: string, initiate: boolean, external: boolean): void }).rebuildPeer("b", true, true)
        })
      const original = conn()
      await pc.onnegotiationneeded!()
      await settle()
      expect(FakePC.last).toHaveLength(2)
      expect(laneFrames(lane)).toEqual([])
      expect((original as unknown as { makingOffer: boolean }).makingOffer).toBe(false)
      expect(program()).toEqual(["send-offer", "rollback:codec-guard", "send-offer"])
      owned()
      mesh.close()
    })
  })

  describe("review round (#1379)", () => {
    it("heals an unseen link once our camera came up after the actor started", async () => {
      const track = { readyState: "ended", enabled: true, muted: false }
      const late = { getVideoTracks: () => [track], getTracks: () => [] }
      const ROOM = ["a", "b", "c"]
      const { mesh, pc, actor, program, owned } = await driven("a", "b", { members: ROOM }, late)
      expect(actor().cameraLive).toBe(false)
      track.readyState = "live" // the camera opened late
      pc.channels[0]!.readyState = "open"
      state(pc, "connected")
      const tell = (row: string) => (pc.channels[0]!.onmessage as (e: { data: unknown }) => void)({ data: encodeViewFrame(row).buffer })
      for (let i = 0; i < 5; i++) {
        tell(encodeView(ROOM, (m) => ({ a: "2", b: "-", c: "0" } as Record<string, "-" | "0" | "2">)[m]!)) // b: linked to a, no video from a
        frames(pc, 30 * (i + 1))
        await vi.advanceTimersByTimeAsync(4_000)
      }
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(program()).toContain("restart-ice:peer-no-video")
      expect(actor().cameraLive).toBe(true)
      owned()
      mesh.close()
    })

    it("does nothing for a replace issued after another connection, or for a peer that left", async () => {
      const { mesh, internals, conn } = await driven()
      const replace = (peer: string, connectionEpoch: number) => internals.executePeerCommand(peer, {
        kind: "replace-connection", cause: "failed", initiate: true, commandEpoch: 99, connectionEpoch,
      } as PeerActorCommand)
      const epoch = conn().decisionConnectionEpoch
      expect(replace("b", epoch + 5)).toEqual({ outcome: "stale" })
      expect(replace("gone", 2)).toEqual({ outcome: "stale" })
      expect(FakePC.last).toHaveLength(1)
      expect(internals.conns.has("gone")).toBe(false)
      expect(conn().decisionConnectionEpoch).toBe(epoch)
      mesh.close()
    })

    it("answers the offer it applied though a frame the actor drops arrived meanwhile", async () => {
      const { mesh, internals, conn, signals, owned } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      const first = conn()
      let open!: () => void
      const gate = new Promise<void>((resolve) => { open = resolve })
      const apply = FakePC.prototype.setRemoteDescription
      vi.spyOn(FakePC.prototype, "setRemoteDescription").mockImplementationOnce(async function (this: FakePC, desc) {
        await gate
        return apply.call(this, desc)
      })
      const answering = mesh.onRtc("a", offer(sdp("999"), "B.1")) // a new session: applied on a fresh connection
      await settle()
      // a lane frame still delivered for the replaced connection: the actor drops it (stale)
      const late = (internals as unknown as { onLane(peer: string, conn: unknown, payload: Uint8Array): Promise<void> })
        .onLane("a", first, encodePeerConnectionSignal({ tag: "Offer", value: sdp("111", { ufrag: "u9" }) }))
      open()
      await Promise.all([answering, late])
      expect(descriptions(signals).map(({ gen }) => gen)).toEqual(["A.1", "B.1"])
      owned()
      mesh.close()
    })

    it("completes a restart rejected where the browser has no restartIce, as legacy then rebuilds", async () => {
      const { mesh, pc, internals, conn, program, owned } = await dropped()
      ;(pc as unknown as { restartIce?: unknown }).restartIce = undefined
      conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      // legacy's recover() would rebuild, not restart, without restartIce: the facts say so to the actor
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      expect(program()[0]).not.toBe("restart-ice:soft-disconnect")
      owned()
      mesh.close()
    })
  })

  describe("recovery", () => {
    it("times each attempt from the instant its sweep stamped, however long between Mesh's clock reads (3c step 5, design B B2)", async () => {
      const { mesh, pc, internals, conn, actor, commands, owned } = await dropped()
      const read = performance.now.bind(performance)
      let drift = 0
      vi.spyOn(performance, "now").mockImplementation(() => read() + (drift += 40))
      const events = actorEvents(mesh)
      const swept = () => events.filter(({ event }) => event.type === "clock").at(-1)!.event.now
      conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(actor().lastAttemptAt).toBe(swept())
      // the command carries the sweep's instant, which Mesh times the attempt by
      expect(commands.at(-1)).toMatchObject({ kind: "restart-ice", attempt: 1, at: swept() })
      state(pc, "failed")
      internals.supervise() // inside the backoff: no rebuild yet
      expect(FakePC.last).toHaveLength(1)
      vi.advanceTimersByTime(backoffMs(1))
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      // the rebuild is timed by the sweep it was decided on (the fresh
      // connection's own sweep follows it at a later read)
      const rebuild = commands.at(-1)!
      expect(rebuild).toMatchObject({ kind: "replace-connection", attempt: 2 })
      expect(events.some(({ event }) => event.type === "clock" && event.now === rebuild.at)).toBe(true)
      expect(actor().lastAttemptAt).toBe(rebuild.at)
      owned()
      mesh.close()
    })

    it("restarts ICE on a link down past its grace, then rebuilds it once it fails", async () => {
      const { mesh, pc, internals, conn, actor, program, owned } = await dropped()
      conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      internals.supervise()
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(actor().budgets.failCount).toBe(1)
      expect(program()).toEqual(["restart-ice:soft-disconnect"])
      state(pc, "failed")
      // backed off: the backoff is the actor's own (3c step 5), so time passes
      vi.advanceTimersByTime(backoffMs(1))
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      expect(pc.close).toHaveBeenCalled()
      expect(actor().budgets.failCount).toBe(2) // the backoff carries over to the fresh connection
      expect(mesh.health().get("b")!.failCount).toBe(2) // health() reads the actor's
      expect(program()).toEqual(["restart-ice:soft-disconnect", "replace-connection:failed"])
      owned()
      mesh.close()
    })

    it("rebuilds where recover() does when the ICE restart throws", async () => {
      const periods: Array<{ kind: string; lastAttempt?: string; attempts?: number }> = []
      const { mesh, pc, internals, conn, program, owned } = await dropped("disconnected", {
        onRtcEvent: (_peer: string, event: { kind: string; lastAttempt?: string; attempts?: number }) => periods.push(event),
      })
      internals.setAway("b", conn(), "timeout")
      pc.restartIce.mockImplementation(() => { throw new DOMException("closed", "InvalidStateError") })
      conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      expect(program()).toEqual(["restart-ice:soft-disconnect", "replace-connection:supervisor-recovery-restart-failed"])
      owned()
      mesh.close()
      expect(periods).toContainEqual(expect.objectContaining({
        kind: "away_period",
        lastAttempt: "rebuild",
        attempts: 1,
      }))
    })

    it("yields to the peer when its answer never came, then offers itself on a fresh connection", async () => {
      const { mesh, pc, internals, conn, signals, program, owned } = await driven()
      await pc.onnegotiationneeded!()
      state(pc, "connected")
      state(pc, "disconnected") // up once, the lane never opened
      conn().disconnectedAt = 0
      conn().offerSentAt = monoNow() - (SUPERVISOR_TIMING.answerWaitMs + 1)
      conn().lastSignalAt = monoNow()
      internals.supervise()
      expect(FakePC.last).toHaveLength(2)
      expect(FakePC.last[1]!.channels).toHaveLength(0) // responder-only
      expect(internals.runner!.state("b")!.yieldedAt).toBeGreaterThan(0)
      expect(program()).toEqual(["send-offer", "yield-responder", "replace-connection:answer-timeout-yield"])

      vi.advanceTimersByTime(SUPERVISOR_TIMING.answerWaitMs + 1)
      conn().lastSignalAt = monoNow()
      const before = descriptions(signals).length
      internals.supervise()
      await settle()
      expect(FakePC.last).toHaveLength(3)
      expect(FakePC.last[2]!.channels).toHaveLength(1)
      expect(descriptions(signals)).toHaveLength(before + 1)
      // the link has been down past AWAY_AFTER_MS by now: marked away first, as legacy's sweep does
      expect(program().slice(3)).toEqual(["mark-away", "replace-connection:stranded-yield-unanswered", "create-channel", "send-offer"])
      owned()
      mesh.close()
    })

    it("marks a link that stayed down away, and keeps healing it while it just dropped (#245)", async () => {
      const away = vi.fn()
      const { mesh, internals, conn, program, owned } = await (async () => {
        const made = await driven("a", "b", { onAway: away })
        openOwnChannel(made.pc)
        state(made.pc, "connected")
        state(made.pc, "disconnected")
        made.commands.length = 0
        return made
      })()
      conn().downAt = monoNow() - (SUPERVISOR_TIMING.awayAfterMs + 1)
      conn().disconnectedAt = conn().downAt
      conn().lastSignalAt = monoNow() - (SUPERVISOR_TIMING.presenceFreshMs + 1) // not heard, but the link just dropped
      internals.supervise()
      expect(away).toHaveBeenLastCalledWith("b", "timeout")
      expect(program()).toEqual(["mark-away", "restart-ice:soft-disconnect"])
      owned()
      mesh.close()
    })

    it("repairs a link on a network change: an ICE restart with the lane open, a rebuild without", async () => {
      const open = await dropped()
      open.mesh.networkChanged()
      expect(open.pc.restartIce).toHaveBeenCalledTimes(1)
      expect(open.program()).toEqual(["restart-ice:network-change"])
      open.owned()
      open.mesh.close()

      const closed = await driven()
      closed.mesh.networkChanged()
      expect(FakePC.last).toHaveLength(2)
      expect(closed.program()).toEqual(["replace-connection:network-change"])
      closed.owned()
      closed.mesh.close()
    })

    it("rebuilds once a round for a hard SDP error on the lane", async () => {
      const { mesh, pc, signals, program, owned } = await driven()
      mesh.setRound(1)
      await pc.onnegotiationneeded!()
      await mesh.onRtc("b", answer(sdp("222")))
      state(pc, "connected")
      const lane = openOwnChannel(pc)
      await pc.onnegotiationneeded!()
      vi.spyOn(pc, "setRemoteDescription").mockRejectedValueOnce(new DOMException("ssrc", "InvalidAccessError"))
      sendLane(lane, "Answer", sdp("222", { media: ["video"] }))
      await vi.waitFor(() => expect(FakePC.last).toHaveLength(2))
      expect(program()).toContain("replace-connection:hard-sdp-immediate")
      expect(signals.length).toBeGreaterThan(0)
      owned()
      mesh.close()
    })
  })

  describe("a new signalling session (the rejoin initiator)", () => {
    it("rebuilds the answerer as an offerer, as onPeerSession does: a channel only when its own offer went to the old session", async () => {
      for (const ourOffer of [true, false]) {
        const { mesh, pc, commands, owned } = await driven("b", "a")
        await mesh.onRtc("a", offer(sdp("111"), "A.1"))
        state(pc, "connected")
        if (ourOffer) pc.localDescription = { type: "offer", sdp: "v=0" } // our recovery offer, unanswered when the peer reloaded
        commands.length = 0
        mesh.onPeerSession("a")
        await settle()
        expect(FakePC.last.at(-1)).not.toBe(pc)
        expect(commands.filter((command) => command.kind === "replace-connection")).toEqual([
          expect.objectContaining({ cause: "signalling-session-rejoin", initiate: true }),
        ])
        expect(FakePC.last.at(-1)!.channels, String(ourOffer)).toHaveLength(ourOffer ? 1 : 0)
        owned()
        mesh.close()
      }
    })

    // Mesh keeps the answerer's leave to offer itself (the actor dropped its
    // copy, Q10): each recovery it runs for an actor command grants it, so an
    // asymmetric drop can heal from the answerer's side too
    it.each([
      ["restart-ice", "soft-disconnect"], // recover(): countRecoveryAttempt
      ["restart-ice", "media-stall"], // beginStallHeal
      ["restart-ice", "network-change"], // beginNetworkRepair
      ["replace-connection", "failed"], // recover()'s rebuild: countRecoveryAttempt
      ["replace-connection", "channel-never-opened"],
      ["replace-connection", "connected-no-video"],
      ["replace-connection", "media-stall"],
      ["replace-connection", "lane-glare-video"], // beginGlareRebuild
      ["replace-connection", "hard-sdp-immediate"], // beginNegotiationRebuild
      ["replace-connection", "network-change"],
      ["replace-connection", "stranded-yield-unanswered"], // beginStrandedInitiate
    ] as const)("grants the answerer its leave to offer on the actor's %s %s", async (kind, cause) => {
      const { mesh, pc, internals, conn } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      openTheirChannel(pc)
      state(pc, "connected")
      await settle()
      const leave = internals as unknown as { answererMayOffer: Set<string> }
      expect(leave.answererMayOffer.has("a")).toBe(false)
      const epoch = conn().decisionConnectionEpoch
      const command = kind === "restart-ice"
        ? { kind, cause, commandEpoch: 90, connectionEpoch: epoch }
        : { kind, cause, initiate: cause !== "stranded-yield-unanswered", commandEpoch: 90, connectionEpoch: epoch + 1 }
      internals.executePeerCommand("a", command as PeerActorCommand)
      expect(leave.answererMayOffer.has("a")).toBe(true)
      mesh.close()
    })

    it("follows the actor's leave to offer, decided from the fact, not an offer that lands before the command runs", async () => {
      const { mesh, pc, internals, commands, owned } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      state(pc, "connected")
      const execute = vi.mocked(internals.executePeerCommand).getMockImplementation()!
      vi.mocked(internals.executePeerCommand).mockImplementation((peer, command) => {
        // our offer is set between the fact (no local offer) and the rebuild
        if (command.kind === "replace-connection" && command.cause === "signalling-session-rejoin") pc.localDescription = { type: "offer", sdp: "v=0" }
        return execute(peer, command)
      })
      commands.length = 0
      mesh.onPeerSession("a")
      await settle()
      expect(commands.some((command) => command.kind === "replace-connection" && command.cause === "signalling-session-rejoin")).toBe(true)
      expect((internals as unknown as { answererMayOffer: Set<string> }).answererMayOffer.has("a")).toBe(false)
      expect(FakePC.last.at(-1)!.channels).toHaveLength(0)
      owned()
      mesh.close()
    })

    it("grants no leave to offer for a new signalling session when no offer of ours went to the old one", async () => {
      const { mesh, pc, internals, owned } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111"), "A.1"))
      state(pc, "connected")
      const leave = internals as unknown as { answererMayOffer: Set<string> }
      expect(leave.answererMayOffer.has("a")).toBe(false)
      mesh.onPeerSession("a")
      await settle()
      expect(leave.answererMayOffer.has("a")).toBe(false)
      expect(FakePC.last.at(-1)!.channels).toHaveLength(0)
      owned()
      mesh.close()
    })
  })

  describe("media", () => {
    it("rebuilds a connected link whose open channel brought no video, our camera off or not", async () => {
      const { mesh, pc, program, owned } = await driven()
      state(pc, "connected")
      await vi.advanceTimersByTimeAsync(8_000)
      openOwnChannel(pc)
      pc.stats = new Map() as never
      await vi.advanceTimersByTimeAsync(16_000)
      expect(FakePC.last).toHaveLength(2)
      expect(program()).toContain("replace-connection:connected-no-video")
      owned()
      mesh.close()
    })

    it("heals a stall with one ICE restart, then a rebuild (#1523 F5)", async () => {
      const { mesh, pc, program, owned } = await driven("a", "b", {}, camera)
      state(pc, "connected")
      frames(pc, 50)
      await vi.advanceTimersByTimeAsync(4_000) // frames seen
      await vi.advanceTimersByTimeAsync(60_000)
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(FakePC.last).toHaveLength(2)
      expect(program().filter((kind) => kind.startsWith("restart-ice") || kind.startsWith("replace-connection"))).toEqual([
        "restart-ice:media-stall",
        "replace-connection:media-stall",
      ])
      owned()
      mesh.close()
    })
  })

  describe("presence and the hidden page", () => {
    it("holds recovery while our page is hidden, and back in front asks for keyframes and sweeps every link once", async () => {
      const { mesh, pc, internals, conn, actor, program, owned } = await dropped()
      mesh.setSelfAway(true)
      expect(conn().pc.channels[0]!.send).toHaveBeenCalled() // the peer hears we are away
      conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      internals.supervise()
      expect(pc.restartIce).not.toHaveBeenCalled() // the actor holds in the background
      // backing off: a plain sweep would wait
      internals.runner!.add("b", { ...actor(), lastAttemptAt: monoNow(), budgets: { ...actor().budgets, failCount: 3 } })
      const supervise = vi.spyOn(internals, "supervise")
      mesh.setSelfAway(false, 20_000)
      expect(conn().healHoldUntil).toBeGreaterThan(monoNow()) // a keyframe is on its way
      expect(supervise).toHaveBeenCalledTimes(1)
      expect(pc.restartIce).toHaveBeenCalledTimes(1)
      expect(program()).toEqual(["request-keyframe", "sweep", "restart-ice:soft-disconnect"])
      owned()
      mesh.close()
    })
  })

  describe("lifecycle", () => {
    it("holds our camera back from a standby peer and puts it on again", async () => {
      const { mesh, internals, program, owned } = await driven()
      mesh.setStandby("b", true)
      expect(internals.conns.get("b")!.standby).toBe(true)
      mesh.setStandby("b", false)
      expect(internals.conns.get("b")!.standby).toBe(false)
      expect(program()).toEqual(["replace-video-track", "replace-video-track"])
      owned()
      mesh.close()
    })

    it("configures every link for a new ICE policy", async () => {
      const { mesh, pc, program, owned } = await driven()
      mesh.setIcePolicy("relay")
      expect(pc.setConfiguration).toHaveBeenCalledTimes(1)
      expect(pc.config?.iceTransportPolicy).toBe("relay")
      expect(program()).toEqual(["configure-ice"])
      owned()
      mesh.close()
    })

    it("closes a removed peer's connection, keeps the round's spent budgets for its return, and closes the room", async () => {
      const { mesh, pc, internals, program } = await driven()
      mesh.setRound(1)
      mesh.removePeer("b")
      expect(pc.close).toHaveBeenCalledTimes(1)
      expect(internals.conns.has("b")).toBe(false)
      mesh.addPeer("b")
      const fresh = FakePC.last[1]!
      expect(internals.runner!.state("b")!.connectionEpoch).toBe(internals.conns.get("b")!.decisionConnectionEpoch)
      mesh.close()
      expect(fresh.close).toHaveBeenCalledTimes(1)
      expect(program()).toEqual(["close-connection", "close-connection"])
    })

    it("forgets what it held for a removed peer's commands", async () => {
      const { mesh, pc, internals } = await driven("b", "a")
      const held = ["statementInbound", "laneInbound", "statementAnswering", "laneAnswering", "refusedOffers", "codecGuards"] as const
      const tables = internals as unknown as Record<(typeof held)[number], Map<string, unknown>>
      pc.iceGatheringState = "gathering" // the answer is still out when the peer leaves
      void mesh.onRtc("a", offer(sdp("111")))
      await settle()
      expect(tables.statementInbound.has("a")).toBe(true)
      tables.codecGuards.set("a", {})
      mesh.removePeer("a")
      for (const name of held) expect(tables[name].has("a"), name).toBe(false)
      mesh.close()
    })

    /** the connection-replaced-externally facts the runner was given */
    const externalReplaces = (internals: Internals) => {
      const seen: PeerActorEvent[] = []
      const dispatch = internals.runner!.dispatch.bind(internals.runner)
      vi.spyOn(internals.runner!, "dispatch").mockImplementation((peer, event) => {
        if (event.type === "connection-replaced-externally") seen.push(event)
        return dispatch(peer, event)
      })
      return seen
    }

    it("tells the actor of a connection Mesh replaced without it (the manual Reconnect), keeping the peer's budgets", async () => {
      const { mesh, conn, actor, internals, program } = await driven()
      const seen = externalReplaces(internals)
      const before = actor().connectionEpoch
      const spent = { ...actor(), budgets: { ...actor().budgets, failCount: 2, stallHeals: 1, noVideoRebuilds: 1 } }
      internals.runner!.add("b", spent)
      mesh.rebuildAll()
      expect(FakePC.last).toHaveLength(2)
      expect(seen).toEqual([expect.objectContaining({ connectionEpoch: before + 1 })])
      expect(actor().connectionEpoch).toBe(conn().decisionConnectionEpoch)
      // the peer's and the round's budgets stay; the connection's start over
      expect(actor().budgets).toMatchObject({ failCount: 2, noVideoRebuilds: 1, stallHeals: 0 })
      // the fresh connection is an attempt, timed by the fact's clock
      expect(actor().lastAttemptAt).toBe(seen[0]!.now)
      expect(program()).not.toContain("replace-connection")
      mesh.close()
    })

    it("moves an actor behind Mesh's connection to it (a peer-removed it could not take, then the peer back)", async () => {
      const { mesh, conn, actor, internals } = await driven()
      internals.runner!.add("b", { ...actor(), connectionEpoch: 0 }) // the actor missed a fact
      mesh.removePeer("b") // stale for the actor: it stays open
      mesh.addPeer("b")
      await settle()
      expect(actor().connectionEpoch).toBe(conn().decisionConnectionEpoch)
      mesh.close()
    })

    it("moves an actor ahead of Mesh's connection back to it (the manual Reconnect)", async () => {
      const { mesh, conn, actor, internals } = await driven()
      internals.runner!.add("b", { ...actor(), connectionEpoch: 7 })
      mesh.rebuildAll()
      await settle()
      expect(conn().decisionConnectionEpoch).toBe(2)
      expect(actor()).toMatchObject({ connectionEpoch: 2, link: "connecting" })
      mesh.close()
    })

    it("a replace issued after another connection moves the actor to Mesh's, timing the move as an attempt (design B, B2)", async () => {
      const { mesh, conn, actor, internals } = await driven()
      internals.runner!.add("b", { ...actor(), connectionEpoch: 5, lastAttemptAt: 5_000 })
      const result = internals.executePeerCommand("b", { kind: "replace-connection", cause: "failed", initiate: true, commandEpoch: 9, connectionEpoch: 6 })
      await settle()
      expect(result).toEqual({ outcome: "stale" })
      expect(FakePC.last).toHaveLength(1)
      expect(actor()).toMatchObject({ connectionEpoch: conn().decisionConnectionEpoch, lastAttemptAt: monoNow() })
      mesh.close()
    })

    it("tells the actor of the departed-session initiate, and offers on the fresh connection", async () => {
      const { mesh, pc, conn, actor, internals, signals } = await driven("b", "a")
      await mesh.onRtc("a", offer(sdp("111")))
      await settle()
      openTheirChannel(pc)
      state(pc, "connected")
      // the peer came back as a new connection: its first one has left
      await mesh.onRtc("a", offer(sdp("222")))
      await settle()
      mesh.removePeer("a")
      const seen = externalReplaces(internals)
      signals.length = 0
      // a late offer from the session that left is the first contact now
      await mesh.onRtc("a", offer(sdp("111")))
      await settle()
      expect(seen).toHaveLength(1)
      expect((internals as unknown as { answererMayOffer: Set<string> }).answererMayOffer.has("a")).toBe(true)
      expect(actor().connectionEpoch).toBe(conn().decisionConnectionEpoch)
      expect(descriptions(signals).map(({ type }) => type)).toEqual(["offer"])
      mesh.close()
    })
  })

  describe("the last legacy-owned paths (Step 4.3, PR 2)", () => {
    const say = (channel: FakeChannel, away: boolean) =>
      (channel.onmessage as (event: { data: unknown }) => void)({ data: encodeAway(away).buffer })

    it("tells the actor of a new signalling session on a connection that negotiated nothing, and the actor leaves it alone", async () => {
      const { mesh, internals, program, owned } = await driven("b", "a")
      const dispatch = vi.spyOn(internals.runner!, "dispatch")
      mesh.onPeerSession("a")
      expect(dispatch).toHaveBeenCalledWith("a", expect.objectContaining({ type: "peer-session-changed", negotiated: false }))
      expect(FakePC.last).toHaveLength(1)
      expect(program()).toEqual([])
      owned()
      mesh.close()
    })

    it("sweeps every link when a page never told it was away comes back: the actor's sweep clears the timeout mark, then one supervise", async () => {
      const away = vi.fn()
      const made = await driven("a", "b", { onAway: away })
      const { mesh, internals, conn, actor, commands, program, owned } = made
      openOwnChannel(made.pc)
      state(made.pc, "connected")
      state(made.pc, "disconnected")
      conn().downAt = monoNow() - (SUPERVISOR_TIMING.awayAfterMs + 1)
      conn().disconnectedAt = conn().downAt
      conn().lastSignalAt = monoNow()
      internals.supervise()
      expect(conn().away).toBe("timeout")
      commands.length = 0
      const supervise = vi.spyOn(internals, "supervise")
      mesh.setSelfAway(false, 20_000)
      expect(away).toHaveBeenLastCalledWith("b", null)
      expect(conn().away).toBeNull()
      expect(actor().budgets.failCount).toBe(1) // the sweep's own attempt, counted from the actor's forgiven budget
      expect(supervise).toHaveBeenCalledTimes(1)
      expect(program()).toEqual(["sweep", "restart-ice:soft-disconnect"])
      owned()
      mesh.close()
    })

    it("sweeps once when a page never told it was away comes back after a long absence (setSelfAway's kick)", async () => {
      const { mesh, internals, conn, program, owned } = await dropped()
      conn().disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
      const supervise = vi.spyOn(internals, "supervise")
      mesh.setSelfAway(false, 20_000)
      expect(supervise).toHaveBeenCalledTimes(1)
      expect(program()).toEqual(["sweep", "restart-ice:soft-disconnect"])
      owned()
      mesh.close()
    })

    it("still sweeps once after a long absence when no actor issued a sweep, as legacy always did (review B2)", async () => {
      const { mesh, internals, conn } = await dropped()
      conn().decisionConnectionEpoch += 1 // the actor is on another connection: it takes no fact of this one
      const supervise = vi.spyOn(internals, "supervise")
      mesh.setSelfAway(false, 20_000)
      expect(supervise).toHaveBeenCalledTimes(1)
      mesh.close()
    })

    it("clears a peer's away mark itself when the actor does not take the peer back (review B1)", async () => {
      const away = vi.fn()
      const made = await driven("a", "b", { onAway: away })
      const { mesh, conn } = made
      const channel = openOwnChannel(made.pc)
      state(made.pc, "connected")
      say(channel, true)
      expect(conn().away).toBe("said")
      conn().decisionConnectionEpoch += 1 // the actor is on another connection: it ignores the fact
      say(channel, false)
      expect(conn().away).toBeNull()
      expect(away).toHaveBeenLastCalledWith("b", null)
      mesh.close()
    })

    it("takes the peer back from its word: the actor's mark-back clears Mesh's away, holds the heal for its keyframe and times its return", async () => {
      const away = vi.fn()
      const made = await driven("a", "b", { onAway: away })
      const { mesh, conn, actor, internals, commands, program, owned } = made
      const channel = openOwnChannel(made.pc)
      state(made.pc, "connected")
      commands.length = 0
      say(channel, true)
      expect(conn().away).toBe("said")
      internals.runner!.add("b", { ...actor(), budgets: { ...actor().budgets, failCount: 2 } })
      say(channel, false)
      expect(away.mock.calls).toEqual([["b", "said"], ["b", null]])
      expect(conn().away).toBeNull()
      expect(actor().budgets.failCount).toBe(0)
      expect(conn().healHoldUntil).toBeGreaterThan(monoNow())
      expect(program()).toEqual(["mark-back"])
      owned()
      mesh.close()
    })

    it("clears a removed peer's away as part of the actor's close", async () => {
      const away = vi.fn()
      const made = await driven("a", "b", { onAway: away })
      const channel = openOwnChannel(made.pc)
      state(made.pc, "connected")
      say(channel, true)
      made.mesh.removePeer("b")
      expect(away).toHaveBeenLastCalledWith("b", null)
      made.mesh.close()
    })
  })
})
